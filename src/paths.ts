import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { ConfigurationError } from "./errors.js";

export interface RuntimePaths {
  appHome: string;
  codexHome: string;
  codexConfig: string;
  stateFile: string;
  snapshotsDir: string;
  openCodeHome: string;
  openCodeConfig: string;
  openCodeJsoncConfig: string;
  openCodeStateFile: string;
  openCodeSnapshotsDir: string;
  fallbackSecretFile: string;
  credentialBackendFile: string;
  capabilityEvidenceDir: string;
  bridgeEvidenceDir: string;
  /** Legacy singleton bridge state retained only for safe upgrade migration. */
  bridgeRuntimeFile: string;
  codexBridgeRuntimeFile: string;
  openCodeBridgeRuntimeFile: string;
  openCodeBridgeCredentialFile: string;
  codexModelCatalogDir: string;
}

function requireSafeAbsoluteDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new ConfigurationError(`${label} must be an absolute path.`);
  }
  const normalized = path.normalize(value);
  if (normalized === path.parse(normalized).root) {
    throw new ConfigurationError(`${label} must not be a filesystem root.`);
  }
  return normalized;
}

function defaultAppHome(env: NodeJS.ProcessEnv, home: string): string {
  if (env.KRUTRIM_CONNECT_HOME) {
    return requireSafeAbsoluteDirectory(env.KRUTRIM_CONNECT_HOME, "KRUTRIM_CONNECT_HOME");
  }
  if (process.platform === "win32" && env.APPDATA) {
    return path.join(env.APPDATA, "krutrim-connect");
  }
  if (env.XDG_CONFIG_HOME) {
    return path.join(env.XDG_CONFIG_HOME, "krutrim-connect");
  }
  return path.join(home, ".config", "krutrim-connect");
}

export function resolveRuntimePaths(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): RuntimePaths {
  const safeHome = requireSafeAbsoluteDirectory(home, "Home directory");
  const appHome = requireSafeAbsoluteDirectory(defaultAppHome(env, safeHome), "Application home");
  const codexHome = env.CODEX_HOME
    ? requireSafeAbsoluteDirectory(env.CODEX_HOME, "CODEX_HOME")
    : path.join(safeHome, ".codex");

  const codexConfig = path.join(codexHome, "config.toml");
  const stateFile = stateFileForCodexConfig(appHome, codexConfig);
  const configHome = env.XDG_CONFIG_HOME
    ? requireSafeAbsoluteDirectory(env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME")
    : path.join(safeHome, ".config");
  const openCodeHome = path.join(configHome, "opencode");
  const openCodeConfig = path.join(openCodeHome, "opencode.json");
  return {
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
}

export function stateFileForCodexConfig(appHome: string, codexConfig: string): string {
  const configKey = createHash("sha256").update(path.resolve(codexConfig)).digest("hex");
  return path.join(appHome, "state", "codex", `${configKey}.json`);
}

export function stateFileForOpenCodeConfig(appHome: string, openCodeConfig: string): string {
  const configKey = createHash("sha256").update(path.resolve(openCodeConfig)).digest("hex");
  return path.join(appHome, "state", "opencode", `${configKey}.json`);
}
