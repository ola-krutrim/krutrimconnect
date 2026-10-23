import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigurationError } from "../errors.js";
import { atomicWriteFile, ensurePrivateDirectory, removeFileDurably, withFileLock } from "../fs/atomic.js";
import type { RuntimePaths } from "../paths.js";
import { restoreActivationFiles, saveActivationRecovery, type ActivationRollbackEntry } from "./activation.js";
import { BRIDGE_RUNTIME_CONTRACT, startBridgeServer } from "./server.js";

export interface BridgeRuntimeRecord {
  version: 1;
  instanceId: string;
  controlToken: string;
  pid: number;
  host: "127.0.0.1";
  port: number;
  model: string;
  startedAt: string;
}

export interface BridgeRuntimeStartResult {
  record: BridgeRuntimeRecord;
  started: boolean;
  previous?: BridgeRuntimeRecord;
  commit(): Promise<void>;
  abort(): Promise<void>;
  prepareRollback(entries: ActivationRollbackEntry[], locks: string[]): Promise<void>;
}

const MAX_RUNTIME_BYTES = 16 * 1024;
export type BridgeRuntimeOwner = "codex" | "opencode";

export function bridgeRuntimeFileFor(
  paths: RuntimePaths,
  owner: BridgeRuntimeOwner,
): string {
  return owner === "codex"
    ? paths.codexBridgeRuntimeFile
    : paths.openCodeBridgeRuntimeFile;
}

export async function readBridgeRuntimeForOwner(
  paths: RuntimePaths,
  owner: BridgeRuntimeOwner,
): Promise<BridgeRuntimeRecord | null> {
  const owned = await readBridgeRuntime(bridgeRuntimeFileFor(paths, owner));
  return owned ?? await readBridgeRuntime(paths.bridgeRuntimeFile);
}

function parseRecord(source: string, target: string): BridgeRuntimeRecord {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigurationError(`Cannot parse local bridge runtime state at ${target}.`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`Local bridge runtime state is invalid at ${target}.`);
  }
  const candidate = value as Partial<BridgeRuntimeRecord>;
  if (
    candidate.version !== 1 ||
    typeof candidate.instanceId !== "string" ||
    candidate.instanceId.length === 0 ||
    typeof candidate.controlToken !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.controlToken) ||
    typeof candidate.pid !== "number" ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid < 1 ||
    candidate.host !== "127.0.0.1" ||
    typeof candidate.port !== "number" ||
    !Number.isSafeInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65535 ||
    typeof candidate.model !== "string" ||
    candidate.model.length === 0 ||
    typeof candidate.startedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.startedAt))
  ) {
    throw new ConfigurationError(`Local bridge runtime state is invalid at ${target}.`);
  }
  return candidate as BridgeRuntimeRecord;
}

export async function readBridgeRuntime(
  runtimeFile: string,
): Promise<BridgeRuntimeRecord | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(runtimeFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ConfigurationError(`Local bridge runtime path is not a regular file: ${runtimeFile}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new ConfigurationError(`Local bridge runtime state is group- or world-accessible: ${runtimeFile}`);
  }
  if (info.size > MAX_RUNTIME_BYTES) {
    throw new ConfigurationError(`Local bridge runtime state is unexpectedly large: ${runtimeFile}`);
  }
  return parseRecord(await readFile(runtimeFile, "utf8"), runtimeFile);
}

async function writeRuntime(runtimeFile: string, record: BridgeRuntimeRecord): Promise<void> {
  await ensurePrivateDirectory(path.dirname(runtimeFile));
  await atomicWriteFile(runtimeFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function bridgeBaseUrl(record: BridgeRuntimeRecord): string {
  return `http://${record.host}:${record.port}/v1`;
}

async function bridgeHealth(record: BridgeRuntimeRecord): Promise<"unhealthy" | "pending" | "committed" | "legacy"> {
  try {
    const response = await fetch(`http://${record.host}:${record.port}/health`, {
      method: "GET",
      redirect: "manual",
      headers: { "X-Krutrim-Connect-Instance": record.controlToken },
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      return "unhealthy";
    }
    const value = await response.json() as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        !("model" in value) || value.model !== record.model ||
        !("contract" in value) || value.contract !== BRIDGE_RUNTIME_CONTRACT) return "unhealthy";
    if (!("activationCommitted" in value)) return "legacy";
    if (value.activationCommitted === true) return "committed";
    if (value.activationCommitted === false) return "pending";
    return "unhealthy";
  } catch {
    return "unhealthy";
  }
}

export async function bridgeIsHealthy(record: BridgeRuntimeRecord, requireCommitted = false): Promise<boolean> {
  const health = await bridgeHealth(record);
  return requireCommitted ? health === "committed" : health !== "unhealthy";
}

/**
 * Claims a healthy pre-partition singleton runtime for one harness. Callers
 * must first establish that the other harness is not relying on it.
 */
export async function adoptLegacyBridgeRuntime(
  paths: RuntimePaths,
  owner: BridgeRuntimeOwner,
): Promise<BridgeRuntimeRecord | null> {
  const runtimeFile = bridgeRuntimeFileFor(paths, owner);
  const existing = await readBridgeRuntime(runtimeFile);
  if (existing !== null) {
    return existing;
  }
  const legacy = await readBridgeRuntime(paths.bridgeRuntimeFile);
  if (legacy === null || !(await bridgeIsHealthy(legacy))) {
    return null;
  }
  await writeRuntime(runtimeFile, legacy);
  const currentLegacy = await readBridgeRuntime(paths.bridgeRuntimeFile).catch(() => null);
  if (currentLegacy?.instanceId === legacy.instanceId) {
    await removeFileDurably(paths.bridgeRuntimeFile);
  }
  return legacy;
}

export async function startBridgeRuntime(
  paths: RuntimePaths,
  cliEntrypoint: string,
  owner: BridgeRuntimeOwner,
  model: string,
  options: { startupTimeoutMs?: number } = {},
): Promise<BridgeRuntimeStartResult> {
  const runtimeFile = bridgeRuntimeFileFor(paths, owner);
  const existing = await readBridgeRuntime(runtimeFile);
  const health = existing === null ? "unhealthy" : await bridgeHealth(existing);
  // A visible canonical record may still be awaiting directory fsync. Neither
  // reuse nor replacement may mutate its activation while the outcome is pending.
  if (health === "pending") {
    throw new ConfigurationError("Local bridge activation is pending. Retry after it completes.");
  }
  const existingHealthy = existing !== null && health !== "unhealthy";
  if (existingHealthy && existing.model === model) {
    return { record: existing, started: false, commit: async () => {}, abort: async () => {}, prepareRollback: async () => {} };
  }
  const instanceId = randomUUID();
  // Keep IPC referenced until activation commits. EOF is a lease revocation,
  // including when the parent is killed before a runtime record exists.
  const child = spawn(
    process.execPath,
    [
      cliEntrypoint,
      "_bridge",
      "serve",
      "--owner",
      owner,
      "--model",
      model,
      "--instance",
      instanceId,
      "--app-home",
      paths.appHome,
    ],
    {
      detached: process.platform !== "win32",
      env: { ...process.env, KRUTRIM_CONNECT_BRIDGE_LEASE: instanceId },
      shell: false,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.on("error", () => { if (child.pid === undefined) resolve(); });
  });
  const waitFor = (type: string): Promise<unknown> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new ConfigurationError(
      "The local Responses-to-Chat bridge did not become healthy.",
    )), options.startupTimeoutMs ?? 60_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener("message", message);
      child.removeListener("error", fail);
      child.removeListener("exit", exit);
      child.removeListener("disconnect", exit);
    };
    const fail = (error: Error): void => { cleanup(); reject(error); };
    const exit = (): void => fail(new ConfigurationError("The local bridge exited before activation completed."));
    const message = (value: unknown): void => {
      if (value !== null && typeof value === "object" &&
          "type" in value && value.type === type &&
          "instanceId" in value && value.instanceId === instanceId) {
        cleanup();
        resolve(value);
      }
    };
    child.on("message", message);
    child.once("error", fail);
    child.once("exit", exit);
    child.once("disconnect", exit);
  });
  let committed = false;
  const abort = async (): Promise<void> => {
    if (!committed && child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: "abort", instanceId }, (error) => {
        if (error) child.kill("SIGTERM");
      });
      else child.kill("SIGTERM");
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 1_000);
      try { await exited; } finally { clearTimeout(escalation); }
    }
  };
  let record: BridgeRuntimeRecord;
  try {
    const ready = await waitFor("ready") as { record: BridgeRuntimeRecord };
    record = parseRecord(JSON.stringify(ready.record), "child IPC");
    if (record.instanceId !== instanceId || record.pid !== child.pid || !(await bridgeIsHealthy(record))) {
      throw new ConfigurationError("The local bridge returned invalid startup information.");
    }
  } catch (error) {
    await abort();
    throw error;
  }
  return {
    record,
    started: true,
    ...(existing === null ? {} : { previous: existing }),
    abort,
    async prepareRollback(entries, locks) {
      const acknowledged = waitFor("prepared");
      child.send({ type: "prepare", instanceId, entries, locks }, (error) => {
        if (error) child.emit("error", error);
      });
      await acknowledged;
    },
    async commit() {
      const acknowledged = waitFor("committed");
      child.send({ type: "commit", instanceId, previous: existingHealthy ? existing : undefined }, (error) => {
        if (error) child.emit("error", error);
      });
      try { await acknowledged; }
      catch (error) {
        // Visibility after rename is not a commit outcome. The authenticated
        // child reports completion only after directory fsync. Once commit has
        // been accepted, wait for its outcome rather than racing rollback with
        // publication (including when the acknowledgement was lost).
        while (!(await bridgeIsHealthy(record, true))) {
          if (child.exitCode !== null || child.signalCode !== null) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      committed = true;
      child.unref();
    },
  };
}

export async function stopBridgeRuntime(
  runtimeFile: string,
  explicitRecord?: BridgeRuntimeRecord,
): Promise<boolean> {
  const record = explicitRecord ?? await readBridgeRuntime(runtimeFile);
  if (record === null) {
    return false;
  }
  // A responder that fails the authenticated health check is not our bridge;
  // never send it a shutdown request or disclose the control token.
  if (await bridgeHealth(record) === "unhealthy") {
    const current = await readBridgeRuntime(runtimeFile).catch(() => null);
    if (current?.instanceId === record.instanceId) {
      await removeFileDurably(runtimeFile);
    }
    return true;
  }
  try {
    const response = await fetch(`http://${record.host}:${record.port}/shutdown`, {
      method: "POST",
      redirect: "manual",
      headers: { "X-Krutrim-Connect-Shutdown": record.controlToken },
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) {
      throw new ConfigurationError("The local bridge rejected its authenticated shutdown request.");
    }
  } catch (error) {
    if (await bridgeIsHealthy(record)) {
      throw new ConfigurationError("Could not stop the active local bridge safely.", { cause: error });
    }
  }
  const current = await readBridgeRuntime(runtimeFile).catch(() => null);
  if (current?.instanceId === record.instanceId) {
    await removeFileDurably(runtimeFile);
  }
  return true;
}

export async function restoreBridgeRuntimeRecord(
  runtimeFile: string,
  record: BridgeRuntimeRecord | undefined,
): Promise<void> {
  if (record !== undefined && await bridgeIsHealthy(record)) {
    await writeRuntime(runtimeFile, record);
  }
}

export async function serveBridgeRuntime(
  runtimeFile: string,
  model: string,
  instanceId: string,
  apiKey: string | (() => Promise<string>),
): Promise<void> {
  const leased = process.env.KRUTRIM_CONNECT_BRIDGE_LEASE === instanceId;
  let committed = !leased;
  let cancelled = false;
  let started: Awaited<ReturnType<typeof startBridgeServer>> | undefined;
  let publication: Promise<void> | undefined;
  let rollback: { entries: ActivationRollbackEntry[]; locks: string[] } | undefined;
  let parentLost = false;
  let previous: BridgeRuntimeRecord | undefined;
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => { finish = resolve; });
  const stop = (): void => {
    cancelled = true;
    // A credential backend can be awaiting native approval with live handles.
    if (leased && started === undefined) process.exit(1);
    finish();
  };
  const disconnected = (): void => {
    parentLost = true;
    if (!committed && publication === undefined) stop();
  };
  let commit: (message: unknown) => void = () => {};
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (leased) process.once("disconnect", disconnected);
  try {
    if (leased && !process.connected) {
      stop();
      return;
    }
    const credential = typeof apiKey === "string" ? apiKey : await apiKey();
    if (cancelled) return;
    const controlToken = randomBytes(32).toString("hex");
    started = await startBridgeServer({
      model, instanceId, controlToken, apiKey: credential, onShutdown: finish,
      activationCommitted: () => committed,
    });
    if (cancelled) return;
    const record: BridgeRuntimeRecord = {
      version: 1, instanceId, controlToken, pid: process.pid,
      host: "127.0.0.1", port: started.port, model,
      startedAt: new Date().toISOString(),
    };
    commit = (message: unknown): void => {
      if (cancelled || publication !== undefined || message === null || typeof message !== "object" ||
          !("type" in message) || !("instanceId" in message) || message.instanceId !== instanceId) return;
      if (message.type === "abort") { rollback = undefined; stop(); return; }
      if (message.type === "prepare" && "entries" in message && "locks" in message) {
        rollback = message as typeof rollback;
        process.send?.({ type: "prepared", instanceId }, (error) => { if (error) stop(); });
        return;
      }
      if (message.type !== "commit") return;
      if ("previous" in message && message.previous !== undefined) {
        previous = parseRecord(JSON.stringify(message.previous), "child IPC");
      }
      // Accepting commit ends cancellation: finish publication and retirement
      // even if the parent disappears before the acknowledgement arrives.
      publication = writeRuntime(runtimeFile, record).then(async () => {
        committed = true;
        const retiring = previous;
        if (retiring !== undefined && retiring.instanceId !== instanceId) {
          await stopBridgeRuntime(runtimeFile, retiring).catch(async () => {
            await writeRuntime(`${runtimeFile}.${instanceId}.retired.json`, retiring).catch(() => undefined);
          });
        }
        if (process.connected) {
          process.send?.({ type: "committed", instanceId }, () => {
            if (process.connected) process.disconnect?.();
          });
        }
      }).catch(() => stop());
    };
    if (!leased) await writeRuntime(runtimeFile, record);
    else {
      process.on("message", commit);
      process.send?.({ type: "ready", instanceId, record }, (error) => { if (error) stop(); });
    }
    await stopped;
  } finally {
    await publication;
    if (!committed) started?.server.closeAllConnections();
    await started?.close();
    if (parentLost && !committed && rollback !== undefined) {
      const saved = rollback;
      const restore = async (index: number): Promise<void> => {
        const lock = saved.locks[index];
        if (lock === undefined) await restoreActivationFiles(saved.entries);
        else await withFileLock(lock, async () => await restore(index + 1));
      };
      await restore(0).catch(async () => {
        // Preserve recovery data if a concurrent edit or I/O error blocks rollback.
        await saveActivationRecovery(runtimeFile, instanceId, saved.entries).catch(() => undefined);
      });
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("disconnect", disconnected);
    process.removeListener("message", commit);
    const current = await readBridgeRuntime(runtimeFile).catch(() => null);
    if (current?.instanceId === instanceId) {
      if (!committed && previous !== undefined && await bridgeIsHealthy(previous)) {
        await writeRuntime(runtimeFile, previous);
      } else await removeFileDurably(runtimeFile).catch(() => undefined);
    }
    if (leased && process.connected) process.disconnect?.();
  }
}
