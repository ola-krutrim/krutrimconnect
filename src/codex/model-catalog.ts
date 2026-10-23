import { toolInvocation } from "../tool-invocation.js";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { fetchKrutrimModelCatalogue } from "../auth.js";
import { ConfigurationError } from "../errors.js";
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  fileMode,
  removeFileDurably,
  sha256,
} from "../fs/atomic.js";
import type { RuntimePaths } from "../paths.js";
import { KRUTRIM_BASE_URL } from "../providers/krutrim.js";

const KRUTRIM_CHAT_COMPLETIONS_URL = `${KRUTRIM_BASE_URL}/chat/completions`;
const MAX_CODEX_CATALOG_BYTES = 8 * 1024 * 1024;
const CODEX_DEBUG_TIMEOUT_MS = 30_000;
const TEMPLATE_MODEL = "gpt-5.6-terra";

type JsonRecord = Record<string, unknown>;

export interface KrutrimLiveModelMetadata {
  id: string;
  name: string;
  contextLength: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  supportedFeatures: string[];
  description: string;
  modelEndpoint: string;
  observedAt: string;
}

export type CodexConnectionCatalogMode = "native" | "bridge";

export interface PreparedCodexModelCatalog {
  path: string;
  sha256: string;
  model: string;
  contextWindow: number;
  created: boolean;
}

export type KrutrimModelMetadataResolver = (
  model: string,
  apiKey: string,
) => Promise<KrutrimLiveModelMetadata>;

export type CodexCatalogTemplateLoader = () => Promise<JsonRecord>;

export interface PrepareCodexModelCatalogOptions {
  model: string;
  apiKey: string;
  mode: CodexConnectionCatalogMode;
  metadataResolver?: KrutrimModelMetadataResolver;
  templateLoader?: CodexCatalogTemplateLoader;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ConfigurationError(`Krutrim model metadata has invalid ${label}.`);
  }
  return [...value];
}

function parseLiveModel(value: unknown, observedAt: string): KrutrimLiveModelMetadata {
  if (!isRecord(value)) {
    throw new ConfigurationError("Krutrim's model catalogue contains a malformed model entry.");
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.name !== "string" ||
    !Number.isSafeInteger(value.context_length) ||
    (value.context_length as number) < 1 ||
    (value.context_length as number) > 10_000_000 ||
    typeof value.description !== "string" ||
    typeof value.model_endpoint !== "string"
  ) {
    throw new ConfigurationError("Krutrim's model catalogue contains incomplete model metadata.");
  }
  return {
    id: value.id,
    name: value.name,
    contextLength: value.context_length as number,
    inputModalities: strings(value.input_modalities, "input modalities"),
    outputModalities: strings(value.output_modalities, "output modalities"),
    supportedParameters: strings(value.supported_parameters, "supported parameters"),
    supportedFeatures: strings(value.supported_features, "supported features"),
    description: value.description,
    modelEndpoint: value.model_endpoint,
    observedAt,
  };
}

export async function fetchKrutrimModelMetadata(
  model: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<KrutrimLiveModelMetadata> {
  if (apiKey.length === 0) {
    throw new ConfigurationError("Cannot read Krutrim model metadata without a credential.");
  }
  const entries = await fetchKrutrimModelCatalogue(apiKey, { fetchImpl });
  const observedAt = now().toISOString();
  const matches = entries
    .map((item) => parseLiveModel(item, observedAt))
    .filter((item) => item.id === model);
  if (matches.length !== 1) {
    throw new ConfigurationError(
      matches.length === 0
        ? `Model '${model}' is not present in Krutrim's authenticated model catalogue.`
        : `Krutrim's model catalogue returned duplicate metadata for '${model}'.`,
    );
  }
  const metadata = matches[0]!;
  if (metadata.modelEndpoint !== KRUTRIM_CHAT_COMPLETIONS_URL) {
    throw new ConfigurationError(
      `Krutrim's model catalogue advertises an unexpected endpoint for '${model}'.`,
    );
  }
  if (!metadata.inputModalities.includes("text") || !metadata.outputModalities.includes("text")) {
    throw new ConfigurationError(`Model '${model}' does not advertise required text input and output.`);
  }
  return metadata;
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  failure?: "spawn" | "timeout" | "output-limit";
}

async function runCodexDebug(command: string): Promise<ProcessResult> {
  return await new Promise((resolve) => {
    const stdout: Buffer[] = [];
    let bytes = 0;
    let failure: ProcessResult["failure"];
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    let invocation;
    try { invocation = toolInvocation(command, ["debug", "models", "--bundled"]); }
    catch { resolve({exitCode:null,stdout:"",failure:"spawn"}); return; }
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
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
      bytes += chunk.length;
      if (bytes <= MAX_CODEX_CATALOG_BYTES) {
        stdout.push(chunk);
      } else {
        stop("output-limit");
      }
    });
    const timeout = setTimeout(() => stop("timeout"), CODEX_DEBUG_TIMEOUT_MS);
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
      resolve({ exitCode: null, stdout: "", failure: "spawn" });
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
        ...(failure === undefined ? {} : { failure }),
      });
    });
  });
}

export async function loadInstalledCodexCatalogTemplate(
  codexCommand = process.env.CODEX_CLI_PATH?.trim() || "codex",
): Promise<JsonRecord> {
  const result = await runCodexDebug(codexCommand);
  if (result.failure !== undefined || result.exitCode !== 0) {
    throw new ConfigurationError(
      "The installed Codex model catalogue could not be read safely; no configuration was changed.",
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new ConfigurationError("The installed Codex model catalogue is not valid JSON.", { cause: error });
  }
  if (!isRecord(body) || !Array.isArray(body.models)) {
    throw new ConfigurationError("The installed Codex model catalogue has an unexpected shape.");
  }
  const preferred = body.models.find(
    (item) => isRecord(item) && item.slug === TEMPLATE_MODEL,
  );
  const fallback = body.models.find(
    (item) => isRecord(item) && typeof item.base_instructions === "string",
  );
  const selected = preferred ?? fallback;
  if (!isRecord(selected) || typeof selected.base_instructions !== "string") {
    throw new ConfigurationError("The installed Codex catalogue has no usable model template.");
  }
  return structuredClone(selected);
}

function replaceIdentity(source: unknown, identity: string): string {
  if (typeof source !== "string" || source.length === 0) {
    throw new ConfigurationError("The installed Codex model template has no base instructions.");
  }
  const boundary = source.indexOf("\n\n");
  return boundary === -1 ? identity : `${identity}${source.slice(boundary)}`;
}

function reasoningMetadata(metadata: KrutrimLiveModelMetadata): {
  defaultReasoningLevel: string | null;
  supportedReasoningLevels: JsonRecord[];
} {
  const controllable = metadata.supportedParameters.includes("reasoning_effort");
  if (!controllable) {
    return { defaultReasoningLevel: null, supportedReasoningLevels: [] };
  }
  return {
    defaultReasoningLevel: "medium",
    supportedReasoningLevels: [
      { effort: "low", description: "Lower reasoning effort" },
      { effort: "medium", description: "Balanced reasoning effort" },
      { effort: "high", description: "Higher reasoning effort" },
    ],
  };
}

export function buildCodexModelCatalog(
  metadata: KrutrimLiveModelMetadata,
  template: JsonRecord,
  mode: CodexConnectionCatalogMode,
): JsonRecord {
  const identity =
    `You are Codex, a coding agent powered by the ${metadata.id} model served by Krutrim ` +
    "through KrutrimConnect. You and the user share one workspace, and your job is to " +
    "collaborate with them until their goal is genuinely handled.";
  const reasoning = reasoningMetadata(metadata);
  const modelMessages = isRecord(template.model_messages)
    ? {
        ...structuredClone(template.model_messages),
        instructions_template: replaceIdentity(
          template.model_messages.instructions_template ?? template.base_instructions,
          identity,
        ),
      }
    : undefined;
  const model: JsonRecord = {
    ...structuredClone(template),
    slug: metadata.id,
    display_name: `${metadata.name} (Krutrim)`,
    description: `${metadata.description} via KrutrimConnect ${mode}.`,
    default_reasoning_level: reasoning.defaultReasoningLevel,
    supported_reasoning_levels: reasoning.supportedReasoningLevels,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    additional_speed_tiers: [],
    service_tiers: [],
    default_service_tier: null,
    availability_nux: null,
    upgrade: null,
    base_instructions: replaceIdentity(template.base_instructions, identity),
    // Krutrim's Chat-compatible models have established JSON function-tool
    // support, while Codex code-mode custom tools are model-specific. Bridge
    // sessions therefore use Codex's direct tool contract so shell operations
    // arrive as ordinary function calls that the Chat bridge can translate.
    tool_mode: mode === "bridge" ? "direct" : template.tool_mode,
    apply_patch_tool_type: mode === "bridge" ? null : template.apply_patch_tool_type,
    include_skills_usage_instructions: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    web_search_tool_type: "text",
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: metadata.contextLength,
    max_context_window: metadata.contextLength,
    auto_compact_token_limit: null,
    comp_hash: null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    // The current bridge conformance contract proves text and function tools,
    // not image payload translation. Native image support is also not probed.
    input_modalities: ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
    auto_review_model_override: null,
    multi_agent_version: null,
    ...(modelMessages === undefined ? { model_messages: null } : { model_messages: modelMessages }),
  };
  return { models: [model] };
}

export function serializeCodexModelCatalog(catalog: JsonRecord): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

async function existingCatalogHash(target: string): Promise<string | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ConfigurationError(`Managed Codex model catalogue path is unsafe: ${target}`);
  }
  if (info.size > MAX_CODEX_CATALOG_BYTES) {
    throw new ConfigurationError(`Managed Codex model catalogue is unexpectedly large: ${target}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new ConfigurationError(`Managed Codex model catalogue is group- or world-accessible: ${target}`);
  }
  return sha256(await readFile(target));
}

export async function prepareCodexModelCatalog(
  paths: RuntimePaths,
  options: PrepareCodexModelCatalogOptions,
): Promise<PreparedCodexModelCatalog> {
  const metadata = await (options.metadataResolver ?? fetchKrutrimModelMetadata)(
    options.model,
    options.apiKey,
  );
  if (metadata.id !== options.model) {
    throw new ConfigurationError("Krutrim model metadata is bound to a different model.");
  }
  const template = await (options.templateLoader ?? loadInstalledCodexCatalogTemplate)();
  const source = serializeCodexModelCatalog(buildCodexModelCatalog(metadata, template, options.mode));
  const digest = sha256(source);
  const target = path.join(paths.codexModelCatalogDir, `${digest}.json`);
  await ensurePrivateDirectory(paths.codexModelCatalogDir);
  const existingHash = await existingCatalogHash(target);
  if (existingHash !== null && existingHash !== digest) {
    throw new ConfigurationError(`Managed Codex model catalogue content does not match its path: ${target}`);
  }
  if (existingHash === null) {
    await atomicWriteFile(target, source, { mode: 0o600, expectedSha256: null });
  } else if (process.platform !== "win32" && await fileMode(target) !== 0o600) {
    throw new ConfigurationError(`Managed Codex model catalogue permissions changed: ${target}`);
  }
  return {
    path: target,
    sha256: digest,
    model: metadata.id,
    contextWindow: metadata.contextLength,
    created: existingHash === null,
  };
}

export async function managedCodexModelCatalogIsIntact(
  paths: RuntimePaths,
  catalogPath: string,
  expectedSha256: string,
): Promise<boolean> {
  const expectedDirectory = path.resolve(paths.codexModelCatalogDir);
  const resolved = path.resolve(catalogPath);
  if (
    path.dirname(resolved) !== expectedDirectory ||
    path.basename(resolved) !== `${expectedSha256}.json`
  ) {
    return false;
  }
  return await existingCatalogHash(resolved).then(
    (actual) => actual === expectedSha256,
    () => false,
  );
}

export async function removeManagedCodexModelCatalog(
  paths: RuntimePaths,
  catalogPath: string,
  expectedSha256: string,
): Promise<boolean> {
  if (!(await managedCodexModelCatalogIsIntact(paths, catalogPath, expectedSha256))) {
    return false;
  }
  await removeFileDurably(catalogPath);
  return true;
}
