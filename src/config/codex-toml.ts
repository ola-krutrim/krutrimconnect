import { isDeepStrictEqual } from "node:util";

import { parse, patch, TomlFormat } from "@decimalturn/toml-patch";

import { ConfigurationError } from "../errors.js";

export const CODEX_PROVIDER_ID = "krutrim";

export interface CredentialHelperConfig {
  command: string;
  args: string[];
}

export interface CodexManagedMapping {
  model: string;
  providerId: string;
  displayName: string;
  baseUrl: string;
  modelCatalogPath: string;
  helper: CredentialHelperConfig;
}

type TomlObject = Record<string, unknown>;

function isObject(value: unknown): value is TomlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCodexToml(source: string): TomlObject {
  if (source.length === 0) {
    return {};
  }
  try {
    const parsed = parse(source, { integersAsBigInt: "asNeeded" }) as unknown;
    if (!isObject(parsed)) {
      throw new Error("TOML root is not a table");
    }
    return parsed;
  } catch (error) {
    throw new ConfigurationError("Codex config is not valid TOML.", { cause: error });
  }
}

function providerTable(mapping: CodexManagedMapping): TomlObject {
  return {
    name: mapping.displayName,
    base_url: mapping.baseUrl,
    wire_api: "responses",
    supports_websockets: false,
    auth: {
      command: mapping.helper.command,
      args: mapping.helper.args,
      timeout_ms: 60000,
      refresh_interval_ms: 0,
    },
  };
}

function comparable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(comparable);
  }
  if (value instanceof Date) {
    return { $tomlDate: value.toISOString() };
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, comparable(child)]));
  }
  return value;
}

function tomlDeepEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(comparable(left), comparable(right));
}

function withoutManagedValues(value: TomlObject, providerId: string): TomlObject {
  const copy = structuredClone(value);
  delete copy.model;
  delete copy.model_provider;
  delete copy.model_catalog_json;

  if (isObject(copy.model_providers)) {
    delete copy.model_providers[providerId];
    if (Object.keys(copy.model_providers).length === 0) {
      delete copy.model_providers;
    }
  }
  return copy;
}

function getProviderTable(config: TomlObject, providerId: string): TomlObject | undefined {
  if (!isObject(config.model_providers)) {
    return undefined;
  }
  const provider = config.model_providers[providerId];
  return isObject(provider) ? provider : undefined;
}

function hasProviderKey(config: TomlObject, providerId: string): boolean {
  if (!Object.hasOwn(config, "model_providers")) {
    return false;
  }
  if (!isObject(config.model_providers)) {
    return true;
  }
  return Object.hasOwn(config.model_providers, providerId);
}

function copyManagedValue(
  target: TomlObject,
  baseline: TomlObject,
  key: "model" | "model_provider" | "model_catalog_json",
): void {
  if (Object.hasOwn(baseline, key)) {
    target[key] = structuredClone(baseline[key]);
  } else {
    delete target[key];
  }
}

function managedValues(value: TomlObject, providerId: string): TomlObject {
  const result: TomlObject = {};
  for (const key of ["model", "model_provider", "model_catalog_json"] as const) {
    if (Object.hasOwn(value, key)) {
      result[key] = structuredClone(value[key]);
    }
  }
  const provider = getProviderTable(value, providerId);
  if (provider !== undefined) {
    result.provider = structuredClone(provider);
  }
  return result;
}

export function hasProviderCollision(source: string, providerId = CODEX_PROVIDER_ID): boolean {
  return hasProviderKey(parseCodexToml(source), providerId);
}

export function mappingMatches(source: string, mapping: CodexManagedMapping): boolean {
  const parsed = parseCodexToml(source);
  return (
    parsed.model === mapping.model &&
    parsed.model_provider === mapping.providerId &&
    parsed.model_catalog_json === mapping.modelCatalogPath &&
    tomlDeepEqual(getProviderTable(parsed, mapping.providerId), providerTable(mapping))
  );
}

export function configuredKrutrimModel(source: string): string | undefined {
  const parsed = parseCodexToml(source);
  return parsed.model_provider === CODEX_PROVIDER_ID && typeof parsed.model === "string"
    ? parsed.model
    : undefined;
}

export function mergeCodexMapping(
  source: string,
  mapping: CodexManagedMapping,
  options: { allowExistingProvider: boolean },
): string {
  const original = parseCodexToml(source);
  if (!options.allowExistingProvider && hasProviderKey(original, mapping.providerId)) {
    throw new ConfigurationError(
      `Codex already contains an unmanaged model_providers.${mapping.providerId} table; refusing to overwrite it.`,
    );
  }
  if (options.allowExistingProvider && !getProviderTable(original, mapping.providerId)) {
    throw new ConfigurationError(
      `Managed model_providers.${mapping.providerId} is missing or is not a table; refusing to overwrite it.`,
    );
  }

  const updated = parseCodexToml(source);
  updated.model = mapping.model;
  updated.model_provider = mapping.providerId;
  updated.model_catalog_json = mapping.modelCatalogPath;
  const providers = isObject(updated.model_providers) ? updated.model_providers : {};
  updated.model_providers = providers;
  providers[mapping.providerId] = providerTable(mapping);

  let result: string;
  try {
    const format = TomlFormat.autoDetectFormat(source);
    format.inlineTableStart = 3;
    result = patch(source, updated, format);
  } catch (error) {
    throw new ConfigurationError("Could not safely patch the Codex TOML document.", { cause: error });
  }
  const reparsed = parseCodexToml(result);
  if (!mappingMatches(result, mapping)) {
    throw new ConfigurationError("The patched Codex config does not contain the requested provider mapping.");
  }
  if (
    !tomlDeepEqual(
      withoutManagedValues(original, mapping.providerId),
      withoutManagedValues(reparsed, mapping.providerId),
    )
  ) {
    throw new ConfigurationError("The TOML patch changed unrelated Codex configuration; no file was written.");
  }
  return result;
}

/**
 * Preserve the current document's unrelated settings while restoring only the
 * values owned by KrutrimConnect from its verified pre-connect baseline.
 */
export function rebaseCodexRollbackSource(
  currentSource: string,
  baselineSource: string,
  providerId = CODEX_PROVIDER_ID,
): string {
  const current = parseCodexToml(currentSource);
  const baseline = parseCodexToml(baselineSource);
  const updated = withoutManagedValues(current, providerId);
  copyManagedValue(updated, baseline, "model");
  copyManagedValue(updated, baseline, "model_provider");
  copyManagedValue(updated, baseline, "model_catalog_json");

  const baselineProvider = getProviderTable(baseline, providerId);
  if (baselineProvider !== undefined) {
    const providers = isObject(updated.model_providers)
      ? updated.model_providers
      : {};
    providers[providerId] = structuredClone(baselineProvider);
    updated.model_providers = providers;
  }

  let result: string;
  try {
    const format = TomlFormat.autoDetectFormat(currentSource || baselineSource);
    format.inlineTableStart = 3;
    // Start from the verified pre-connect document. It cannot contain the
    // managed provider collision, so the patcher never has to delete an
    // entire managed table from the middle of the current TOML document.
    result = patch(baselineSource, updated, format);
  } catch (error) {
    throw new ConfigurationError("Could not safely rebase the Codex rollback document.", {
      cause: error,
    });
  }
  const reparsed = parseCodexToml(result);
  if (
    !tomlDeepEqual(
      withoutManagedValues(current, providerId),
      withoutManagedValues(reparsed, providerId),
    ) ||
    !tomlDeepEqual(
      managedValues(baseline, providerId),
      managedValues(reparsed, providerId),
    )
  ) {
    throw new ConfigurationError(
      "Rebasing rollback state changed unrelated Codex configuration; no file was written.",
    );
  }
  return result;
}
