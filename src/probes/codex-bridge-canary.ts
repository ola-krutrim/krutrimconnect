import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { BridgeProbeCheck } from "../bridge/evidence.js";
import { deriveBridgeBearer, startBridgeServer } from "../bridge/server.js";
import type { ChatStreamObservation } from "../bridge/stream.js";

const CANARY_MARKER = "KRUTRIM_CONNECT_FULL_CODEX_CANARY_OK";
const CANARY_PROVIDER_ID = "krutrim_connect_canary";
const CANARY_BEARER_ENV = "KRUTRIM_CONNECT_CANARY_BEARER";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface CodexCanaryProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface CodexCanaryProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  failure?: "spawn" | "timeout" | "output-limit";
}

export type CodexCanaryProcessRunner = (
  request: CodexCanaryProcessRequest,
) => Promise<CodexCanaryProcessResult>;

export interface CodexBridgeCanaryOptions {
  model: string;
  apiKey: string;
  modelCatalogPath: string;
  codexCommand?: string;
  cwd?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  processRunner?: CodexCanaryProcessRunner;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function appendBounded(chunks: Buffer[], chunk: Buffer, current: number): number {
  const next = current + chunk.length;
  if (next <= MAX_PROCESS_OUTPUT_BYTES) {
    chunks.push(chunk);
  }
  return next;
}

export async function runCodexCanaryProcess(
  request: CodexCanaryProcessRequest,
): Promise<CodexCanaryProcessResult> {
  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: CodexCanaryProcessResult["failure"];
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();

    const stop = (reason: "timeout" | "output-limit"): void => {
      if (failure !== undefined) {
        return;
      }
      failure = reason;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = appendBounded(stdout, chunk, stdoutBytes);
      if (stdoutBytes > MAX_PROCESS_OUTPUT_BYTES) {
        stop("output-limit");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = appendBounded(stderr, chunk, stderrBytes);
      if (stderrBytes > MAX_PROCESS_OUTPUT_BYTES) {
        stop("output-limit");
      }
    });
    const timeout = setTimeout(() => stop("timeout"), request.timeoutMs);
    timeout.unref();
    child.once("error", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKill !== undefined) {
        clearTimeout(forceKill);
      }
      resolve({ exitCode: null, stdout: "", stderr: "", failure: "spawn" });
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKill !== undefined) {
        clearTimeout(forceKill);
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ...(failure === undefined ? {} : { failure }),
      });
    });
  });
}

function canaryArgs(model: string, baseUrl: string, modelCatalogPath: string): string[] {
  return [
    "exec",
    "--ephemeral",
    "--color",
    "never",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--model",
    model,
    "-c",
    `model_provider=${tomlString(CANARY_PROVIDER_ID)}`,
    "-c",
    `model_catalog_json=${tomlString(modelCatalogPath)}`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.name=${tomlString("KrutrimConnect full Codex canary")}`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.base_url=${tomlString(baseUrl)}`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.wire_api=${tomlString("responses")}`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.supports_websockets=false`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.env_key=${tomlString(CANARY_BEARER_ENV)}`,
    "-c",
    "features.hooks=false",
    `Call the exec_command function exactly once with the JSON arguments {"cmd":"pwd"}. ` +
      `Do not call write_stdin or any other tool. After exec_command returns, reply with exactly ` +
      `${CANARY_MARKER} and no other text.`,
  ];
}

function hasToolOutput(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const input = (value as Record<string, unknown>).input;
  return Array.isArray(input) && input.some((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const type = (item as Record<string, unknown>).type;
    return type === "function_call_output" || type === "custom_tool_call_output";
  });
}

function requestShape(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "non-object";
  }
  const body = value as Record<string, unknown>;
  const tools = Array.isArray(body.tools)
    ? body.tools.map((tool) => {
        if (tool === null || typeof tool !== "object" || Array.isArray(tool)) {
          return "malformed";
        }
        const item = tool as Record<string, unknown>;
        const type = typeof item.type === "string" ? item.type : "unknown";
        const name = typeof item.name === "string" ? item.name : undefined;
        const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
        return [type, namespace, name].filter((part) => part !== undefined).join(":");
      })
    : [];
  const input = Array.isArray(body.input)
    ? body.input.map((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          return "malformed";
        }
        const entry = item as Record<string, unknown>;
        if (typeof entry.type === "string") {
          return entry.type;
        }
        return typeof entry.role === "string" ? `role:${entry.role}` : "unknown";
      })
    : [typeof body.input];
  return `tools=[${tools.join(",")}],input=[${input.join(",")}]`;
}

function observationShape(observation: ChatStreamObservation): string {
  const fields = [
    `chunks=${observation.chunkCount}`,
    `reasoning=${observation.reasoningDeltaCount}`,
    `text=${observation.textDeltaCount}`,
    `tools=${observation.toolCallCount}`,
    `tool-fragments=${observation.toolCallFragmentCount}`,
    `finish=${observation.finishReasons.join(",") || "none"}`,
  ];
  if (observation.stage !== undefined) {
    fields.unshift(`stage=${observation.stage}`);
  }
  if (observation.toolClasses !== undefined && observation.toolClasses.length > 0) {
    fields.push(`tool-classes=${observation.toolClasses.join(",")}`);
  }
  if (observation.argumentShapes !== undefined && observation.argumentShapes.length > 0) {
    fields.push(`argument-shapes=${observation.argumentShapes.join(",")}`);
  }
  return fields.join(",");
}

function codexErrorCategory(stderr: string): string {
  if (/Krutrim rejected the bridged request \(HTTP \d+\)/u.test(stderr)) {
    return "upstream-request-rejected";
  }
  if (/stream disconnected|connection closed|end of file/iu.test(stderr)) {
    return "response-stream-ended";
  }
  if (/decode|deserializ|invalid (?:response|event)|unknown variant|missing field/iu.test(stderr)) {
    return "response-event-rejected";
  }
  if (/tool|function call/iu.test(stderr)) {
    return "tool-processing-error";
  }
  if (/error sending request|connection refused|connect error/iu.test(stderr)) {
    return "local-transport-error";
  }
  return stderr.trim().length === 0 ? "none" : "codex-reported-error";
}

export async function runCodexBridgeCanary(
  options: CodexBridgeCanaryOptions,
): Promise<BridgeProbeCheck> {
  const instanceId = randomUUID();
  const controlToken = randomBytes(32).toString("hex");
  let requestCount = 0;
  let toolContinuationObserved = false;
  const requestShapes: string[] = [];
  const bridgeErrors = new Set<string>();
  const chatObservations: string[] = [];
  const server = await startBridgeServer({
    model: options.model,
    instanceId,
    controlToken,
    apiKey: options.apiKey,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    onResponsesRequest: (body) => {
      requestCount += 1;
      toolContinuationObserved ||= hasToolOutput(body);
      if (requestShapes.length < 8) {
        requestShapes.push(requestShape(body));
      }
    },
    onResponsesError: (message) => {
      if (bridgeErrors.size < 8) {
        bridgeErrors.add(message);
      }
    },
    onChatStreamObservation: (observation) => {
      if (chatObservations.length < 8) {
        chatObservations.push(observationShape(observation));
      }
    },
  });
  const isolatedCodexHome = await mkdtemp(
    path.join(os.tmpdir(), "krutrim-connect-bridge-canary-"),
  );
  try {
    const baseUrl = `http://${server.host}:${server.port}/v1`;
    const command = options.codexCommand ?? (process.env.CODEX_CLI_PATH?.trim() || "codex");
    const result = await (options.processRunner ?? runCodexCanaryProcess)({
      command,
      args: canaryArgs(options.model, baseUrl, options.modelCatalogPath),
      cwd: options.cwd ?? isolatedCodexHome,
      env: {
        ...process.env,
        CODEX_HOME: isolatedCodexHome,
        [CANARY_BEARER_ENV]: deriveBridgeBearer(options.apiKey, instanceId),
      },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.failure === "spawn") {
      return {
        status: "inconclusive",
        detail: "The installed Codex executable could not be started for the full-envelope canary.",
      };
    }
    if (result.failure === "timeout") {
      return {
        status: "inconclusive",
        detail: "The full Codex canary timed out before qualification completed.",
      };
    }
    if (result.failure === "output-limit") {
      return {
        status: "fail",
        detail: "The full Codex canary exceeded its bounded diagnostic output limit.",
      };
    }
    const exactMarker = result.stdout.trim() === CANARY_MARKER;
    const fallbackMetadataWarning = /Model metadata for ['`].+['`] not found/u.test(result.stderr);
    if (
      requestCount >= 2 &&
      toolContinuationObserved &&
      !fallbackMetadataWarning &&
      result.exitCode === 0 &&
      exactMarker
    ) {
      return {
        status: "pass",
        detail: "A fresh ephemeral Codex session loaded the managed model catalogue, completed a shell-tool continuation through the bridge, and returned the exact canary marker.",
      };
    }
    if (fallbackMetadataWarning) {
      return {
        status: "fail",
        detail: "The fresh Codex canary reported missing model metadata instead of loading the managed catalogue.",
      };
    }
    if (requestCount > 0) {
      return {
        status: "fail",
        detail:
          `A fresh Codex request reached the bridge but did not complete the required tool-call continuation ` +
          `(requests=${requestCount}, continuation=${toolContinuationObserved ? "yes" : "no"}, ` +
          `exit=${result.exitCode ?? "signal"}; shapes=${requestShapes.join(" | ")}; ` +
          `chat=${chatObservations.join(" | ") || "none"}; ` +
          `codex-error=${codexErrorCategory(result.stderr)}; ` +
          `bridge-errors=${[...bridgeErrors].join(" | ") || "none"}).`,
      };
    }
    return {
      status: "inconclusive",
      detail: "The Codex canary did not reach the local Responses bridge.",
    };
  } finally {
    await server.close().catch(() => undefined);
    await rm(isolatedCodexHome, { recursive: true, force: true }).catch(() => undefined);
  }
}
