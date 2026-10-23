import { randomUUID } from "node:crypto";

import {
  BRIDGE_EVIDENCE_SCHEMA_VERSION,
  CHAT_BRIDGE_FEASIBILITY_CONTRACT,
  type BridgeProbeCheck,
  type BridgeProbeOutcome,
  type BridgeProbeResult,
} from "../bridge/evidence.js";
import { normalizeChatToolArguments } from "../bridge/tool-arguments.js";
import { ConfigurationError } from "../errors.js";
import { KRUTRIM_BASE_URL } from "../providers/krutrim.js";
import type { ProviderAdapter } from "../providers/types.js";
import { assertModelDoesNotExposeCredential } from "../security/model.js";
import { redactText } from "../security/redact.js";
import { KRUTRIM_CONNECT_VERSION } from "../version.js";
import { readBoundedSse } from "./sse.js";

const INVALID_CONTROL_CREDENTIAL = "krutrim-connect-intentionally-invalid";
const PROBE_TOOL_NAME = "krutrim_connect_echo";
const CHAT_COMPLETIONS_URL = "https://cloud.olakrutrim.com/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_ARGUMENT_BYTES = 4_096;

type JsonRecord = Record<string, unknown>;

interface ChatToolCall {
  callId: string;
  name: string;
  arguments: string;
}

interface StreamedToolCall extends ChatToolCall {
  eventCount: number;
  argumentDeltaCount: number;
}

class BridgeProbeStageError extends Error {
  readonly outcome: "failed" | "inconclusive";
  readonly httpStatus: number | undefined;

  constructor(
    outcome: "failed" | "inconclusive",
    message: string,
    httpStatus?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BridgeProbeStageError";
    this.outcome = outcome;
    this.httpStatus = httpStatus;
  }
}

export interface KrutrimChatBridgeProbeOptions {
  provider: ProviderAdapter;
  model: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  nonceFactory?: () => string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function notRun(detail: string): BridgeProbeCheck {
  return { status: "not-run", detail };
}

function passed(detail: string, httpStatus?: number): BridgeProbeCheck {
  return {
    status: "pass",
    detail,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function failed(error: BridgeProbeStageError): BridgeProbeCheck {
  return {
    status: error.outcome === "inconclusive" ? "inconclusive" : "fail",
    detail: error.message,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
  };
}

function assertFixedEndpoint(provider: ProviderAdapter): void {
  if (provider.id !== "krutrim" || provider.baseUrl !== KRUTRIM_BASE_URL) {
    throw new ConfigurationError("The bridge probe only permits the fixed Krutrim inference endpoint.");
  }
  const base = new URL(provider.baseUrl);
  if (
    base.protocol !== "https:" ||
    base.origin !== "https://cloud.olakrutrim.com" ||
    base.pathname !== "/v1" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new ConfigurationError("The Krutrim inference endpoint failed the fixed-origin safety check.");
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) {
    throw new BridgeProbeStageError("failed", "Krutrim returned an empty response body.", response.status);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      total += chunk.value.byteLength;
      if (total > limit) {
        throw new BridgeProbeStageError("failed", "Krutrim returned an oversized JSON response.", response.status);
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await boundedBytes(response, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new BridgeProbeStageError(
      "failed",
      "Krutrim returned malformed Chat Completions JSON.",
      response.status,
      { cause: error },
    );
  }
}

async function safeErrorFields(response: Response, secrets: readonly string[]): Promise<string> {
  if (response.body === null) {
    return "";
  }
  let bytes: Uint8Array;
  try {
    bytes = await boundedBytes(response, MAX_ERROR_BYTES);
  } catch {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return "";
  }
  const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : undefined;
  if (!error) {
    return "";
  }
  const allowed: string[] = [];
  for (const key of ["type", "code", "param"]) {
    if (typeof error[key] === "string") {
      const value = redactText(error[key], secrets)
        .replace(/[\p{Cc}]+/gu, " ")
        .slice(0, 120);
      allowed.push(`${key}=${value}`);
    }
  }
  return allowed.length === 0 ? "" : ` (${allowed.join(", ")})`;
}

function routeStatusError(status: number, context: string, safeFields: string): BridgeProbeStageError {
  if (status >= 300 && status < 400) {
    return new BridgeProbeStageError("failed", `${context} attempted an HTTP redirect; redirects were not followed.`, status);
  }
  if (status === 401 || status === 403) {
    return new BridgeProbeStageError("inconclusive", `${context} rejected authentication${safeFields}.`, status);
  }
  if (status === 404 || status === 405 || status === 501) {
    return new BridgeProbeStageError("failed", `${context} is absent or unusable${safeFields}.`, status);
  }
  if (status === 429 || status >= 500) {
    return new BridgeProbeStageError("inconclusive", `${context} returned a transient service response${safeFields}.`, status);
  }
  return new BridgeProbeStageError("failed", `${context} rejected the bridge-feasibility request${safeFields}.`, status);
}

function activeModelStatusError(status: number, context: string, safeFields: string): BridgeProbeStageError {
  if (status === 403) {
    return new BridgeProbeStageError(
      "inconclusive",
      `${context} may not be authorized for the requested model or model group${safeFields}.`,
      status,
    );
  }
  if (status === 404 || /(?:param=model|code=[^,)]*model)/iu.test(safeFields)) {
    return new BridgeProbeStageError(
      "inconclusive",
      `${context} could not establish availability of the requested model${safeFields}.`,
      status,
    );
  }
  return routeStatusError(status, context, safeFields);
}

function probeTool(nonce: string): JsonRecord {
  return {
    type: "function",
    function: {
      name: PROBE_TOOL_NAME,
      description: "Return the exact nonce supplied by this bridge-feasibility probe.",
      strict: false,
      parameters: {
        type: "object",
        properties: { nonce: { type: "string", enum: [nonce] } },
        required: ["nonce"],
        additionalProperties: false,
      },
    },
  };
}

function initialMessages(nonce: string): JsonRecord[] {
  const exactArguments = JSON.stringify({ nonce });
  return [
    {
      role: "system",
      content: `Follow the requested function-call protocol exactly. Do not invent or transform argument values.`,
    },
    {
      role: "user",
      content:
        `Call ${PROBE_TOOL_NAME} exactly once with arguments ${exactArguments}. ` +
        "Do not answer directly. After receiving its tool result, reply with the exact tool content and do not call another tool.",
    },
  ];
}

function toolRequest(model: string, nonce: string, stream: boolean): JsonRecord {
  return {
    model,
    messages: initialMessages(nonce),
    tools: [probeTool(nonce)],
    tool_choice: { type: "function", function: { name: PROBE_TOOL_NAME } },
    parallel_tool_calls: false,
    temperature: 0,
    stream,
    max_tokens: 512,
  };
}

function normalizeAndAssertNonceArguments(argumentsJson: string, nonce: string): string {
  if (Buffer.byteLength(argumentsJson, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new BridgeProbeStageError("failed", "Chat tool-call arguments exceeded the safety limit.");
  }
  let normalized: string;
  let parsed: unknown;
  try {
    normalized = normalizeChatToolArguments(argumentsJson, PROBE_TOOL_NAME);
    parsed = JSON.parse(normalized) as unknown;
  } catch (error) {
    throw new BridgeProbeStageError("failed", "Chat tool-call arguments could not be normalized to valid JSON.", undefined, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || parsed.nonce !== nonce) {
    throw new BridgeProbeStageError("failed", "Chat tool-call arguments did not contain the fixed probe nonce.");
  }
  return normalized;
}

function firstChoice(value: unknown): JsonRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    return undefined;
  }
  return value.choices[0];
}

async function requireJsonResponse(
  response: Response,
  context: string,
  secrets: readonly string[],
): Promise<unknown> {
  if (response.status !== 200) {
    const fields = await safeErrorFields(response, secrets);
    throw activeModelStatusError(response.status, context, fields);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    await cancelBody(response);
    throw new BridgeProbeStageError("failed", `${context} did not return application/json.`, response.status);
  }
  return await boundedJson(response);
}

async function parseNonStreamingToolCall(
  response: Response,
  nonce: string,
  context: string,
  secrets: readonly string[],
): Promise<ChatToolCall> {
  const parsed = await requireJsonResponse(response, context, secrets);
  const choice = firstChoice(parsed);
  const message = isRecord(choice?.message) ? choice.message : undefined;
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (message?.role !== "assistant" || calls.length !== 1 || !isRecord(calls[0])) {
    throw new BridgeProbeStageError(
      "failed",
      "Non-streaming Chat Completions did not return exactly one assistant tool call.",
      response.status,
    );
  }
  const call = calls[0];
  const fn = isRecord(call.function) ? call.function : undefined;
  if (
    typeof call.id !== "string" ||
    call.id.length === 0 ||
    call.id.length > 512 ||
    call.type !== "function" ||
    fn?.name !== PROBE_TOOL_NAME ||
    typeof fn.arguments !== "string"
  ) {
    throw new BridgeProbeStageError(
      "failed",
      "Non-streaming Chat Completions returned an invalid tool-call shape.",
      response.status,
    );
  }
  const normalizedArguments = normalizeAndAssertNonceArguments(fn.arguments, nonce);
  return { callId: call.id, name: PROBE_TOOL_NAME, arguments: normalizedArguments };
}

function mergeToolName(current: string, fragment: string): string {
  if (fragment.length === 0 || fragment === current) {
    return current;
  }
  if (current.length === 0) {
    return fragment;
  }
  const combined = `${current}${fragment}`;
  if (PROBE_TOOL_NAME.startsWith(combined)) {
    return combined;
  }
  if (fragment === PROBE_TOOL_NAME) {
    return fragment;
  }
  throw new BridgeProbeStageError("failed", "Streamed Chat tool-call name fragments were inconsistent.");
}

async function parseStreamingToolCall(
  response: Response,
  nonce: string,
  context: string,
  secrets: readonly string[],
): Promise<StreamedToolCall> {
  if (response.status !== 200) {
    const fields = await safeErrorFields(response, secrets);
    throw activeModelStatusError(response.status, context, fields);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    await cancelBody(response);
    throw new BridgeProbeStageError("failed", `${context} did not return text/event-stream.`, response.status);
  }
  let events;
  try {
    events = await readBoundedSse(response);
  } catch (error) {
    throw new BridgeProbeStageError("failed", `${context} returned an invalid or oversized SSE stream.`, response.status, {
      cause: error,
    });
  }
  let done = false;
  let callId = "";
  let name = "";
  let argumentsJson = "";
  let argumentDeltaCount = 0;
  const callIndexes = new Set<number>();
  for (const event of events) {
    if (event.data === "[DONE]") {
      done = true;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data) as unknown;
    } catch (error) {
      throw new BridgeProbeStageError("failed", "Chat Completions SSE contained invalid JSON.", response.status, {
        cause: error,
      });
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.choices)) {
      throw new BridgeProbeStageError("failed", "Chat Completions SSE contained an invalid chunk object.", response.status);
    }
    for (const rawChoice of parsed.choices) {
      if (!isRecord(rawChoice)) {
        throw new BridgeProbeStageError("failed", "Chat Completions SSE contained an invalid choice.", response.status);
      }
      const delta = isRecord(rawChoice.delta) ? rawChoice.delta : undefined;
      if (delta?.tool_calls === undefined) {
        continue;
      }
      if (!Array.isArray(delta.tool_calls)) {
        throw new BridgeProbeStageError("failed", "Chat Completions SSE tool_calls was not an array.", response.status);
      }
      for (const rawFragment of delta.tool_calls) {
        if (!isRecord(rawFragment) || !Number.isSafeInteger(rawFragment.index)) {
          throw new BridgeProbeStageError("failed", "Chat Completions SSE contained an invalid tool-call index.", response.status);
        }
        const index = rawFragment.index as number;
        callIndexes.add(index);
        if (typeof rawFragment.id === "string" && rawFragment.id.length > 0) {
          if (callId.length > 0 && callId !== rawFragment.id) {
            throw new BridgeProbeStageError("failed", "Streamed Chat tool-call IDs were inconsistent.", response.status);
          }
          callId = rawFragment.id;
        }
        if (rawFragment.type !== undefined && rawFragment.type !== null && rawFragment.type !== "function") {
          throw new BridgeProbeStageError("failed", "Streamed Chat tool-call type was not function.", response.status);
        }
        if (rawFragment.function !== undefined && !isRecord(rawFragment.function)) {
          throw new BridgeProbeStageError("failed", "Streamed Chat tool-call function was invalid.", response.status);
        }
        const fn = isRecord(rawFragment.function) ? rawFragment.function : undefined;
        if (typeof fn?.name === "string") {
          name = mergeToolName(name, fn.name);
        }
        if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
          argumentsJson += fn.arguments;
          argumentDeltaCount += 1;
          if (Buffer.byteLength(argumentsJson, "utf8") > MAX_ARGUMENT_BYTES) {
            throw new BridgeProbeStageError("failed", "Streamed Chat tool arguments exceeded the safety limit.", response.status);
          }
        }
      }
    }
  }
  if (!done) {
    throw new BridgeProbeStageError("failed", "Chat Completions SSE ended without the [DONE] marker.", response.status);
  }
  if (
    callIndexes.size !== 1 ||
    !callIndexes.has(0) ||
    callId.length === 0 ||
    callId.length > 512 ||
    name !== PROBE_TOOL_NAME ||
    argumentDeltaCount === 0
  ) {
    throw new BridgeProbeStageError(
      "failed",
      "Streamed Chat Completions lacked exactly one stable function call and argument delta.",
      response.status,
    );
  }
  const normalizedArguments = normalizeAndAssertNonceArguments(argumentsJson, nonce);
  return {
    callId,
    name,
    arguments: normalizedArguments,
    eventCount: events.length,
    argumentDeltaCount,
  };
}

async function assertContinuation(
  response: Response,
  marker: string,
  secrets: readonly string[],
): Promise<void> {
  const parsed = await requireJsonResponse(response, "Krutrim Chat tool-result continuation probe", secrets);
  const choice = firstChoice(parsed);
  const message = isRecord(choice?.message) ? choice.message : undefined;
  if (message?.role !== "assistant" || typeof message.content !== "string" || !message.content.includes(marker)) {
    throw new BridgeProbeStageError(
      "failed",
      "Chat tool-result continuation did not incorporate the synthetic function output.",
      response.status,
    );
  }
}

export async function runKrutrimChatBridgeProbe(
  options: KrutrimChatBridgeProbeOptions,
): Promise<BridgeProbeResult> {
  assertFixedEndpoint(options.provider);
  const model = options.provider.resolveModel(options.model).id;
  if (options.apiKey.length === 0) {
    throw new ConfigurationError("No Krutrim API key is available for the bridge probe.");
  }
  assertModelDoesNotExposeCredential(model, options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? randomUUID;
  const startedAt = now().toISOString();
  let requestCount = 0;
  let streamEventCount = 0;
  let argumentDeltaCount = 0;
  const checks: BridgeProbeResult["checks"] = {
    authentication: notRun("Authentication control was not run."),
    nonStreamingToolCalling: notRun("Non-streaming tool-call probe was not run."),
    streamingToolCalling: notRun("Streaming tool-call probe was not run."),
    toolContinuation: notRun("Tool-result continuation probe was not run."),
    codexCanary: notRun("The full Codex canary is run only by the stored bridge qualification flow."),
  };

  const post = async (credential: string, body: JsonRecord, stream = false): Promise<Response> => {
    requestCount += 1;
    try {
      return await fetchImpl(CHAT_COMPLETIONS_URL, {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: stream ? "text/event-stream" : "application/json",
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          "User-Agent": `krutrimconnect/${KRUTRIM_CONNECT_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new BridgeProbeStageError("inconclusive", "The Krutrim bridge probe request failed or timed out.", undefined, {
        cause: error,
      });
    }
  };

  const finish = (outcome: BridgeProbeOutcome): BridgeProbeResult => ({
    schemaVersion: BRIDGE_EVIDENCE_SCHEMA_VERSION,
    contract: CHAT_BRIDGE_FEASIBILITY_CONTRACT,
    providerId: options.provider.id,
    baseUrl: options.provider.baseUrl,
    model,
    outcome,
    startedAt,
    completedAt: now().toISOString(),
    checks,
    observations: { requestCount, streamEventCount, argumentDeltaCount },
  });

  try {
    const invalid = await post(INVALID_CONTROL_CREDENTIAL, {});
    const invalidStatus = invalid.status;
    await cancelBody(invalid);
    if (!(invalidStatus === 401 || invalidStatus === 403)) {
      throw new BridgeProbeStageError(
        invalidStatus >= 300 && invalidStatus < 400 ? "failed" : "inconclusive",
        "The invalid-credential Chat Completions control did not produce an authentication rejection.",
        invalidStatus,
      );
    }
    const valid = await post(options.apiKey, {});
    const validStatus = valid.status;
    await cancelBody(valid);
    if (!(validStatus === 400 || validStatus === 422)) {
      throw routeStatusError(validStatus, "Krutrim Chat Completions authentication control", "");
    }
    checks.authentication = passed(
      "Supplied credential passed the sequential invalid-token control (value hidden).",
      validStatus,
    );
  } catch (error) {
    const stage = error instanceof BridgeProbeStageError
      ? error
      : new BridgeProbeStageError("inconclusive", "Authentication control failed unexpectedly.", undefined, { cause: error });
    checks.authentication = failed(stage);
    return finish(stage.outcome);
  }

  const toolNonce = nonceFactory();
  let call: ChatToolCall;
  try {
    const response = await post(options.apiKey, toolRequest(model, toolNonce, false));
    call = await parseNonStreamingToolCall(
      response,
      toolNonce,
      "Krutrim non-streaming Chat tool-call probe",
      [options.apiKey],
    );
    checks.nonStreamingToolCalling = passed(
      "Chat Completions returned one correlated function call with valid JSON arguments.",
      response.status,
    );
  } catch (error) {
    const stage = error instanceof BridgeProbeStageError
      ? error
      : new BridgeProbeStageError("inconclusive", "Non-streaming tool-call probe failed unexpectedly.", undefined, {
          cause: error,
        });
    checks.nonStreamingToolCalling = failed(stage);
    return finish(stage.outcome);
  }

  const streamNonce = nonceFactory();
  try {
    const response = await post(options.apiKey, toolRequest(model, streamNonce, true), true);
    const streamed = await parseStreamingToolCall(
      response,
      streamNonce,
      "Krutrim streaming Chat tool-call probe",
      [options.apiKey],
    );
    streamEventCount = streamed.eventCount;
    argumentDeltaCount = streamed.argumentDeltaCount;
    checks.streamingToolCalling = passed(
      "Chat Completions returned streamed function-call argument deltas.",
      response.status,
    );
  } catch (error) {
    const stage = error instanceof BridgeProbeStageError
      ? error
      : new BridgeProbeStageError("inconclusive", "Streaming tool-call probe failed unexpectedly.", undefined, {
          cause: error,
        });
    checks.streamingToolCalling = failed(stage);
  }

  const resultMarker = `KRUTRIM_CONNECT_CHAT_TOOL_RESULT_${nonceFactory()}`;
  try {
    const continuationBody: JsonRecord = {
      model,
      messages: [
        ...initialMessages(toolNonce),
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: call.callId,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        },
        { role: "tool", tool_call_id: call.callId, content: resultMarker },
      ],
      tools: [probeTool(toolNonce)],
      tool_choice: "none",
      parallel_tool_calls: false,
      temperature: 0,
      stream: false,
      max_tokens: 512,
    };
    const response = await post(options.apiKey, continuationBody);
    await assertContinuation(response, resultMarker, [options.apiKey]);
    checks.toolContinuation = passed(
      "Chat tool_call_id correlation and tool-result continuation completed successfully.",
      response.status,
    );
  } catch (error) {
    const stage = error instanceof BridgeProbeStageError
      ? error
      : new BridgeProbeStageError("inconclusive", "Tool-result continuation probe failed unexpectedly.", undefined, {
          cause: error,
        });
    checks.toolContinuation = failed(stage);
    return finish(stage.outcome);
  }

  return finish(
    checks.streamingToolCalling.status === "pass"
      ? "streaming-compatible"
      : "buffered-compatible",
  );
}
