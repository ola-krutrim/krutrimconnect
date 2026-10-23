import { ConfigurationError, InferenceError } from "../errors.js";
import { consumeBoundedSse } from "../probes/sse.js";
import { KRUTRIM_BASE_URL, krutrimProvider } from "../providers/krutrim.js";
import { assertModelDoesNotExposeCredential } from "../security/model.js";

const KRUTRIM_CHAT_COMPLETIONS_URL =
  "https://cloud.olakrutrim.com/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export interface ChatCompletionUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface KrutrimChatCompletion {
  model: string;
  text: string;
  finishReason?: string;
  usage?: ChatCompletionUsage;
  streamed: boolean;
}

export interface KrutrimChatOptions {
  model: string;
  prompt: string;
  apiKey: string;
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  onDelta?: (delta: string) => void;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertFixedEndpoint(): void {
  const base = new URL(KRUTRIM_BASE_URL);
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

function validateOptions(options: KrutrimChatOptions): { model: string; prompt: string } {
  if (options.apiKey.length === 0) {
    throw new ConfigurationError("A non-empty stored Krutrim API key is required.");
  }
  const model = krutrimProvider.resolveModel(options.model).id;
  assertModelDoesNotExposeCredential(model, options.apiKey);
  if (options.prompt.trim().length === 0) {
    throw new ConfigurationError("A non-empty prompt is required.");
  }
  if (Buffer.byteLength(options.prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new ConfigurationError(`The prompt exceeds ${MAX_PROMPT_BYTES} UTF-8 bytes.`);
  }
  if (
    options.maxTokens !== undefined &&
    (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)
  ) {
    throw new ConfigurationError("maxTokens must be a positive integer.");
  }
  if (
    options.temperature !== undefined &&
    (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)
  ) {
    throw new ConfigurationError("temperature must be between 0 and 2.");
  }
  return { model, prompt: options.prompt };
}

function usageFrom(value: unknown): ChatCompletionUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage: ChatCompletionUsage = {};
  if (typeof value.prompt_tokens === "number" && Number.isFinite(value.prompt_tokens)) {
    usage.promptTokens = value.prompt_tokens;
  }
  if (typeof value.completion_tokens === "number" && Number.isFinite(value.completion_tokens)) {
    usage.completionTokens = value.completion_tokens;
  }
  if (typeof value.total_tokens === "number" && Number.isFinite(value.total_tokens)) {
    usage.totalTokens = value.total_tokens;
  }
  return Object.keys(usage).length === 0 ? undefined : usage;
}

function firstChoice(value: unknown): JsonRecord | undefined {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    return undefined;
  }
  return value.choices[0];
}

function finishReasonFrom(choice: JsonRecord | undefined): string | undefined {
  return typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) {
    throw new InferenceError("Krutrim returned an empty response body.");
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
      if (total > MAX_JSON_BYTES) {
        throw new InferenceError(`Krutrim response exceeded ${MAX_JSON_BYTES} bytes.`);
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
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    throw new InferenceError("Krutrim returned malformed JSON.", { cause: error });
  }
}

function safeHttpError(response: Response): InferenceError {
  if (response.status >= 300 && response.status < 400) {
    return new InferenceError(
      `Krutrim attempted an HTTP redirect (${response.status}); redirects were not followed.`,
    );
  }
  return new InferenceError(`Krutrim inference failed with HTTP ${response.status}.`);
}

async function parseJsonCompletion(
  response: Response,
  requestedModel: string,
): Promise<KrutrimChatCompletion> {
  const parsed = await boundedJson(response);
  const choice = firstChoice(parsed);
  const message = isRecord(choice?.message) ? choice.message : undefined;
  if (typeof message?.content !== "string") {
    throw new InferenceError("Krutrim response did not contain assistant text.");
  }
  const reportedModel = isRecord(parsed) && typeof parsed.model === "string"
    ? parsed.model
    : requestedModel;
  const result: KrutrimChatCompletion = {
    model: reportedModel,
    text: message.content,
    streamed: false,
  };
  const finishReason = finishReasonFrom(choice);
  const usage = isRecord(parsed) ? usageFrom(parsed.usage) : undefined;
  if (finishReason !== undefined) {
    result.finishReason = finishReason;
  }
  if (usage !== undefined) {
    result.usage = usage;
  }
  return result;
}

async function parseStreamCompletion(
  response: Response,
  requestedModel: string,
  onDelta?: (delta: string) => void,
): Promise<KrutrimChatCompletion> {
  let text = "";
  let finishReason: string | undefined;
  let reportedModel = requestedModel;
  let usage: ChatCompletionUsage | undefined;
  let done = false;

  await consumeBoundedSse(
    response,
    (event) => {
      if (event.data === "[DONE]") {
        done = true;
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data) as unknown;
      } catch (error) {
        throw new InferenceError("Krutrim returned malformed streaming JSON.", { cause: error });
      }
      if (!isRecord(parsed)) {
        throw new InferenceError("Krutrim returned a non-object streaming event.");
      }
      if (typeof parsed.model === "string") {
        reportedModel = parsed.model;
      }
      const choice = firstChoice(parsed);
      const delta = isRecord(choice?.delta) ? choice.delta : undefined;
      if (typeof delta?.content === "string") {
        text += delta.content;
        onDelta?.(delta.content);
      }
      finishReason = finishReasonFrom(choice) ?? finishReason;
      usage = usageFrom(parsed.usage) ?? usage;
    },
    { maxTotalBytes: 2 * 1024 * 1024, maxEventBytes: 64 * 1024, maxEvents: 2048 },
  );

  if (!done) {
    throw new InferenceError("Krutrim streaming response ended without the [DONE] marker.");
  }
  if (text.length === 0) {
    throw new InferenceError("Krutrim streaming response did not contain assistant text.");
  }
  const result: KrutrimChatCompletion = { model: reportedModel, text, streamed: true };
  if (finishReason !== undefined) {
    result.finishReason = finishReason;
  }
  if (usage !== undefined) {
    result.usage = usage;
  }
  return result;
}

export async function runKrutrimChatCompletion(
  options: KrutrimChatOptions,
): Promise<KrutrimChatCompletion> {
  assertFixedEndpoint();
  const { model, prompt } = validateOptions(options);
  const stream = options.stream ?? true;
  const body: JsonRecord = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream,
  };
  if (options.maxTokens !== undefined) {
    body.max_tokens = options.maxTokens;
  }
  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(KRUTRIM_CHAT_COMPLETIONS_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new InferenceError("Krutrim inference request failed before a response was received.", {
      cause: error,
    });
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw safeHttpError(response);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (stream) {
    if (!contentType.startsWith("text/event-stream")) {
      await response.body?.cancel().catch(() => undefined);
      throw new InferenceError("Krutrim streaming response was not text/event-stream.");
    }
    return await parseStreamCompletion(response, model, options.onDelta);
  }
  if (!contentType.includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new InferenceError("Krutrim response was not JSON.");
  }
  return await parseJsonCompletion(response, model);
}
