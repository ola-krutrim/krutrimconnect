import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import { ConfigurationError } from "../errors.js";

export const OPENCODE_PROVIDER_ID = "krutrim";
export const OPENCODE_SCHEMA_URL = "https://opencode.ai/config.json";
export const OPENCODE_BRIDGE_TOKEN_ENV = "KRUTRIM_CONNECT_BRIDGE_TOKEN";

type JsonObject = Record<string, unknown>;
type OpenCodeConfigVariant = "v1" | "v2";
type ProviderTableKey = "provider" | "providers";

export interface OpenCodeManagedMapping {
  model: string;
  baseUrl: string;
  /** Omitted only for legacy sessions that require krutrimconnect opencode run. */
  credentialFile?: string;
}

function credentialReference(mapping: OpenCodeManagedMapping): string {
  if (mapping.credentialFile === undefined) {
    return `{env:${OPENCODE_BRIDGE_TOKEN_ENV}}`;
  }
  if (
    mapping.credentialFile.length === 0 ||
    mapping.credentialFile.length > 4096 ||
    !path.isAbsolute(mapping.credentialFile) ||
    mapping.credentialFile.includes("}") ||
    /[\u0000-\u001f\u007f]/u.test(mapping.credentialFile)
  ) {
    throw new ConfigurationError("The managed OpenCode credential file path is not safe for configuration substitution.");
  }
  return `{file:${mapping.credentialFile}}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseOpenCodeJson(source: string): JsonObject {
  if (source.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!isObject(parsed)) {
      throw new Error("OpenCode configuration root is not an object");
    }
    return parsed;
  } catch (error) {
    throw new ConfigurationError(
      "OpenCode configuration must be strict JSON. JSONC files are preserved rather than rewritten; migrate the global configuration to JSON before connecting it.",
      { cause: error },
    );
  }
}

function providerTable(
  config: JsonObject,
  key: ProviderTableKey,
  create: boolean,
): JsonObject | undefined {
  const current = config[key];
  if (current === undefined) {
    if (!create) {
      return undefined;
    }
    const created: JsonObject = {};
    config[key] = created;
    return created;
  }
  if (!isObject(current)) {
    throw new ConfigurationError(`OpenCode configuration field '${key}' must be an object.`);
  }
  return current;
}

function tableKey(variant: OpenCodeConfigVariant): ProviderTableKey {
  return variant === "v1" ? "provider" : "providers";
}

function configVariant(config: JsonObject): OpenCodeConfigVariant {
  const v1 = providerTable(config, "provider", false);
  const v2 = providerTable(config, "providers", false);
  const v1Other = v1 !== undefined && Object.keys(v1).some((id) => id !== OPENCODE_PROVIDER_ID);
  const v2Other = v2 !== undefined && Object.keys(v2).some((id) => id !== OPENCODE_PROVIDER_ID);

  if (v1Other && !v2Other) {
    return "v1";
  }
  if (v2Other && !v1Other) {
    return "v2";
  }
  if (v1 !== undefined && v2 === undefined) {
    return "v1";
  }
  if (v2 !== undefined && v1 === undefined) {
    return "v2";
  }
  if (v1 === undefined && v2 === undefined) {
    return "v1";
  }
  throw new ConfigurationError(
    "OpenCode configuration contains both v1 'provider' and v2 'providers' tables; their active schema cannot be inferred safely.",
  );
}

function providerMapping(
  mapping: OpenCodeManagedMapping,
  variant: OpenCodeConfigVariant,
): JsonObject {
  const apiKey = credentialReference(mapping);
  if (variant === "v1") {
    return {
      name: "Krutrim Cloud",
      npm: "@ai-sdk/openai-compatible",
      options: {
        baseURL: mapping.baseUrl,
        apiKey,
      },
      models: {
        [mapping.model]: {
          name: mapping.model,
        },
      },
    };
  }
  return {
    name: "Krutrim Cloud",
    ...(mapping.credentialFile === undefined
      ? { env: [OPENCODE_BRIDGE_TOKEN_ENV] }
      : {}),
    package: "@opencode-ai/ai/providers/openai-compatible",
    settings: {
      baseURL: mapping.baseUrl,
      ...(mapping.credentialFile === undefined ? {} : { apiKey }),
    },
    models: {
      [mapping.model]: {
        name: mapping.model,
        capabilities: {
          tools: true,
          input: ["text"],
          output: ["text"],
        },
      },
    },
  };
}

function assertTopLevelShape(config: JsonObject): void {
  if (config.model !== undefined && typeof config.model !== "string") {
    throw new ConfigurationError("OpenCode configuration field 'model' must be a string.");
  }
  if (config.$schema !== undefined && typeof config.$schema !== "string") {
    throw new ConfigurationError("OpenCode configuration field '$schema' must be a string.");
  }
  providerTable(config, "provider", false);
  providerTable(config, "providers", false);
}

export function hasOpenCodeProvider(source: string, providerId = OPENCODE_PROVIDER_ID): boolean {
  const config = parseOpenCodeJson(source);
  return (["provider", "providers"] as const).some((key) => {
    const table = providerTable(config, key, false);
    return table !== undefined && Object.hasOwn(table, providerId);
  });
}

export function mergeOpenCodeMapping(
  source: string,
  mapping: OpenCodeManagedMapping,
  options: { allowExistingProvider: boolean },
): string {
  const config = structuredClone(parseOpenCodeJson(source));
  assertTopLevelShape(config);
  const variant = configVariant(config);
  const key = tableKey(variant);
  const otherKey = tableKey(variant === "v1" ? "v2" : "v1");
  const table = providerTable(config, key, true)!;
  if (!options.allowExistingProvider && Object.hasOwn(table, OPENCODE_PROVIDER_ID)) {
    throw new ConfigurationError(
      "OpenCode already defines a 'krutrim' provider. Refusing to overwrite unmanaged configuration.",
    );
  }
  const otherTable = providerTable(config, otherKey, false);
  if (options.allowExistingProvider && otherTable !== undefined) {
    delete otherTable[OPENCODE_PROVIDER_ID];
    if (Object.keys(otherTable).length === 0) {
      delete config[otherKey];
    }
  }
  if (config.$schema === undefined) {
    config.$schema = OPENCODE_SCHEMA_URL;
  }
  config.model = `${OPENCODE_PROVIDER_ID}/${mapping.model}`;
  table[OPENCODE_PROVIDER_ID] = providerMapping(mapping, variant);
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function mappingMatchesOpenCode(source: string, mapping: OpenCodeManagedMapping): boolean {
  const config = parseOpenCodeJson(source);
  if (config.model !== `${OPENCODE_PROVIDER_ID}/${mapping.model}`) {
    return false;
  }
  return (["v1", "v2"] as const).some((variant) => {
    const table = providerTable(config, tableKey(variant), false);
    return table !== undefined &&
      isDeepStrictEqual(table[OPENCODE_PROVIDER_ID], providerMapping(mapping, variant));
  });
}

export function configuredOpenCodeModel(source: string): string | undefined {
  const config = parseOpenCodeJson(source);
  if (!hasOpenCodeProvider(source)) {
    return undefined;
  }
  return typeof config.model === "string" && config.model.startsWith(`${OPENCODE_PROVIDER_ID}/`)
    ? config.model.slice(`${OPENCODE_PROVIDER_ID}/`.length)
    : undefined;
}

export function rebaseOpenCodeRollbackSource(currentSource: string, baselineSource: string): string {
  const current = structuredClone(parseOpenCodeJson(currentSource));
  const baseline = parseOpenCodeJson(baselineSource);
  assertTopLevelShape(current);
  assertTopLevelShape(baseline);

  for (const key of ["provider", "providers"] as const) {
    const currentProviders = providerTable(current, key, false);
    if (currentProviders !== undefined) {
      delete currentProviders[OPENCODE_PROVIDER_ID];
      if (Object.keys(currentProviders).length === 0) {
        delete current[key];
      }
    }
  }

  if (Object.hasOwn(baseline, "model")) {
    current.model = structuredClone(baseline.model);
  } else {
    delete current.model;
  }
  if (Object.hasOwn(baseline, "$schema")) {
    current.$schema = structuredClone(baseline.$schema);
  } else if (current.$schema === OPENCODE_SCHEMA_URL) {
    delete current.$schema;
  }
  return `${JSON.stringify(current, null, 2)}\n`;
}
