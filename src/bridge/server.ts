import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ConfigurationError } from "../errors.js";
import { KRUTRIM_BASE_URL } from "../providers/krutrim.js";
import {
  translateChatCompletionStream,
  type ChatStreamObservation,
} from "./stream.js";
import { isJsonRecord, translateResponsesRequest, type JsonRecord } from "./translate.js";

const CHAT_COMPLETIONS_URL = `${KRUTRIM_BASE_URL}/chat/completions`;
export const BRIDGE_RUNTIME_CONTRACT = "responses-chat-v2-model-list";
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_UPSTREAM_ERROR_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000;

function assertFixedUpstream(): void {
  const target = new URL(CHAT_COMPLETIONS_URL);
  if (
    target.protocol !== "https:" ||
    target.origin !== "https://cloud.olakrutrim.com" ||
    target.pathname !== "/v1/chat/completions" ||
    target.username !== "" ||
    target.password !== "" ||
    target.search !== "" ||
    target.hash !== ""
  ) {
    throw new ConfigurationError("The bridge upstream failed the fixed-origin safety check.");
  }
}

export interface BridgeServerOptions {
  model: string;
  instanceId: string;
  controlToken: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  host?: string;
  port?: number;
  onShutdown?: () => void;
  activationCommitted?: () => boolean;
  onResponsesRequest?: (body: unknown) => void;
  onResponsesError?: (message: string) => void;
  onChatStreamObservation?: (observation: ChatStreamObservation) => void;
}

export interface StartedBridgeServer {
  server: Server;
  host: string;
  port: number;
  close(): Promise<void>;
}

export function deriveBridgeBearer(apiKey: string, instanceId: string): string {
  return createHmac("sha256", apiKey)
    .update("krutrim-connect-local-bridge-v1\0")
    .update(instanceId)
    .digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function jsonResponse(response: ServerResponse, status: number, body: JsonRecord): void {
  if (response.headersSent) {
    return;
  }
  const source = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(source),
    "Cache-Control": "no-store",
  });
  response.end(source);
}

function safeError(response: ServerResponse, status: number, message: string): void {
  jsonResponse(response, status, {
    error: { type: "krutrim_connect_bridge_error", message },
  });
}

function diagnosticToken(value: unknown): string | undefined {
  if (value === null) {
    return "none";
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,80}$/u.test(value)) {
    return value;
  }
  return undefined;
}

async function upstreamErrorMetadata(response: Response): Promise<string> {
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    await response.body?.cancel().catch(() => undefined);
    return "";
  }
  if (response.body === null) {
    return "";
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
      if (total > MAX_UPSTREAM_ERROR_BYTES) {
        await reader.cancel().catch(() => undefined);
        return "";
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return "";
  }
  const error = isJsonRecord(parsed) && isJsonRecord(parsed.error) ? parsed.error : undefined;
  if (error === undefined) {
    return "";
  }
  const fields = [
    ["type", diagnosticToken(error.type)],
    ["code", diagnosticToken(error.code)],
    ["param", diagnosticToken(error.param)],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  return fields.length === 0 ? "" : `,${fields.join(",")}`;
}

async function readBoundedJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES) {
      throw new ConfigurationError(`Responses request exceeded ${MAX_REQUEST_BYTES} bytes.`);
    }
    chunks.push(bytes);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } catch (error) {
    throw new ConfigurationError("Responses request body is not valid UTF-8 JSON.", { cause: error });
  }
}

function bearer(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
}

function requireExactChatModel(body: unknown, expectedModel: string): JsonRecord {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ConfigurationError("Chat Completions request body must be an object.");
  }
  const request = body as JsonRecord;
  if (request.model !== expectedModel) {
    throw new ConfigurationError("Chat Completions request model is not the bridge's bound model.");
  }
  return request;
}

async function pipeResponseBody(upstream: Response, response: ServerResponse): Promise<void> {
  if (upstream.body === null) {
    throw new ConfigurationError("Krutrim returned an empty Chat Completions response body.");
  }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      if (!response.write(next.value)) {
        await once(response, "drain");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function handleChatCompletions(
  request: IncomingMessage,
  response: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const expectedBearer = deriveBridgeBearer(options.apiKey, options.instanceId);
  const suppliedBearer = bearer(request);
  if (suppliedBearer === undefined || !safeEqual(suppliedBearer, expectedBearer)) {
    safeError(response, 401, "Local bridge authentication failed.");
    return;
  }
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    safeError(response, 415, "Chat Completions requests must use application/json.");
    return;
  }
  const body = requireExactChatModel(await readBoundedJson(request), options.model);
  const stream = body.stream === true;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  timeout.unref();
  response.once("close", () => {
    if (!response.writableEnded) {
      abort.abort();
    }
  });

  let upstream: Response;
  try {
    upstream = await (options.fetchImpl ?? fetch)(CHAT_COMPLETIONS_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw new ConfigurationError("Krutrim Chat Completions request failed before a response arrived.", {
      cause: error,
    });
  }
  if (upstream.status !== 200) {
    clearTimeout(timeout);
    await upstream.body?.cancel().catch(() => undefined);
    safeError(response, upstream.status >= 500 ? 502 : upstream.status, `Krutrim rejected the Chat Completions request (HTTP ${upstream.status}).`);
    return;
  }
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  const expectedContentType = stream ? "text/event-stream" : "application/json";
  if (!contentType.startsWith(expectedContentType)) {
    clearTimeout(timeout);
    await upstream.body?.cancel().catch(() => undefined);
    safeError(response, 502, `Krutrim did not return the expected ${expectedContentType} response.`);
    return;
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-store",
    "X-Accel-Buffering": "no",
  });
  try {
    await pipeResponseBody(upstream, response);
  } finally {
    clearTimeout(timeout);
    response.end();
  }
}

function writeSse(response: ServerResponse, event: string, data: JsonRecord): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleResponses(
  request: IncomingMessage,
  response: ServerResponse,
  options: BridgeServerOptions,
): Promise<void> {
  const expectedBearer = deriveBridgeBearer(options.apiKey, options.instanceId);
  const suppliedBearer = bearer(request);
  if (suppliedBearer === undefined || !safeEqual(suppliedBearer, expectedBearer)) {
    safeError(response, 401, "Local bridge authentication failed.");
    return;
  }
  if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    safeError(response, 415, "Responses requests must use application/json.");
    return;
  }

  const body = await readBoundedJson(request);
  options.onResponsesRequest?.(body);
  const translated = translateResponsesRequest(body, options.model);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
  timeout.unref();
  response.once("close", () => {
    if (!response.writableEnded) {
      abort.abort();
    }
  });

  let upstream: Response;
  try {
    upstream = await (options.fetchImpl ?? fetch)(CHAT_COMPLETIONS_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(translated.chatBody),
      signal: abort.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw new ConfigurationError("Krutrim Chat Completions request failed before a response arrived.", {
      cause: error,
    });
  }
  if (upstream.status !== 200) {
    clearTimeout(timeout);
    const metadata = await upstreamErrorMetadata(upstream);
    options.onResponsesError?.(
      `Krutrim rejected the bridged request (HTTP ${upstream.status}${metadata}).`,
    );
    safeError(response, upstream.status >= 500 ? 502 : upstream.status, `Krutrim rejected the bridged request (HTTP ${upstream.status}).`);
    return;
  }
  const contentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    clearTimeout(timeout);
    await upstream.body?.cancel().catch(() => undefined);
    safeError(response, 502, "Krutrim did not return a Chat Completions event stream.");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let responseId: string | undefined;
  try {
    await translateChatCompletionStream(
      upstream,
      options.model,
      translated.toolNames,
      {
        write: (event, data) => {
          if (
            event === "response.created" &&
            data.response !== null &&
            typeof data.response === "object" &&
            !Array.isArray(data.response) &&
            typeof (data.response as JsonRecord).id === "string"
          ) {
            responseId = (data.response as JsonRecord).id as string;
          }
          writeSse(response, event, data);
        },
      },
      options.onChatStreamObservation,
    );
  } catch (error) {
    options.onResponsesError?.(
      error instanceof Error ? error.message : "The bridge stream translator failed.",
    );
    writeSse(response, "response.failed", {
      type: "response.failed",
      response: {
        id: responseId ?? "resp_bridge_failed",
        object: "response",
        status: "failed",
        model: options.model,
        output: [],
        error: {
          code: "bridge_stream_error",
          message: "The local bridge could not translate the Krutrim stream.",
        },
      },
    });
  } finally {
    clearTimeout(timeout);
    response.end();
  }
}

export async function startBridgeServer(options: BridgeServerOptions): Promise<StartedBridgeServer> {
  assertFixedUpstream();
  if (
    options.apiKey.length === 0 ||
    options.instanceId.length === 0 ||
    options.controlToken.length < 32 ||
    options.model.length === 0
  ) {
    throw new ConfigurationError("Bridge server startup parameters are incomplete.");
  }
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw new ConfigurationError("The KrutrimConnect bridge may bind only to 127.0.0.1.");
  }
  let closing = false;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", `http://${host}`);
        if (request.method === "GET" && url.pathname === "/health") {
          const supplied = request.headers["x-krutrim-connect-instance"];
          if (typeof supplied !== "string" || !safeEqual(supplied, options.controlToken)) {
            safeError(response, 401, "Local bridge health authentication failed.");
            return;
          }
          jsonResponse(response, 200, {
            status: "ok",
            model: options.model,
            contract: BRIDGE_RUNTIME_CONTRACT,
            ...(options.activationCommitted === undefined ? {} : { activationCommitted: options.activationCommitted() }),
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/shutdown") {
          const supplied = request.headers["x-krutrim-connect-shutdown"];
          if (typeof supplied !== "string" || !safeEqual(supplied, options.controlToken)) {
            safeError(response, 401, "Local bridge shutdown authentication failed.");
            return;
          }
          jsonResponse(response, 200, { status: "stopping" });
          if (!closing) {
            closing = true;
            setImmediate(() => {
              server.close(() => options.onShutdown?.());
            });
          }
          return;
        }
        if (request.method === "GET" && url.pathname === "/v1/models") {
          const expectedBearer = deriveBridgeBearer(options.apiKey, options.instanceId);
          const suppliedBearer = bearer(request);
          if (suppliedBearer === undefined || !safeEqual(suppliedBearer, expectedBearer)) {
            safeError(response, 401, "Local bridge authentication failed.");
            return;
          }
          jsonResponse(response, 200, {
            object: "list",
            data: [{
              id: options.model,
              object: "model",
              created: 0,
              owned_by: "krutrim",
            }],
          });
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/responses") {
          await handleResponses(request, response, options);
          return;
        }
        if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
          await handleChatCompletions(request, response, options);
          return;
        }
        safeError(response, 404, "Unknown local bridge route.");
      } catch (error) {
        options.onResponsesError?.(
          error instanceof Error ? error.message : "The bridge request handler failed.",
        );
        safeError(
          response,
          error instanceof ConfigurationError ? 400 : 500,
          error instanceof ConfigurationError ? error.message : "Local bridge request failed.",
        );
      }
    })();
  });
  server.requestTimeout = UPSTREAM_TIMEOUT_MS + 30_000;
  server.headersTimeout = 30_000;
  server.maxHeadersCount = 100;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new ConfigurationError("The local bridge did not acquire a TCP port.");
  }
  return {
    server,
    host,
    port: address.port,
    close: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    },
  };
}
