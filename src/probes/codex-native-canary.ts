import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CapabilityProbeCheck } from "../capabilities/evidence.js";
import { KRUTRIM_BASE_URL } from "../providers/krutrim.js";
import {
  runCodexCanaryProcess,
  type CodexCanaryProcessRunner,
} from "./codex-bridge-canary.js";

const CANARY_MARKER = "KRUTRIM_CONNECT_NATIVE_CODEX_CANARY_OK";
const CANARY_PROVIDER_ID = "krutrim_connect_native_canary";
const CANARY_KEY_ENV = "KRUTRIM_CONNECT_NATIVE_CANARY_KEY";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface CodexNativeCanaryResult {
  status: "pass" | "fail" | "inconclusive";
  check: CapabilityProbeCheck;
}

export interface CodexNativeCanaryOptions {
  model: string;
  apiKey: string;
  modelCatalogPath: string;
  codexCommand?: string;
  cwd?: string;
  timeoutMs?: number;
  processRunner?: CodexCanaryProcessRunner;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function canaryArgs(model: string, modelCatalogPath: string): string[] {
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
    `model_providers.${CANARY_PROVIDER_ID}.name=${tomlString("KrutrimConnect native full Codex canary")}`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.base_url=${tomlString(KRUTRIM_BASE_URL)}`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.wire_api=${tomlString("responses")}`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.supports_websockets=false`,
    "-c",
    `model_providers.${CANARY_PROVIDER_ID}.env_key=${tomlString(CANARY_KEY_ENV)}`,
    "-c",
    "features.hooks=false",
    `Use the shell tool exactly once to run pwd. After the tool returns, reply with exactly ${CANARY_MARKER} and no other text.`,
  ];
}

export async function runCodexNativeCanary(
  options: CodexNativeCanaryOptions,
): Promise<CodexNativeCanaryResult> {
  const isolatedCodexHome = await mkdtemp(
    path.join(os.tmpdir(), "krutrim-connect-native-canary-"),
  );
  try {
    const command = options.codexCommand ?? (process.env.CODEX_CLI_PATH?.trim() || "codex");
    const result = await (options.processRunner ?? runCodexCanaryProcess)({
      command,
      args: canaryArgs(options.model, options.modelCatalogPath),
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME: isolatedCodexHome,
        [CANARY_KEY_ENV]: options.apiKey,
      },
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (result.failure === "spawn") {
      return {
        status: "inconclusive",
        check: {
          status: "fail",
          detail: "The installed Codex executable could not be started for the native full-envelope canary.",
        },
      };
    }
    if (result.failure === "timeout") {
      return {
        status: "inconclusive",
        check: {
          status: "fail",
          detail: "The native full Codex canary timed out before qualification completed.",
        },
      };
    }
    if (result.failure === "output-limit") {
      return {
        status: "fail",
        check: {
          status: "fail",
          detail: "The native full Codex canary exceeded its bounded diagnostic output limit.",
        },
      };
    }
    if (/Model metadata for ['`].+['`] not found/u.test(result.stderr)) {
      return {
        status: "fail",
        check: {
          status: "fail",
          detail: "The native Codex canary reported missing model metadata instead of loading the managed catalogue.",
        },
      };
    }
    if (
      /(?:errors\.edgesuite\.net|Access Denied|status 403 Forbidden)/iu.test(result.stderr)
    ) {
      return {
        status: "fail",
        check: {
          status: "fail",
          httpStatus: 403,
          detail: "The full Codex Responses envelope was rejected by upstream EdgeSuite/Akamai (HTTP 403).",
        },
      };
    }
    if (result.exitCode === 0 && result.stdout.trim() === CANARY_MARKER) {
      return {
        status: "pass",
        check: {
          status: "pass",
          detail: "A fresh isolated Codex session loaded the managed catalogue and completed a real native Responses shell-tool continuation.",
        },
      };
    }
    return {
      status: "fail",
      check: {
        status: "fail",
        detail: `The full native Codex canary did not complete successfully (exit=${result.exitCode ?? "signal"}).`,
      },
    };
  } finally {
    await rm(isolatedCodexHome, { recursive: true, force: true }).catch(() => undefined);
  }
}
