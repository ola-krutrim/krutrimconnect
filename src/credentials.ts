import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import {
  validateKrutrimApiKey,
  type CredentialValidation,
  type PassedCredentialValidation,
} from "./auth.js";
import { withKrutrimCapabilityLock } from "./capabilities/krutrim.js";
import { ConfigurationError } from "./errors.js";
import { OpenCodeHarness } from "./harnesses/opencode.js";
import type { CodingToolHarness } from "./harnesses/types.js";
import type { RuntimePaths } from "./paths.js";
import type { RemovedSecretResult, StoredSecretResult } from "./secrets/types.js";
import { validateApiKey } from "./secrets/manager.js";
import { readState } from "./state.js";

const STATE_FILE = /^[a-f0-9]{64}\.json$/u;
const MAX_STATE_BYTES = 1024 * 1024;

export interface CredentialWriter {
  store(
    secret: string,
    allowFileFallback: boolean,
    validation: CredentialValidation,
  ): Promise<StoredSecretResult>;
}

export type CredentialValidator = (
  secret: string,
) => Promise<PassedCredentialValidation>;

export interface CredentialStoreOptions {
  skipValidation?: boolean;
  validator?: CredentialValidator;
}

export interface CredentialRemover {
  clear(): Promise<RemovedSecretResult>;
}

async function activeManagedConfig(
  appHome: string,
  registry: "codex" | "opencode",
): Promise<string | null> {
  const label = registry === "codex" ? "Codex" : "OpenCode";
  const stateDirectory = path.join(appHome, "state", registry);
  let directoryInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    directoryInfo = await lstat(stateDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new ConfigurationError(`${label} state registry is not a real directory: ${stateDirectory}`);
  }

  const entries = (await readdir(stateDirectory, { withFileTypes: true }))
    .filter((entry) => STATE_FILE.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const stateFile = path.join(stateDirectory, entry.name);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new ConfigurationError(`${label} state registry entry is not a regular file: ${stateFile}`);
    }
    const info = await lstat(stateFile);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_STATE_BYTES) {
      throw new ConfigurationError(`${label} state registry entry is unsafe: ${stateFile}`);
    }
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new ConfigurationError(`${label} state registry entry is group- or world-accessible: ${stateFile}`);
    }
    const state = await readState(stateFile);
    const configPath = registry === "codex"
      ? state.codex?.configPath ?? state.codexTransaction?.configPath
      : state.opencode?.configPath;
    if (configPath !== undefined) {
      if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
        throw new ConfigurationError(`${label} state registry entry has an invalid config path: ${stateFile}`);
      }
      return configPath;
    }
  }
  return null;
}

async function withCredentialMutationGuard<T>(
  paths: RuntimePaths,
  harness: Pick<CodingToolHarness, "status">,
  operation: () => Promise<T>,
): Promise<T> {
  // Credential-sensitive operations always take the capability lock first;
  // harness.status may then take Codex's config lock. `codex on` uses the same
  // ordering, avoiding deadlock while making credential mutation atomic with
  // evidence resolution and activation.
  return await withKrutrimCapabilityLock(paths, async () => {
    const openCode = await new OpenCodeHarness(paths).status();
    if (openCode.state !== "disconnected") {
      const remediation = openCode.state === "unmanaged"
        ? "Remove or migrate the unmanaged Krutrim OpenCode configuration first."
        : "Run krutrimconnect opencode off first (or krutrimconnect logout --disconnect); review drift before using --force.";
      throw new ConfigurationError(
        `Refusing to change the Krutrim credential while OpenCode global configuration is ${openCode.state}. ${remediation}`,
      );
    }
    const managedOpenCodeConfig = await activeManagedConfig(paths.appHome, "opencode");
    if (managedOpenCodeConfig !== null) {
      throw new ConfigurationError(
        `Refusing to change the Krutrim credential while managed OpenCode configuration is active at ${managedOpenCodeConfig}. Run krutrimconnect opencode off with that XDG_CONFIG_HOME first; review drift before using --force.`,
      );
    }
    const managedConfig = await activeManagedConfig(paths.appHome, "codex");
    if (managedConfig !== null) {
      throw new ConfigurationError(
        `Refusing to change the Krutrim credential while managed Codex configuration is active or has a pending transaction at ${managedConfig}. Run krutrimconnect codex off with that CODEX_HOME first; review drift before using --force.`,
      );
    }
    const status = await harness.status();
    if (status.state !== "disconnected") {
      const remediation = status.state === "unmanaged"
        ? "Remove or migrate the unmanaged Krutrim Codex configuration first."
        : "Run krutrimconnect codex off first (or krutrimconnect logout --disconnect); review drift before using --force.";
      throw new ConfigurationError(
        `Refusing to change the Krutrim credential while Codex base config is ${status.state}. ${remediation}`,
      );
    }
    return await operation();
  });
}

export async function storeKrutrimCredential(
  paths: RuntimePaths,
  harness: Pick<CodingToolHarness, "status">,
  credentials: CredentialWriter,
  secret: string,
  allowFileFallback: boolean,
  options: CredentialStoreOptions = {},
): Promise<StoredSecretResult> {
  return await withCredentialMutationGuard(
    paths,
    harness,
    async () => {
      validateApiKey(secret);
      const validation: CredentialValidation = options.skipValidation === true
        ? { status: "skipped" }
        : await (options.validator ?? validateKrutrimApiKey)(secret);
      return await credentials.store(
        secret,
        allowFileFallback,
        validation,
      );
    },
  );
}

export async function removeKrutrimCredential(
  paths: RuntimePaths,
  harness: Pick<CodingToolHarness, "status">,
  credentials: CredentialRemover,
): Promise<RemovedSecretResult> {
  return await withCredentialMutationGuard(paths, harness, async () => await credentials.clear());
}
