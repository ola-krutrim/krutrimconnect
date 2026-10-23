import { randomUUID } from "node:crypto";

import {
  CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  CODEX_RESPONSES_TOOL_CONTRACT,
  type CapabilityProbeCheck,
  type CapabilityProbeResult,
  type ProbeOutcome,
} from "../capabilities/evidence.js";
import { ConfigurationError } from "../errors.js";
import { KRUTRIM_BASE_URL } from "../providers/krutrim.js";
import type { ProviderAdapter } from "../providers/types.js";
import { assertModelDoesNotExposeCredential } from "../security/model.js";
import { redactText } from "../security/redact.js";
import { KRUTRIM_CONNECT_VERSION } from "../version.js";
import { readBoundedSse, type SseEvent } from "./sse.js";

const INVALID_CONTROL_CREDENTIAL = "krutrim-connect-intentionally-invalid";
const PROBE_TOOL_NAME = "krutrim_connect_echo";
const NAMESPACE_TOOL_NAME = "krutrim_connect_namespace";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_REPLAY_BYTES = 64 * 1024;
const SAFE_EVENT_TYPES = new Set([
  "response.created",
  "response.output_item.added",
  "response.content_part.added",
  "response.output_text.delta",
  "response.output_text.done",
  "response.content_part.done",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.output_item.done",
  "response.completed",
  "response.failed",
  "response.incomplete",
  "error",
]);

type JsonRecord = Record<string, unknown>;

interface ParsedStream {
  events: JsonRecord[];
  eventTypes: string[];
}

interface FunctionCall {
  callId: string;
  name: string;
  arguments: string;
  replayItems: JsonRecord[];
}

class ProbeStageError extends Error {
  readonly outcome: Exclude<ProbeOutcome, "passed">;
  readonly httpStatus: number | undefined;

  constructor(
    outcome: Exclude<ProbeOutcome, "passed">,
    message: string,
    httpStatus?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProbeStageError";
    this.outcome = outcome;
    this.httpStatus = httpStatus;
  }
}

export interface KrutrimProbeOptions {
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

function notRun(detail: string): CapabilityProbeCheck {
  return { status: "not-run", detail };
}

function passed(detail: string, httpStatus?: number): CapabilityProbeCheck {
  const result: CapabilityProbeCheck = { status: "pass", detail };
  if (httpStatus !== undefined) {
    result.httpStatus = httpStatus;
  }
  return result;
}

function failed(error: ProbeStageError): CapabilityProbeCheck {
  const result: CapabilityProbeCheck = { status: "fail", detail: error.message };
  if (error.httpStatus !== undefined) {
    result.httpStatus = error.httpStatus;
  }
  return result;
}

function exactRoutes(provider: ProviderAdapter): { chat: string; responses: string } {
  if (provider.id !== "krutrim" || provider.baseUrl !== KRUTRIM_BASE_URL) {
    throw new ConfigurationError("The capability probe only permits the fixed Krutrim inference endpoint.");
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
  return {
    chat: "https://cloud.olakrutrim.com/v1/chat/completions",
    responses: "https://cloud.olakrutrim.com/v1/responses",
  };
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function safeErrorFields(response: Response, secrets: readonly string[]): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_ERROR_BYTES) {
        return "";
      }
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
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
      const value = redactText(String(error[key]), secrets)
        .replace(/[\p{Cc}]+/gu, " ")
        .slice(0, 120);
      allowed.push(`${key}=${value}`);
    }
  }
  return allowed.length > 0 ? ` (${allowed.join(", ")})` : "";
}

function statusError(status: number, context: string, safeFields: string): ProbeStageError {
  if (status >= 300 && status < 400) {
    return new ProbeStageError("failed", `${context} attempted an HTTP redirect; redirects were not followed.`, status);
  }
  if (status === 401 || status === 403) {
    return new ProbeStageError("inconclusive", `${context} rejected authentication${safeFields}.`, status);
  }
  if (status === 404 || status === 405 || status === 501) {
    return new ProbeStageError("failed", `${context} is absent or unusable${safeFields}.`, status);
  }
  if (status === 429 || status >= 500) {
    return new ProbeStageError("inconclusive", `${context} returned a transient service response${safeFields}.`, status);
  }
  return new ProbeStageError("failed", `${context} rejected the conformance request${safeFields}.`, status);
}

function activeModelStatusError(
  status: number,
  context: string,
  safeFields: string,
): ProbeStageError {
  if (status >= 300 && status < 400) {
    return new ProbeStageError("failed", `${context} attempted an HTTP redirect; redirects were not followed.`, status);
  }
  if (status === 401) {
    return new ProbeStageError(
      "inconclusive",
      `${context} rejected the credential after route authentication had passed${safeFields}.`,
      status,
    );
  }
  if (status === 403) {
    return new ProbeStageError(
      "inconclusive",
      `${context} may not be authorized for the requested model or model group${safeFields}.`,
      status,
    );
  }
  if (status === 404 || /(?:param=model|code=[^,)]*model)/iu.test(safeFields)) {
    return new ProbeStageError(
      "inconclusive",
      `${context} could not establish availability of the requested model${safeFields}.`,
      status,
    );
  }
  if (status === 429 || status >= 500) {
    return new ProbeStageError("inconclusive", `${context} returned a transient service response${safeFields}.`, status);
  }
  return new ProbeStageError("failed", `${context} rejected the active conformance request${safeFields}.`, status);
}

function codexMetadata(): JsonRecord {
  return {
    session_id: "krutrim-connect-probe",
    "x-codex-installation-id": "krutrim-connect-probe",
    "x-codex-window-id": "krutrim-connect-probe",
    thread_id: "krutrim-connect-probe",
    "x-codex-turn-metadata": "krutrim-connect-probe",
    turn_id: "krutrim-connect-probe",
  };
}

function probeFunction(nonce: string): JsonRecord {
  return {
    type: "function",
    name: PROBE_TOOL_NAME,
    description: "Return the exact nonce supplied by this conformance probe.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        nonce: { type: "string", enum: [nonce] },
      },
      required: ["nonce"],
      additionalProperties: false,
    },
  };
}

function representativeTools(nonce: string): JsonRecord[] {
  return [
    probeFunction(nonce),
    {
      type: "namespace",
      name: NAMESPACE_TOOL_NAME,
      description: "Representative Codex tool namespace accepted but never selected by the probe.",
      tools: [
        {
          type: "function",
          name: "echo",
          description: "Representative namespaced function.",
          strict: false,
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    },
    { type: "web_search", external_web_access: false },
  ];
}

function messages(developer: string, user: string): JsonRecord[] {
  return [
    {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: developer }],
    },
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: user }],
    },
  ];
}

function codexRequest(
  model: string,
  instructions: string,
  input: JsonRecord[],
  tools: JsonRecord[],
  toolChoice: unknown,
): JsonRecord {
  return {
    model,
    instructions,
    input,
    tools,
    tool_choice: toolChoice,
    parallel_tool_calls: false,
    reasoning: { summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "krutrim-connect-probe",
    client_metadata: codexMetadata(),
  };
}

function parseJsonEvents(events: SseEvent[]): ParsedStream {
  const parsed: JsonRecord[] = [];
  const eventTypes: string[] = [];
  for (const event of events) {
    if (event.data === "[DONE]") {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch (error) {
      throw new ProbeStageError("failed", "Responses SSE contained invalid JSON.", undefined, {
        cause: error,
      });
    }
    if (
      !isRecord(value) ||
      typeof value.type !== "string" ||
      value.type.length === 0 ||
      value.type.length > 200 ||
      /\p{Cc}/u.test(value.type)
    ) {
      throw new ProbeStageError("failed", "Responses SSE contained an event without a string type.");
    }
    if (
      ["item_id", "call_id", "delta", "text"].some(
        (field) => value[field] !== undefined && value[field] !== null && typeof value[field] !== "string",
      ) ||
      ["summary_index", "content_index"].some(
        (field) =>
          value[field] !== undefined &&
          value[field] !== null &&
          !Number.isSafeInteger(value[field]),
      )
    ) {
      throw new ProbeStageError("failed", "Responses SSE contained fields that Codex cannot deserialize.");
    }
    if (event.event !== undefined && event.event !== value.type) {
      throw new ProbeStageError("failed", "Responses SSE event and JSON type fields disagreed.");
    }
    parsed.push(value);
    eventTypes.push(SAFE_EVENT_TYPES.has(value.type) ? value.type : "other");
  }
  if (parsed.length === 0) {
    throw new ProbeStageError("failed", "Responses SSE did not contain typed events.");
  }
  const forbidden = parsed.find((event) =>
    event.type === "error" || event.type === "response.failed" || event.type === "response.incomplete"
  );
  if (forbidden) {
    throw new ProbeStageError("failed", `Responses SSE terminated with ${String(forbidden.type)}.`);
  }
  return { events: parsed, eventTypes };
}

function nonNegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validCompletedUsage(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (
    !isRecord(value) ||
    !nonNegativeInteger(value.input_tokens) ||
    !nonNegativeInteger(value.output_tokens) ||
    !nonNegativeInteger(value.total_tokens)
  ) {
    return false;
  }
  const inputDetails = value.input_tokens_details;
  if (
    inputDetails !== undefined &&
    inputDetails !== null &&
    (!isRecord(inputDetails) ||
      !nonNegativeInteger(inputDetails.cached_tokens) ||
      (inputDetails.cache_write_tokens !== undefined &&
        !nonNegativeInteger(inputDetails.cache_write_tokens)))
  ) {
    return false;
  }
  const outputDetails = value.output_tokens_details;
  return !(
    outputDetails !== undefined &&
    outputDetails !== null &&
    (!isRecord(outputDetails) || !nonNegativeInteger(outputDetails.reasoning_tokens))
  );
}

function validInternalMetadata(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (isRecord(value) &&
      (value.turn_id === undefined || value.turn_id === null || typeof value.turn_id === "string"))
  );
}

function validMessageContent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "input_text" || value.type === "output_text") {
    return typeof value.text === "string";
  }
  if (value.type === "input_audio") {
    return typeof value.audio_url === "string";
  }
  if (value.type === "input_image") {
    return (
      typeof value.image_url === "string" &&
      (value.detail === undefined ||
        value.detail === null ||
        value.detail === "auto" ||
        value.detail === "low" ||
        value.detail === "high" ||
        value.detail === "original")
    );
  }
  return false;
}

function validCodexMessageItem(item: JsonRecord): boolean {
  return (
    typeof item.id === "string" &&
    typeof item.role === "string" &&
    Array.isArray(item.content) &&
    item.content.every(validMessageContent) &&
    (item.phase === undefined ||
      item.phase === null ||
      item.phase === "commentary" ||
      item.phase === "final_answer") &&
    validInternalMetadata(item.internal_chat_message_metadata_passthrough)
  );
}

function assertLifecycle(events: JsonRecord[], expectedModel: string): void {
  const created = events.filter((event) => event.type === "response.created");
  const completed = events.filter((event) => event.type === "response.completed");
  if (created.length !== 1 || completed.length !== 1) {
    throw new ProbeStageError(
      "failed",
      "Responses SSE did not contain exactly one response.created and one response.completed event.",
    );
  }
  const createdIndex = events.indexOf(created[0]!);
  const completedIndex = events.indexOf(completed[0]!);
  if (createdIndex !== 0 || completedIndex !== events.length - 1) {
    throw new ProbeStageError("failed", "Responses SSE lifecycle events were not ordered or terminal.");
  }
  const createdResponse = created[0]?.response;
  const completedResponse = completed[0]?.response;
  if (
    !isRecord(createdResponse) ||
    typeof createdResponse.id !== "string" ||
    createdResponse.id.length === 0 ||
    createdResponse.model !== expectedModel ||
    !isRecord(completedResponse) ||
    completedResponse.id !== createdResponse.id ||
    completedResponse.model !== expectedModel ||
    completedResponse.status !== "completed" ||
    !validCompletedUsage(completedResponse.usage) ||
    (completedResponse.end_turn !== undefined &&
      completedResponse.end_turn !== null &&
      typeof completedResponse.end_turn !== "boolean")
  ) {
    throw new ProbeStageError("failed", "Responses SSE did not finish with a completed response object.");
  }
}

function codexReasoningReplayItem(item: JsonRecord): JsonRecord {
  if (item.type !== "reasoning" || !Array.isArray(item.summary)) {
    throw new ProbeStageError("failed", "Reasoning output item was not parseable by Codex.");
  }
  const summary = item.summary.map((part) => {
    if (!isRecord(part) || part.type !== "summary_text" || typeof part.text !== "string") {
      throw new ProbeStageError("failed", "Reasoning summary item was not parseable by Codex.");
    }
    return { type: "summary_text", text: part.text };
  });
  let content: JsonRecord[] | undefined;
  if (item.content !== undefined && item.content !== null) {
    if (!Array.isArray(item.content)) {
      throw new ProbeStageError("failed", "Reasoning content was not parseable by Codex.");
    }
    const parsedContent = item.content.map((part) => {
      if (
        !isRecord(part) ||
        !(part.type === "reasoning_text" || part.type === "text") ||
        typeof part.text !== "string"
      ) {
        throw new ProbeStageError("failed", "Reasoning content item was not parseable by Codex.");
      }
      return { type: part.type, text: part.text };
    });
    // Codex deliberately omits a Text-only reasoning content array when it
    // serializes history; it retains the array only when reasoning_text exists.
    content = parsedContent.some((part) => part.type === "reasoning_text")
      ? parsedContent
      : undefined;
  }
  if (
    item.id !== undefined &&
    item.id !== null &&
    typeof item.id !== "string"
  ) {
    throw new ProbeStageError("failed", "Reasoning output id was not parseable by Codex.");
  }
  if (
    item.encrypted_content !== undefined &&
    item.encrypted_content !== null &&
    typeof item.encrypted_content !== "string"
  ) {
    throw new ProbeStageError("failed", "Encrypted reasoning content was not parseable by Codex.");
  }
  const metadata = item.internal_chat_message_metadata_passthrough;
  if (!validInternalMetadata(metadata)) {
    throw new ProbeStageError("failed", "Reasoning metadata was not parseable by Codex.");
  }
  return {
    type: "reasoning",
    ...(typeof item.id === "string" ? { id: item.id } : {}),
    summary,
    ...(content === undefined ? {} : { content }),
    encrypted_content:
      typeof item.encrypted_content === "string" ? item.encrypted_content : null,
    ...(isRecord(metadata)
      ? {
          internal_chat_message_metadata_passthrough: {
            ...(typeof metadata.turn_id === "string" ? { turn_id: metadata.turn_id } : {}),
          },
        }
      : {}),
  };
}

function assertTextStream(
  stream: ParsedStream,
  expectedModel: string,
  expectedMarker?: string,
): void {
  assertLifecycle(stream.events, expectedModel);
  const added = stream.events.filter(
    (event) => event.type === "response.output_item.added" && isRecord(event.item) && event.item.type === "message",
  );
  const done = stream.events.filter(
    (event) => event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "message",
  );
  const deltas = stream.events.filter(
    (event) => event.type === "response.output_text.delta" && typeof event.delta === "string",
  );
  if (added.length !== 1 || done.length !== 1 || deltas.length === 0) {
    throw new ProbeStageError(
      "failed",
      "Responses text stream lacked the canonical item-added, text-delta, or item-done sequence.",
    );
  }
  const addedEvent = added[0]!;
  const doneEvent = done[0]!;
  const addedItem = addedEvent.item as JsonRecord;
  const doneItem = doneEvent.item as JsonRecord;
  const itemId = addedItem.id;
  const outputIndex = addedEvent.output_index;
  if (
    typeof itemId !== "string" ||
    itemId.length === 0 ||
    !Number.isInteger(outputIndex) ||
    addedItem.role !== "assistant" ||
    doneItem.id !== itemId ||
    doneItem.role !== "assistant" ||
    doneItem.status !== "completed" ||
    doneEvent.output_index !== outputIndex
  ) {
    throw new ProbeStageError("failed", "Responses text stream did not provide a stable output item id.");
  }
  if (
    deltas.some(
      (event) =>
        event.item_id !== itemId ||
        event.output_index !== outputIndex ||
        !Number.isInteger(event.content_index),
    )
  ) {
    throw new ProbeStageError("failed", "Responses text deltas did not use stable item and content indexes.");
  }
  const text = deltas.map((event) => String(event.delta)).join("");
  const doneText = Array.isArray(doneItem.content)
    ? doneItem.content
        .filter((content): content is JsonRecord => isRecord(content) && content.type === "output_text")
        .map((content) => (typeof content.text === "string" ? content.text : ""))
        .join("")
    : "";
  const addedIndex = stream.events.indexOf(addedEvent);
  const firstDeltaIndex = stream.events.indexOf(deltas[0]!);
  const doneIndex = stream.events.indexOf(doneEvent);
  if (!validCodexMessageItem(addedItem) || !validCodexMessageItem(doneItem)) {
    throw new ProbeStageError("failed", "Responses message items were not parseable by Codex.");
  }
  if (!(addedIndex < firstDeltaIndex && firstDeltaIndex < doneIndex)) {
    throw new ProbeStageError("failed", "Responses text events were not in canonical stream order.");
  }
  if (text.length === 0 || doneText.length === 0 || text !== doneText) {
    throw new ProbeStageError("failed", "Responses text deltas and the completed message were empty or inconsistent.");
  }
  if (
    expectedMarker !== undefined &&
    (!text.includes(expectedMarker) || !doneText.includes(expectedMarker))
  ) {
    throw new ProbeStageError(
      "failed",
      "The tool-result continuation did not incorporate the synthetic function output.",
    );
  }
}

function extractFunctionCall(
  stream: ParsedStream,
  nonce: string,
  expectedModel: string,
): FunctionCall {
  assertLifecycle(stream.events, expectedModel);
  const allAddedCalls = stream.events.filter(
    (event) =>
      event.type === "response.output_item.added" &&
      isRecord(event.item) &&
      event.item.type === "function_call",
  );
  const allDoneCalls = stream.events.filter(
    (event) =>
      event.type === "response.output_item.done" &&
      isRecord(event.item) &&
      event.item.type === "function_call",
  );
  const deltas = stream.events.filter(
    (event) => event.type === "response.function_call_arguments.delta" && typeof event.delta === "string",
  );
  const argumentsDone = stream.events.filter(
    (event) =>
      event.type === "response.function_call_arguments.done" && typeof event.arguments === "string",
  );
  const unexpectedDoneItem = stream.events.find(
    (event) =>
      event.type === "response.output_item.done" &&
      (!isRecord(event.item) ||
        !(event.item.type === "reasoning" || event.item.type === "function_call")),
  );
  if (
    allAddedCalls.length !== 1 ||
    allDoneCalls.length !== 1 ||
    deltas.length === 0 ||
    argumentsDone.length !== 1 ||
    unexpectedDoneItem !== undefined
  ) {
    throw new ProbeStageError(
      "failed",
      "Tool stream lacked exactly one function item and streamed argument delta/done events.",
    );
  }
  const addedEvent = allAddedCalls[0]!;
  const doneEvent = allDoneCalls[0]!;
  const argumentsDoneEvent = argumentsDone[0]!;
  const addedItem = addedEvent.item as JsonRecord;
  const doneItem = doneEvent.item as JsonRecord;
  const itemId = addedItem.id;
  const callId = doneItem.call_id;
  const args = doneItem.arguments;
  const outputIndex = addedEvent.output_index;
  if (
    typeof itemId !== "string" ||
    addedItem.name !== PROBE_TOOL_NAME ||
    addedItem.arguments !== "" ||
    (addedItem.namespace !== undefined && addedItem.namespace !== null) ||
    doneItem.name !== PROBE_TOOL_NAME ||
    (doneItem.namespace !== undefined && doneItem.namespace !== null) ||
    doneItem.id !== itemId ||
    typeof callId !== "string" ||
    callId.length === 0 ||
    addedItem.call_id !== callId ||
    typeof args !== "string" ||
    args.length > 4_096 ||
    !Number.isInteger(outputIndex) ||
    doneEvent.output_index !== outputIndex ||
    doneItem.status !== "completed" ||
    !validInternalMetadata(addedItem.internal_chat_message_metadata_passthrough) ||
    !validInternalMetadata(doneItem.internal_chat_message_metadata_passthrough) ||
    deltas.some((event) => event.item_id !== itemId || event.output_index !== outputIndex) ||
    argumentsDoneEvent.item_id !== itemId ||
    argumentsDoneEvent.output_index !== outputIndex ||
    argumentsDoneEvent.arguments !== args ||
    deltas.map((event) => String(event.delta)).join("") !== args
  ) {
    throw new ProbeStageError("failed", "Tool stream used inconsistent item ids, call ids, or arguments.");
  }
  let parsedArguments: unknown;
  try {
    parsedArguments = JSON.parse(args) as unknown;
  } catch (error) {
    throw new ProbeStageError("failed", "Tool call arguments were not valid JSON.", undefined, {
      cause: error,
    });
  }
  if (!isRecord(parsedArguments) || parsedArguments.nonce !== nonce) {
    throw new ProbeStageError("failed", "Tool call arguments did not contain the fixed probe nonce.");
  }
  const addedIndex = stream.events.indexOf(addedEvent);
  const argumentsDoneIndex = stream.events.indexOf(argumentsDoneEvent);
  const doneIndex = stream.events.indexOf(doneEvent);
  const everyDeltaOrdered = deltas.every((event) => {
    const index = stream.events.indexOf(event);
    return index > addedIndex && index < argumentsDoneIndex;
  });
  if (
    !everyDeltaOrdered ||
    !(addedIndex < argumentsDoneIndex && argumentsDoneIndex < doneIndex)
  ) {
    throw new ProbeStageError("failed", "Tool stream did not preserve the canonical item sequence.");
  }
  const replayItems: JsonRecord[] = [];
  for (const event of stream.events) {
    if (event.type !== "response.output_item.done" || !isRecord(event.item)) {
      continue;
    }
    if (event.item.type === "reasoning") {
      replayItems.push(codexReasoningReplayItem(event.item));
    } else if (event === doneEvent) {
      replayItems.push({
        type: "function_call",
        name: PROBE_TOOL_NAME,
        arguments: args,
        call_id: callId,
      });
    }
  }
  if (replayItems.filter((item) => item.type === "function_call").length !== 1) {
    throw new ProbeStageError("failed", "Tool stream did not yield one Codex-replayable function call.");
  }
  if (Buffer.byteLength(JSON.stringify(replayItems), "utf8") > MAX_REPLAY_BYTES) {
    throw new ProbeStageError("failed", "Responses reasoning and function replay exceeded the safety limit.");
  }
  return { callId, name: PROBE_TOOL_NAME, arguments: args, replayItems };
}

async function parseStreamResponse(
  response: Response,
  context: string,
  secrets: readonly string[],
): Promise<ParsedStream> {
  if (response.status !== 200) {
    const fields = await safeErrorFields(response, secrets);
    throw activeModelStatusError(response.status, context, fields);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    await cancelBody(response);
    throw new ProbeStageError("failed", `${context} did not return text/event-stream.`, response.status);
  }
  try {
    return parseJsonEvents(await readBoundedSse(response));
  } catch (error) {
    if (error instanceof ProbeStageError) {
      throw error;
    }
    throw new ProbeStageError("failed", `${context} returned an invalid or oversized SSE stream.`, response.status, {
      cause: error,
    });
  }
}

export async function runKrutrimCodexProbe(
  options: KrutrimProbeOptions,
): Promise<CapabilityProbeResult> {
  const routes = exactRoutes(options.provider);
  const resolvedModel = options.provider.resolveModel(options.model).id;
  if (options.apiKey.length === 0) {
    throw new ConfigurationError("No Krutrim API key is available for the authenticated probe.");
  }
  assertModelDoesNotExposeCredential(resolvedModel, options.apiKey);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const nonceFactory = options.nonceFactory ?? randomUUID;
  const startedAt = now().toISOString();
  let requestCount = 0;
  const observedEventTypes = new Set<string>();
  const checks: CapabilityProbeResult["checks"] = {
    authentication: notRun("Authentication control was not run."),
    responsesApi: notRun("Responses API probe was not run."),
    streaming: notRun("Responses streaming probe was not run."),
    toolCalling: notRun("Tool-calling probe was not run."),
    codexCanary: notRun("Full Codex canary was not run."),
  };

  const post = async (route: string, credential: string, body: JsonRecord): Promise<Response> => {
    requestCount += 1;
    try {
      return await fetchImpl(route, {
        method: "POST",
        redirect: "manual",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
          "User-Agent": `krutrimconnect/${KRUTRIM_CONNECT_VERSION}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ProbeStageError("inconclusive", "The Krutrim probe request failed or timed out.", undefined, {
        cause: error,
      });
    }
  };

  const finish = (outcome: ProbeOutcome): CapabilityProbeResult => ({
    schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    contract: CODEX_RESPONSES_TOOL_CONTRACT,
    providerId: options.provider.id,
    baseUrl: options.provider.baseUrl,
    model: resolvedModel,
    outcome,
    startedAt,
    completedAt: now().toISOString(),
    checks,
    observations: {
      requestCount,
      eventTypes: [...observedEventTypes].sort(),
    },
  });

  try {
    const invalidChat = await post(routes.chat, INVALID_CONTROL_CREDENTIAL, {});
    const invalidChatStatus = invalidChat.status;
    await cancelBody(invalidChat);
    if (!(invalidChatStatus === 401 || invalidChatStatus === 403)) {
      throw new ProbeStageError(
        invalidChatStatus >= 300 && invalidChatStatus < 400 ? "failed" : "inconclusive",
        "The invalid-credential Chat Completions control did not produce an authentication rejection.",
        invalidChatStatus,
      );
    }
    const validChat = await post(routes.chat, options.apiKey, {});
    const validChatStatus = validChat.status;
    await cancelBody(validChat);
    if (!(validChatStatus === 400 || validChatStatus === 422)) {
      throw statusError(validChatStatus, "Krutrim Chat Completions authentication control", "");
    }
    checks.authentication = passed("Supplied credential passed the sequential invalid-token control (value hidden).", validChatStatus);
  } catch (error) {
    const stage = error instanceof ProbeStageError
      ? error
      : new ProbeStageError("inconclusive", "Authentication control failed unexpectedly.", undefined, { cause: error });
    checks.authentication = failed(stage);
    return finish(stage.outcome);
  }

  try {
    const invalidResponses = await post(routes.responses, INVALID_CONTROL_CREDENTIAL, {});
    const invalidStatus = invalidResponses.status;
    await cancelBody(invalidResponses);
    if (invalidStatus === 404 || invalidStatus === 405 || invalidStatus === 501) {
      throw new ProbeStageError("failed", "Krutrim /v1/responses is absent or unusable.", invalidStatus);
    }
    if (!(invalidStatus === 401 || invalidStatus === 403)) {
      throw new ProbeStageError(
        invalidStatus >= 300 && invalidStatus < 400 ? "failed" : "inconclusive",
        "The invalid-credential Responses control did not produce an authentication rejection.",
        invalidStatus,
      );
    }
    const validResponses = await post(routes.responses, options.apiKey, {});
    const validStatus = validResponses.status;
    await cancelBody(validResponses);
    if (!(validStatus === 400 || validStatus === 422)) {
      throw statusError(validStatus, "Krutrim Responses route control", "");
    }
  } catch (error) {
    const stage = error instanceof ProbeStageError
      ? error
      : new ProbeStageError("inconclusive", "Responses route control failed unexpectedly.", undefined, { cause: error });
    checks.responsesApi = failed(stage);
    return finish(stage.outcome);
  }

  const textMarker = `KRUTRIM_CONNECT_TEXT_${nonceFactory()}`;
  try {
    const textInput = messages(
      `Reply with exactly ${textMarker}. Do not call a tool.`,
      `Return ${textMarker}.`,
    );
    const response = await post(
      routes.responses,
      options.apiKey,
      codexRequest(resolvedModel, `Return exactly ${textMarker}.`, textInput, [], "none"),
    );
    const stream = await parseStreamResponse(response, "Krutrim Responses text probe", [options.apiKey]);
    stream.eventTypes.forEach((type) => observedEventTypes.add(type));
    assertTextStream(stream, resolvedModel);
    checks.responsesApi = passed("Authenticated model returned a canonical Responses object stream.", response.status);
  } catch (error) {
    const stage = error instanceof ProbeStageError
      ? error
      : new ProbeStageError("inconclusive", "Responses text probe failed unexpectedly.", undefined, { cause: error });
    checks.responsesApi = failed(stage);
    return finish(stage.outcome);
  }

  const toolNonce = nonceFactory();
  const tools = representativeTools(toolNonce);
  const initialMessages = messages(
    `Call ${PROBE_TOOL_NAME} exactly once with nonce ${toolNonce}.`,
    `Use ${PROBE_TOOL_NAME}; do not answer directly.`,
  );
  let call: FunctionCall;
  try {
    const response = await post(
      routes.responses,
      options.apiKey,
      codexRequest(
        resolvedModel,
        `Call ${PROBE_TOOL_NAME} exactly once.`,
        initialMessages,
        tools,
        "auto",
      ),
    );
    const stream = await parseStreamResponse(response, "Krutrim streamed tool-call probe", [options.apiKey]);
    stream.eventTypes.forEach((type) => observedEventTypes.add(type));
    call = extractFunctionCall(stream, toolNonce, resolvedModel);
    checks.streaming = passed(
      "Canonical text SSE and streamed function-argument deltas were observed.",
      response.status,
    );
  } catch (error) {
    const stage = error instanceof ProbeStageError
      ? error
      : new ProbeStageError("inconclusive", "Streamed tool-call probe failed unexpectedly.", undefined, { cause: error });
    checks.streaming = failed(stage);
    checks.toolCalling = failed(stage);
    return finish(stage.outcome);
  }

  const resultMarker = `KRUTRIM_CONNECT_TOOL_RESULT_${nonceFactory()}`;
  try {
    const continuationInput: JsonRecord[] = [
      ...initialMessages,
      ...call.replayItems,
      {
        type: "function_call_output",
        call_id: call.callId,
        output: resultMarker,
      },
    ];
    const response = await post(
      routes.responses,
      options.apiKey,
      codexRequest(
        resolvedModel,
        "The function_call_output is authoritative. Reply with its exact text and do not call another tool.",
        continuationInput,
        tools,
        "auto",
      ),
    );
    const stream = await parseStreamResponse(
      response,
      "Krutrim tool-result continuation probe",
      [options.apiKey],
    );
    stream.eventTypes.forEach((type) => observedEventTypes.add(type));
    assertTextStream(stream, resolvedModel, resultMarker);
    checks.toolCalling = passed(
      "Function call_id correlation and function_call_output continuation completed successfully.",
      response.status,
    );
  } catch (error) {
    const stage = error instanceof ProbeStageError
      ? error
      : new ProbeStageError("inconclusive", "Tool-result continuation probe failed unexpectedly.", undefined, {
          cause: error,
        });
    checks.toolCalling = failed(stage);
    return finish(stage.outcome);
  }

  return finish("passed");
}
