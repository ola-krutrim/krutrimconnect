import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexHarness } from "../src/harnesses/codex.js";
import { stateFileForCodexConfig, stateFileForOpenCodeConfig, type RuntimePaths } from "../src/paths.js";
import type { ProviderAdapter } from "../src/providers/types.js";
import { krutrimProvider } from "../src/providers/krutrim.js";

const catalogTemplate = {
  slug: "template",
  display_name: "Template",
  description: "test template",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 1,
  additional_speed_tiers: [],
  service_tiers: [],
  availability_nux: null,
  upgrade: null,
  base_instructions: "You are Codex based on a template.\n\nTest instructions.",
  model_messages: {
    instructions_template: "You are Codex based on a template.\n\nTest instructions.",
    instructions_variables: {},
    approvals: null,
    auto_review: null,
    permissions: null,
  },
  include_skills_usage_instructions: false,
  default_reasoning_summary: "none",
  support_verbosity: false,
  default_verbosity: null,
  apply_patch_tool_type: null,
  web_search_tool_type: "text",
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_parallel_tool_calls: false,
  supports_image_detail_original: false,
  context_window: 131072,
  max_context_window: 131072,
  comp_hash: null,
  effective_context_window_percent: 95,
  experimental_supported_tools: [],
  input_modalities: ["text"],
  supports_search_tool: false,
  use_responses_lite: false,
};

export const testCatalogOptions = {
  metadataResolver: async (model: string) => ({
    id: model,
    name: model,
    contextLength: 131_072,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportedParameters: ["max_tokens"],
    supportedFeatures: [],
    description: `${model} test model`,
    modelEndpoint: "https://cloud.olakrutrim.com/v1/chat/completions",
    observedAt: "2026-08-13T00:00:00.000Z",
  }),
  catalogTemplateLoader: async () => structuredClone(catalogTemplate),
};

export interface TestWorkspace {
  root: string;
  paths: RuntimePaths;
  harness: CodexHarness;
  cleanup(): Promise<void>;
}

export const supportedProvider: ProviderAdapter = {
  ...krutrimProvider,
  capabilities: {
    ...krutrimProvider.capabilities,
    responsesApi: {
      support: "supported",
      evidence: "probed",
      detail: "test fixture",
    },
    streaming: {
      support: "supported",
      evidence: "probed",
      detail: "test fixture",
    },
    toolCalling: {
      support: "supported",
      evidence: "probed",
      detail: "test fixture",
    },
  },
  capabilitiesFor() {
    return this.capabilities;
  },
};

export async function createTestWorkspace(): Promise<TestWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-test-"));
  const appHome = path.join(root, "app");
  const codexHome = path.join(root, "codex");
  await mkdir(codexHome, { recursive: true });
  const codexConfig = path.join(codexHome, "config.toml");
  const stateFile = stateFileForCodexConfig(appHome, codexConfig);
  const openCodeHome = path.join(root, "opencode");
  const openCodeConfig = path.join(openCodeHome, "opencode.json");
  const paths: RuntimePaths = {
    appHome,
    codexHome,
    codexConfig,
    stateFile,
    snapshotsDir: path.join(appHome, "snapshots", "codex"),
    openCodeHome,
    openCodeConfig,
    openCodeJsoncConfig: path.join(openCodeHome, "opencode.jsonc"),
    openCodeStateFile: stateFileForOpenCodeConfig(appHome, openCodeConfig),
    openCodeSnapshotsDir: path.join(appHome, "snapshots", "opencode"),
    fallbackSecretFile: path.join(appHome, "credentials.json"),
    credentialBackendFile: path.join(appHome, "credential-backend.json"),
    capabilityEvidenceDir: path.join(appHome, "capabilities", "krutrim"),
    bridgeEvidenceDir: path.join(appHome, "bridge-capabilities", "krutrim"),
    bridgeRuntimeFile: path.join(appHome, "runtime", "bridge.json"),
    codexBridgeRuntimeFile: path.join(appHome, "runtime", "codex.json"),
    openCodeBridgeRuntimeFile: path.join(appHome, "runtime", "opencode.json"),
    openCodeBridgeCredentialFile: path.join(appHome, "runtime", "opencode.token"),
    codexModelCatalogDir: path.join(
      appHome,
      "codex",
      "model-catalogs",
      path.basename(stateFile, ".json"),
    ),
  };
  const harness = new CodexHarness(
    paths,
    { read: async () => "test-secret-never-logged" },
    {
      command: "/absolute/node",
      args: [
        "/absolute/krutrimconnect.js",
        "_credential",
        "read",
        "--app-home",
        appHome,
      ],
    },
    testCatalogOptions,
  );
  return {
    root,
    paths,
    harness,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}
