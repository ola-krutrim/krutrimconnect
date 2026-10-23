import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { patch as patchToml, TomlFormat } from "@decimalturn/toml-patch";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";

import { parseCodexToml } from "./config/codex-toml.js";
import type { CodexHarness } from "./harnesses/codex.js";
import type { RuntimePaths } from "./paths.js";
import type { CapabilityName, ProviderAdapter, ProviderCapabilities } from "./providers/types.js";
import { runProcess, type ProcessResult } from "./process.js";
import type { SecretReader } from "./secrets/types.js";
import { readConfigFile } from "./snapshots.js";
import { readState } from "./state.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  paths: RuntimePaths;
  provider: ProviderAdapter;
  harness: CodexHarness;
  secrets: SecretReader;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  codexConfigValidator?: CodexConfigValidator;
  codexSchemaValidator?: CodexConfigValidator;
  model?: string;
  capabilityOverride?: ProviderCapabilities;
  capabilityScopeMessage?: string;
}

export interface CodexConfigValidation {
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface CodexConfigValidationContext {
  configPath: string;
}

export type CodexConfigValidator = (
  config: Uint8Array,
  existed: boolean,
  context?: CodexConfigValidationContext,
) => Promise<CodexConfigValidation>;

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isolatedCodexEnvironment(codexHome: string): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
    "ComSpec",
    "USERPROFILE",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
  ] as const;
  const env: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    NO_COLOR: "1",
    TERM: "xterm-256color",
  };
  for (const key of allowed) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

interface NativeCodexDoctorReport {
  codexVersion?: unknown;
  checks?: {
    "config.load"?: {
      status?: unknown;
      summary?: unknown;
      notes?: unknown;
    };
  };
}

const configDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
let officialSchemaValidator: Promise<ValidateFunction> | undefined;
let officialSchemaDocument: Promise<JsonSchema> | undefined;

interface JsonSchema {
  $ref?: string;
  allOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  [key: string]: unknown;
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadOfficialSchemaDocument(): Promise<JsonSchema> {
  officialSchemaDocument ??= (async () => {
    const schemaUrl = new URL("../schemas/codex-config.schema.json", import.meta.url);
    const parsed = JSON.parse(await readFile(schemaUrl, "utf8")) as unknown;
    if (!isJsonSchema(parsed)) {
      throw new Error("The bundled Codex config schema is not a JSON object.");
    }
    return parsed;
  })();
  return await officialSchemaDocument;
}

function schemaCompatibleValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(schemaCompatibleValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, schemaCompatibleValue(child)]),
    );
  }
  return value;
}

async function loadOfficialSchemaValidator(): Promise<ValidateFunction> {
  officialSchemaValidator ??= (async () => {
    const schema = await loadOfficialSchemaDocument();
    return new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
  })();
  return await officialSchemaValidator;
}

function resolveLocalSchemaRef(root: JsonSchema, reference: string): JsonSchema | undefined {
  if (!reference.startsWith("#/") || reference === "#/definitions/AbsolutePathBuf") {
    return undefined;
  }
  let current: unknown = root;
  for (const encodedPart of reference.slice(2).split("/")) {
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isJsonSchema(current) || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return isJsonSchema(current) ? current : undefined;
}

function rebaseSchemaPaths(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema,
  baseDirectory: string,
  depth = 0,
): { value: unknown; changed: boolean } {
  if (depth > 100) {
    throw new Error("Codex schema path traversal exceeded its recursion limit.");
  }
  if (schema.$ref === "#/definitions/AbsolutePathBuf" && typeof value === "string") {
    return path.isAbsolute(value)
      ? { value, changed: false }
      : { value: path.resolve(baseDirectory, value), changed: true };
  }

  let current = value;
  let changed = false;
  const apply = (candidate: JsonSchema): void => {
    const result = rebaseSchemaPaths(current, candidate, root, baseDirectory, depth + 1);
    current = result.value;
    changed ||= result.changed;
  };

  if (schema.$ref) {
    const referenced = resolveLocalSchemaRef(root, schema.$ref);
    if (referenced) {
      apply(referenced);
    }
  }
  for (const candidate of schema.allOf ?? []) {
    apply(candidate);
  }
  for (const candidate of schema.anyOf ?? []) {
    apply(candidate);
  }
  for (const candidate of schema.oneOf ?? []) {
    apply(candidate);
  }

  if (Array.isArray(current) && schema.items) {
    const next = current.map((item) => {
      const result = rebaseSchemaPaths(item, schema.items!, root, baseDirectory, depth + 1);
      changed ||= result.changed;
      return result.value;
    });
    current = changed ? next : current;
  } else if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    const original = current as Record<string, unknown>;
    const next: Record<string, unknown> = { ...original };
    for (const [key, child] of Object.entries(original)) {
      const childSchema = schema.properties?.[key];
      const additional = schema.additionalProperties;
      const applicable = childSchema ?? (isJsonSchema(additional) ? additional : undefined);
      if (!applicable) {
        continue;
      }
      const result = rebaseSchemaPaths(child, applicable, root, baseDirectory, depth + 1);
      if (result.changed) {
        next[key] = result.value;
        changed = true;
      }
    }
    current = changed ? next : current;
  }

  return { value: current, changed };
}

export async function rebaseCodexConfigPaths(source: string, configPath: string): Promise<string> {
  const parsed = parseCodexToml(source);
  const schema = await loadOfficialSchemaDocument();
  const rebased = rebaseSchemaPaths(parsed, schema, schema, path.dirname(configPath));
  if (!rebased.changed) {
    return source;
  }
  try {
    const format = TomlFormat.autoDetectFormat(source);
    format.inlineTableStart = 3;
    return patchToml(source, rebased.value, format);
  } catch (error) {
    throw new Error("Could not rebase Codex path references for isolated validation.", {
      cause: error,
    });
  }
}

export function reachedStrictCodexTerminalGate(result: ProcessResult): boolean {
  if (result.code !== 1 || result.signal !== null) {
    return false;
  }
  const diagnostic = `${result.stdout}\n${result.stderr}`.trim();
  return /^(?:error:\s*)?stdin(?:\/stderr)? is not (?:a )?(?:terminal|tty)\.?$/iu.test(
    diagnostic,
  );
}

export const validateWithOfficialSchema: CodexConfigValidator = async (config) => {
  let parsed: unknown;
  try {
    parsed = parseCodexToml(configDecoder.decode(config));
  } catch (error) {
    return { status: "fail", message: `Official Codex schema input is invalid: ${messageFrom(error)}` };
  }
  const validate = await loadOfficialSchemaValidator();
  if (validate(schemaCompatibleValue(parsed))) {
    return {
      status: "pass",
      message: "The pinned official Codex config schema accepted the base config.",
    };
  }
  const details = (validate.errors ?? [])
    .slice(0, 5)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
  return {
    status: "fail",
    message: `The pinned official Codex config schema rejected the base config: ${details}`,
  };
};

export const validateWithInstalledCodex: CodexConfigValidator = async (config, existed, context) => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-codex-schema-"));
  const providerId = `krutrim_connect_doctor_${randomUUID().replaceAll("-", "")}`;
  try {
    if (existed) {
      const source = configDecoder.decode(config);
      const isolatedSource = context
        ? await rebaseCodexConfigPaths(source, context.configPath)
        : source;
      await writeFile(path.join(temporaryHome, "config.toml"), isolatedSource, { mode: 0o600 });
    }
    const strictBaseArgs = [
      "--strict-config",
      "-c",
      'model="krutrim-connect-doctor"',
      "-c",
      `model_provider="${providerId}"`,
      "-c",
      `model_providers.${providerId}.name="KrutrimConnect doctor"`,
      "-c",
      `model_providers.${providerId}.base_url="http://127.0.0.1:9/v1"`,
      "-c",
      `model_providers.${providerId}.wire_api="responses"`,
      "-c",
      `model_providers.${providerId}.supports_websockets=false`,
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      "analytics.enabled=false",
      "-c",
      'otel.exporter="none"',
      "-c",
      'otel.trace_exporter="none"',
      "-c",
      'otel.metrics_exporter="none"',
    ];
    const processOptions = {
      cwd: temporaryHome,
      env: isolatedCodexEnvironment(temporaryHome),
      timeoutMs: 15_000,
      maxOutputBytes: 2 * 1024 * 1024,
    };
    const result = await runProcess(
      "codex",
      [...strictBaseArgs, "doctor", "--json"],
      processOptions,
    );
    let report: NativeCodexDoctorReport;
    try {
      report = JSON.parse(result.stdout) as NativeCodexDoctorReport;
    } catch (error) {
      throw new Error("Installed Codex did not return a valid JSON doctor report.", { cause: error });
    }
    const configCheck = report.checks?.["config.load"];
    if (!configCheck || typeof configCheck.status !== "string") {
      throw new Error("Installed Codex doctor report did not contain config.load.");
    }
    const version = typeof report.codexVersion === "string" ? report.codexVersion : "unknown version";
    const summary = typeof configCheck.summary === "string" ? configCheck.summary : "config load failed";
    if (configCheck.status !== "ok") {
      return { status: "fail", message: `Installed Codex ${version} rejected the base config: ${summary}` };
    }

    // `codex doctor` can report config.load=ok for fields that the actual runtime
    // rejects under --strict-config. Starting the interactive entrypoint with a
    // closed pipe forces full strict deserialization, then stops at the TTY gate
    // before a session, hook, MCP server, or inference request can start.
    const strictResult = await runProcess("codex", strictBaseArgs, processOptions);
    const strictOutput = `${strictResult.stdout}\n${strictResult.stderr}`;
    if (!reachedStrictCodexTerminalGate(strictResult)) {
      const unknownField = strictOutput.match(/unknown configuration field [`']([^`'\r\n]+)[`']/iu)?.[1];
      return {
        status: "fail",
        message: unknownField
          ? `Installed Codex ${version} does not recognize configuration field ${unknownField}.`
          : `Installed Codex ${version} rejected the base config during strict runtime loading.`,
      };
    }
    return {
      status: "pass",
      message: `Installed Codex ${version} accepted an isolated, safety-overridden copy of the base config in strict runtime loading.`,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status: existed ? "fail" : "warn",
      message:
        code === "ENOENT"
          ? "Codex CLI was not found, so the installed-Codex loader check could not run."
          : `Could not run the installed-Codex loader check: ${messageFrom(error)}`,
    };
  } finally {
    await rm(temporaryHome, { recursive: true, force: true });
  }
};

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  let configContent: Uint8Array = new Uint8Array();
  let configExisted = false;
  try {
    const config = await readConfigFile(options.paths.codexConfig);
    configContent = config.content;
    configExisted = config.existed;
    if (config.existed) {
      parseCodexToml(config.content.toString("utf8"));
      checks.push({ name: "codex-config", status: "pass", message: `Valid TOML at ${options.paths.codexConfig}` });
    } else {
      checks.push({ name: "codex-config", status: "warn", message: `No Codex config exists yet at ${options.paths.codexConfig}` });
    }
  } catch (error) {
    checks.push({ name: "codex-config", status: "fail", message: messageFrom(error) });
  }

  try {
    const validation = await (options.codexSchemaValidator ?? validateWithOfficialSchema)(
      configContent,
      configExisted,
      { configPath: options.paths.codexConfig },
    );
    checks.push({ name: "codex-schema", ...validation });
  } catch (error) {
    checks.push({
      name: "codex-schema",
      status: "fail",
      message: `Could not run pinned official Codex schema validation: ${messageFrom(error)}`,
    });
  }

  try {
    const validation = await (options.codexConfigValidator ?? validateWithInstalledCodex)(
      configContent,
      configExisted,
      { configPath: options.paths.codexConfig },
    );
    checks.push({ name: "codex-native-loader", ...validation });
  } catch (error) {
    checks.push({
      name: "codex-native-loader",
      status: configExisted ? "fail" : "warn",
      message: messageFrom(error),
    });
  }

  try {
    const status = await options.harness.status();
    checks.push({
      name: "codex-state",
      status: status.state === "drifted" || status.state === "unmanaged" ? "fail" : "pass",
      message: `${status.state}: ${status.detail}`,
    });
  } catch (error) {
    checks.push({ name: "codex-state", status: "fail", message: messageFrom(error) });
  }

  try {
    const state = await readState(options.paths.stateFile);
    if (!state.codex) {
      checks.push({
        name: "credential-helper",
        status: "warn",
        message: "No managed Codex connection exists, so no installed credential helper is configured.",
      });
    } else {
      const entrypoint = state.codex.helperArgs[0];
      const appHomeIndex = state.codex.helperArgs.indexOf("--app-home");
      const configuredAppHome = appHomeIndex >= 0 ? state.codex.helperArgs[appHomeIndex + 1] : undefined;
      if (!path.isAbsolute(state.codex.helperCommand)) {
        throw new Error("Credential helper command is not absolute.");
      }
      await access(state.codex.helperCommand, fsConstants.X_OK);
      if (!entrypoint || !path.isAbsolute(entrypoint) || !(await lstat(entrypoint)).isFile()) {
        throw new Error("Credential helper entrypoint is missing or is not a regular file.");
      }
      if (configuredAppHome !== options.paths.appHome) {
        throw new Error("Credential helper does not pin the configured credential-store location.");
      }
      checks.push({
        name: "credential-helper",
        status: "pass",
        message: "Absolute helper command, CLI entrypoint, and credential-store location are present.",
      });
    }
  } catch (error) {
    checks.push({ name: "credential-helper", status: "fail", message: messageFrom(error) });
  }

  try {
    checks.push(
      (await options.secrets.read()) === null
        ? { name: "api-key", status: "fail", message: "No stored Krutrim API key was found." }
        : { name: "api-key", status: "pass", message: "A Krutrim API key is present (value hidden)." },
    );
  } catch (error) {
    checks.push({ name: "api-key", status: "fail", message: messageFrom(error) });
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const route = `${options.provider.baseUrl.replace(/\/$/u, "")}/chat/completions`;
    const response = await fetchImpl(route, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
    });
    const routeMissingOrUnhealthy = response.status === 404 || response.status >= 500;
    const redirected = response.status >= 300 && response.status < 400;
    checks.push(
      routeMissingOrUnhealthy
        ? {
            name: "endpoint-reachability",
            status: "fail",
            message: `Reached ${route}, but the documented route returned HTTP ${response.status}; no credential was sent.`,
          }
        : redirected
          ? {
              name: "endpoint-reachability",
              status: "warn",
              message: `${route} returned HTTP ${response.status} with redirects disabled; no credential was sent.`,
            }
          : {
              name: "endpoint-reachability",
              status: "pass",
              message: `Reached the documented route ${route} (HTTP ${response.status}); no credential was sent.`,
            },
    );
  } catch (error) {
    checks.push({
      name: "endpoint-reachability",
      status: "fail",
      message: `Could not reach ${options.provider.baseUrl}/chat/completions: ${messageFrom(error)}`,
    });
  }

  let capabilityMatrix = options.capabilityOverride ?? options.provider.capabilities;
  if (options.model !== undefined) {
    try {
      if (options.capabilityOverride === undefined) {
        const resolved = options.provider.resolveModel(options.model);
        capabilityMatrix = options.provider.capabilitiesFor(resolved);
      }
      checks.push({
        name: "capability-scope",
        status: "pass",
        message: options.capabilityScopeMessage ??
          "Capability evidence was resolved for the requested exact model. No inference was run.",
      });
    } catch (error) {
      checks.push({ name: "capability-scope", status: "fail", message: messageFrom(error) });
    }
  }

  const required = new Set<CapabilityName>(options.harness.requiredCapabilities.map((item) => item.name));
  for (const [name, capability] of Object.entries(capabilityMatrix)) {
    const isRequired = required.has(name as keyof typeof options.provider.capabilities);
    const status: DoctorCheckStatus =
      capability.support === "supported" ? "pass" : isRequired ? "fail" : "warn";
    checks.push({
      name: `capability:${name}`,
      status,
      message: `${capability.support} (${capability.evidence}): ${capability.detail}`,
    });
  }

  return { ok: checks.every((check) => check.status !== "fail"), checks };
}
