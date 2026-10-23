import path from "node:path";
import { ConfigurationError } from "../errors.js";
import { atomicWriteFile, ensurePrivateDirectory, removeFileDurably, sha256, pathExists, withFileLock } from "../fs/atomic.js";
import { withFileMutationObserver } from "../fs/mutations.js";
import type { RuntimePaths } from "../paths.js";
import { readConfigFile } from "../snapshots.js";
import type { BridgeRuntimeOwner, BridgeRuntimeStartResult } from "./runtime.js";

export interface ActivationRollbackEntry {
  target: string;
  before: { content: string; sha256: string | null; mode: number };
  after: (string | null)[];
}

export async function saveActivationRecovery(
  runtimeFile: string,
  instanceId: string,
  entries: ActivationRollbackEntry[],
): Promise<string> {
  const recoveryFile = `${runtimeFile}.${sha256(instanceId)}.recovery.json`;
  await ensurePrivateDirectory(path.dirname(runtimeFile));
  await atomicWriteFile(recoveryFile, JSON.stringify({ instanceId, entries }), { mode: 0o600 });
  return recoveryFile;
}

export async function restoreActivationFiles(entries: ActivationRollbackEntry[]): Promise<void> {
  const current = await Promise.all(entries.map(async (entry) => await readConfigFile(entry.target)));
  for (const [index, entry] of entries.entries()) {
    const hash = current[index]!.sha256;
    if (hash !== entry.before.sha256 && !entry.after.includes(hash)) {
      throw new ConfigurationError(`Configuration changed during bridge activation; refusing rollback: ${entry.target}`);
    }
  }
  for (const [index, entry] of entries.entries()) {
    if (current[index]!.sha256 === entry.before.sha256) continue;
    if (entry.before.sha256 === null) await removeFileDurably(entry.target, { expectedSha256: current[index]!.sha256 });
    else await atomicWriteFile(entry.target, Buffer.from(entry.before.content, "base64"), {
      mode: entry.before.mode, expectedSha256: current[index]!.sha256,
    });
  }
}

function activationTarget(paths: RuntimePaths, owner: BridgeRuntimeOwner, target: string): boolean {
  const targets = owner === "codex"
    ? [paths.codexConfig, paths.stateFile]
    : [paths.openCodeConfig, paths.openCodeStateFile, paths.openCodeBridgeCredentialFile];
  return targets.includes(target) || (owner === "codex" && path.dirname(target) === paths.codexModelCatalogDir);
}

function reusedJournal(paths: RuntimePaths, owner: BridgeRuntimeOwner): string {
  return `${owner === "codex" ? paths.codexBridgeRuntimeFile : paths.openCodeBridgeRuntimeFile}.activation.json`;
}

async function restoreActivationWithLock(
  paths: RuntimePaths,
  owner: BridgeRuntimeOwner,
  entries: ActivationRollbackEntry[],
): Promise<void> {
  const home = owner === "codex" ? paths.codexHome : paths.openCodeHome;
  if (await pathExists(home)) {
    await withFileLock(path.join(home, ".krutrim-connect.lock"), async () => await restoreActivationFiles(entries));
  } else await restoreActivationFiles(entries);
}

/** The capability lock must be held; a reused server is never made a guardian. */
export async function recoverReusedBridgeActivation(paths: RuntimePaths, owner: BridgeRuntimeOwner): Promise<void> {
  const journal = reusedJournal(paths, owner);
  const saved = await readConfigFile(journal);
  if (!saved.existed) return;
  const invalid = (): never => { throw new ConfigurationError(`Invalid bridge activation recovery data: ${journal}`); };
  if (saved.mode === undefined || (saved.mode & 0o077) !== 0) invalid();
  let value: { version?: unknown; entries?: unknown };
  try { value = JSON.parse(Buffer.from(saved.content).toString("utf8")) as typeof value; }
  catch { return invalid(); }
  if (value === null || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 128) invalid();
  const entries = value.entries as ActivationRollbackEntry[];
  const hash = (item: unknown): boolean => item === null || (typeof item === "string" && /^[0-9a-f]{64}$/u.test(item));
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || typeof entry.target !== "string" ||
        !activationTarget(paths, owner, entry.target) || path.resolve(entry.target) !== entry.target ||
        entry.before === null || typeof entry.before !== "object" ||
        typeof entry.before.content !== "string" || !hash(entry.before.sha256) ||
        !Number.isInteger(entry.before.mode) || entry.before.mode < 0 || entry.before.mode > 0o777 ||
        !Array.isArray(entry.after) || !entry.after.every(hash)) invalid();
    const content = Buffer.from(entry.before.content, "base64");
    if (content.toString("base64") !== entry.before.content ||
        (entry.before.sha256 === null ? content.length !== 0 : sha256(content) !== entry.before.sha256)) invalid();
  }
  await restoreActivationWithLock(paths, owner, entries);
  await removeFileDurably(journal);
}

/** Retain the previous connection until config and runtime publication commit. */
export async function activateBridge<T>(
  paths: RuntimePaths,
  owner: BridgeRuntimeOwner,
  runtime: BridgeRuntimeStartResult,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const entries = new Map<string, ActivationRollbackEntry>();
  const journal = reusedJournal(paths, owner);
  const controller = new AbortController();
  const cancel = (): void => { controller.abort(new ConfigurationError("Bridge activation was interrupted.")); };
  const check = (): void => { controller.signal.throwIfAborted(); };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const result = await withFileMutationObserver(async (target, afterSha256) => {
      check();
      if (!activationTarget(paths, owner, target)) return;
      let entry = entries.get(target);
      if (entry === undefined) {
        const before = await readConfigFile(target);
        entry = { target, before: { content: Buffer.from(before.content).toString("base64"), sha256: before.sha256, mode: before.mode ?? 0o600 }, after: [] };
        entries.set(target, entry);
      }
      if (!entry.after.includes(afterSha256)) entry.after.push(afterSha256);
      const locks = [path.join(paths.capabilityEvidenceDir, ".probe.lock")];
      if (owner === "codex" || entries.has(paths.openCodeConfig) || entries.has(paths.openCodeStateFile)) {
        locks.push(path.join(owner === "codex" ? paths.codexHome : paths.openCodeHome, ".krutrim-connect.lock"));
      }
      if (runtime.started) await runtime.prepareRollback([...entries.values()], locks);
      else {
        // Durable write-ahead recovery without attaching a lease to someone
        // else's live server. A later activation recovers after abrupt exit.
        await atomicWriteFile(journal, JSON.stringify({ version: 1, entries: [...entries.values()] }), { mode: 0o600 });
      }
      check();
    }, async () => await operation(controller.signal));
    check();
    await runtime.commit();
    if (!runtime.started) await removeFileDurably(journal);
    return result;
  } catch (error) {
    try {
      await restoreActivationWithLock(paths, owner, [...entries.values()]);
      if (!runtime.started) await removeFileDurably(journal);
    } catch (restoreError) {
      const runtimeFile = owner === "codex" ? paths.codexBridgeRuntimeFile : paths.openCodeBridgeRuntimeFile;
      const recoveryFile = await saveActivationRecovery(runtimeFile, runtime.record.instanceId, [...entries.values()]);
      throw new ConfigurationError(`Bridge activation rollback needs review. Recovery data: ${recoveryFile}`, { cause: restoreError });
    } finally { await runtime.abort(); }
    throw error;
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
