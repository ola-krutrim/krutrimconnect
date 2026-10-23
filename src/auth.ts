import { ConfigurationError } from "./errors.js";
import { KRUTRIM_BASE_URL } from "./providers/krutrim.js";

export const MAX_STDIN_API_KEY_BYTES = 4098;
export const KRUTRIM_CREDENTIAL_VALIDATION_METHOD =
  "authenticated-model-catalogue-v1" as const;
export const KRUTRIM_MODELS_URL = `${KRUTRIM_BASE_URL}/models`;
export const KRUTRIM_MODEL_REGISTRY_URL =
  "https://cloud.olakrutrim.com/artifact_registry/v1/model_catalogue";

const INVALID_CONTROL_CREDENTIAL = "krutrim-connect-intentionally-invalid";
const MAX_MODELS_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_VALIDATION_TIMEOUT_MS = 15_000;

export interface PassedCredentialValidation {
  status: "validated";
  method: typeof KRUTRIM_CREDENTIAL_VALIDATION_METHOD;
  endpoint: typeof KRUTRIM_MODELS_URL;
  validatedAt: string;
}

export interface SkippedCredentialValidation {
  status: "skipped";
}

export type CredentialValidation =
  | PassedCredentialValidation
  | SkippedCredentialValidation;

export type CredentialValidationDescription =
  | CredentialValidation
  | { status: "not-performed" | "invalid" };

export interface KrutrimCredentialValidationOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export type ApiKeyInputSource = "environment" | "prompt" | "stdin";

export interface ApiKeyInputSelection {
  fromEnv: boolean;
  stdin: boolean;
  inputIsTTY: boolean;
}

export function selectApiKeyInputSource(
  selection: ApiKeyInputSelection,
): ApiKeyInputSource {
  if (selection.fromEnv && selection.stdin) {
    throw new ConfigurationError("Choose only one credential input: --from-env or --stdin.");
  }
  if (selection.fromEnv) {
    return "environment";
  }
  if (selection.stdin) {
    if (selection.inputIsTTY) {
      throw new ConfigurationError(
        "login --stdin requires piped input; use masked interactive login instead.",
      );
    }
    return "stdin";
  }
  if (!selection.inputIsTTY) {
    throw new ConfigurationError(
      "Interactive login requires a terminal. Use --from-env or pipe the key to login --stdin.",
    );
  }
  return "prompt";
}

export async function readApiKeyInput(
  input: AsyncIterable<unknown>,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    let bytes: Buffer;
    if (typeof chunk === "string") {
      bytes = Buffer.from(chunk);
    } else if (Buffer.isBuffer(chunk)) {
      bytes = chunk;
    } else if (ArrayBuffer.isView(chunk)) {
      bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    } else {
      throw new ConfigurationError("Credential input contains an unsupported data chunk.");
    }
    total += bytes.length;
    if (total > MAX_STDIN_API_KEY_BYTES) {
      throw new ConfigurationError(
        `Credential input exceeds ${MAX_STDIN_API_KEY_BYTES} bytes.`,
      );
    }
    chunks.push(bytes);
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new ConfigurationError("Credential input is not valid UTF-8.", { cause: error });
  }
  return decoded.replace(/\r?\n$/u, "");
}

function assertFixedModelsEndpoint(): void {
  const endpoint = new URL(KRUTRIM_MODELS_URL);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== "https://cloud.olakrutrim.com" ||
    endpoint.pathname !== "/v1/models" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ConfigurationError(
      "The Krutrim model-catalogue endpoint failed the fixed-origin safety check.",
    );
  }
}

function assertFixedRegistryEndpoint(): void {
  const endpoint = new URL(KRUTRIM_MODEL_REGISTRY_URL);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== "https://cloud.olakrutrim.com" ||
    endpoint.pathname !== "/artifact_registry/v1/model_catalogue" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ConfigurationError(
      "The Krutrim model-registry endpoint failed the fixed-origin safety check.",
    );
  }
}

async function requestModelCatalogue(
  credential: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  assertFixedModelsEndpoint();
  try {
    return await fetchImpl(KRUTRIM_MODELS_URL, {
      method: "GET",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ConfigurationError(
      "Could not reach Krutrim's authenticated model catalogue.",
    );
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConfigurationError(
      "Krutrim's authenticated model catalogue did not return JSON.",
    );
  }
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > MAX_MODELS_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConfigurationError(
      "Krutrim's authenticated model-catalogue response exceeded the safe size limit.",
    );
  }
  if (response.body === null) {
    throw new ConfigurationError(
      "Krutrim's authenticated model catalogue returned an empty response.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_MODELS_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ConfigurationError(
          "Krutrim's authenticated model-catalogue response exceeded the safe size limit.",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const source = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigurationError(
      "Krutrim's authenticated model catalogue returned invalid JSON.",
      { cause: error },
    );
  }
}

function modelEntries(body: unknown): unknown[] {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as Record<string, unknown>).object !== "list" ||
    !Array.isArray((body as Record<string, unknown>).data)
  ) {
    throw new ConfigurationError(
      "Krutrim's authenticated model catalogue returned an unexpected response shape.",
    );
  }
  return [...((body as Record<string, unknown>).data as unknown[])];
}

export async function fetchKrutrimModelCatalogue(
  apiKey: string,
  options: Omit<KrutrimCredentialValidationOptions, "now"> = {},
): Promise<unknown[]> {
  const response = await requestModelCatalogue(
    apiKey,
    options.fetchImpl ?? fetch,
    options.timeoutMs ?? 30_000,
  );
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConfigurationError(
      `Krutrim's authenticated model catalogue rejected the request (HTTP ${response.status}).`,
    );
  }
  return modelEntries(await boundedJson(response));
}

export async function fetchKrutrimModelRegistry(
  apiKey: string,
  options: Omit<KrutrimCredentialValidationOptions, "now"> = {},
): Promise<unknown[]> {
  assertFixedRegistryEndpoint();
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(KRUTRIM_MODEL_REGISTRY_URL, {
      method: "GET",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch {
    throw new ConfigurationError("Could not reach Krutrim's model registry.");
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConfigurationError(
      `Krutrim's model registry rejected the request (HTTP ${response.status}).`,
    );
  }
  const body = await boundedJson(response);
  if (!Array.isArray(body)) {
    throw new ConfigurationError(
      "Krutrim's model registry returned an unexpected response shape.",
    );
  }
  return [...body];
}

export async function validateKrutrimApiKey(
  apiKey: string,
  options: KrutrimCredentialValidationOptions = {},
): Promise<PassedCredentialValidation> {
  if (
    apiKey.length === 0 ||
    apiKey !== apiKey.trim() ||
    apiKey.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(apiKey)
  ) {
    throw new ConfigurationError(
      "The supplied API key has an invalid format. No credential was stored.",
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  const invalidControl = await requestModelCatalogue(
    INVALID_CONTROL_CREDENTIAL,
    fetchImpl,
    timeoutMs,
  );
  const invalidStatus = invalidControl.status;
  await invalidControl.body?.cancel().catch(() => undefined);
  if (invalidStatus !== 401 && invalidStatus !== 403) {
    throw new ConfigurationError(
      `Krutrim credential validation could not establish the invalid-token control (HTTP ${invalidStatus}). No credential was stored.`,
    );
  }

  const candidate = await requestModelCatalogue(apiKey, fetchImpl, timeoutMs);
  if (candidate.status === 401 || candidate.status === 403) {
    await candidate.body?.cancel().catch(() => undefined);
    throw new ConfigurationError(
      "Krutrim rejected the API key. It may be invalid, expired, or revoked. Your existing saved credential was not changed.",
    );
  }
  if (candidate.status !== 200) {
    const status = candidate.status;
    await candidate.body?.cancel().catch(() => undefined);
    throw new ConfigurationError(
      `Krutrim could not validate the supplied API key (HTTP ${status}). The existing credential was not changed.`,
    );
  }
  modelEntries(await boundedJson(candidate));
  const validatedAt = (options.now ?? (() => new Date()))().toISOString();
  return {
    status: "validated",
    method: KRUTRIM_CREDENTIAL_VALIDATION_METHOD,
    endpoint: KRUTRIM_MODELS_URL,
    validatedAt,
  };
}
