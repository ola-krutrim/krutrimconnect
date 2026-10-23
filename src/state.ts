import { readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigurationError } from "./errors.js";
import { atomicWriteFile, ensurePrivateDirectory } from "./fs/atomic.js";
import type { SnapshotRecord } from "./snapshots.js";

export interface CodexConnectionRecord {
  providerId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  configPath: string;
  baseline: SnapshotRecord;
  connectedSha256: string;
  activatedAt: string;
  helperCommand: string;
  helperArgs: string[];
  /** Added after the initial state schema; optional only for safe legacy migration. */
  modelCatalogPath?: string;
  /** Added after the initial state schema; optional only for safe legacy migration. */
  modelCatalogSha256?: string;
  /** Krutrim-advertised context window captured when the managed catalog was written. */
  modelContextWindow?: number;
  safetySnapshots: SnapshotRecord[];
}

export interface CodexTransactionRecord {
  id: string;
  operation: "enable" | "update" | "disable";
  preparedAt: string;
  configPath: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  previousCodex?: CodexConnectionRecord;
  nextCodex?: CodexConnectionRecord;
}

export interface OpenCodeConnectionRecord {
  providerId: string;
  providerName: string;
  baseUrl: string;
  model: string;
  configPath: string;
  baseline: SnapshotRecord;
  connectedSha256: string;
  activatedAt: string;
  /** Present for launch-ready connections; absent only for legacy env-token state. */
  credentialFile?: string;
  safetySnapshots: SnapshotRecord[];
}

export interface AppState {
  version: 1;
  codex?: CodexConnectionRecord;
  codexTransaction?: CodexTransactionRecord;
  opencode?: OpenCodeConnectionRecord;
}

export async function readState(stateFile: string): Promise<AppState> {
  let source: string;
  try {
    source = await readFile(stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1 };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(source) as Partial<AppState>;
    if (
      parsed.version !== 1 ||
      (parsed.codex !== undefined && typeof parsed.codex !== "object") ||
      (parsed.codexTransaction !== undefined && typeof parsed.codexTransaction !== "object") ||
      (parsed.opencode !== undefined && typeof parsed.opencode !== "object")
    ) {
      throw new Error("Unsupported or invalid state schema");
    }
    return parsed as AppState;
  } catch (error) {
    throw new ConfigurationError(`Cannot parse KrutrimConnect state at ${stateFile}.`, { cause: error });
  }
}

export async function writeState(stateFile: string, appHome: string, state: AppState): Promise<void> {
  await ensurePrivateDirectory(appHome);
  await ensurePrivateDirectory(path.dirname(stateFile));
  await atomicWriteFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
