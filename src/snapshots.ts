import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigurationError } from "./errors.js";
import { atomicWriteFile, ensurePrivateDirectory, sha256 } from "./fs/atomic.js";

export interface SnapshotRecord {
  path: string;
  sha256: string;
  existed: boolean;
  mode?: number;
  createdAt: string;
  reason: "pre-connect" | "pre-update" | "pre-restore-drift";
}

export interface ConfigFileRecord {
  existed: boolean;
  content: Buffer;
  sha256: string | null;
  mode?: number;
}

export async function readConfigFile(configPath: string): Promise<ConfigFileRecord> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { existed: false, content: Buffer.alloc(0), sha256: null };
    }
    throw error;
  }

  if (info.isSymbolicLink()) {
    throw new ConfigurationError(`Refusing to modify symlinked Codex config: ${configPath}`);
  }
  if (!info.isFile()) {
    throw new ConfigurationError(`Codex config is not a regular file: ${configPath}`);
  }

  const content = await readFile(configPath);
  return {
    existed: true,
    content,
    sha256: sha256(content),
    mode: info.mode & 0o777,
  };
}

function timestampForFilename(date: Date): string {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export async function createSnapshot(
  configPath: string,
  snapshotsDir: string,
  reason: SnapshotRecord["reason"],
  current?: ConfigFileRecord,
): Promise<SnapshotRecord> {
  const record = current ?? (await readConfigFile(configPath));
  const now = new Date();
  await ensurePrivateDirectory(snapshotsDir);
  const snapshotPath = path.join(
    snapshotsDir,
    `config.toml.${timestampForFilename(now)}.${reason}.${randomUUID().slice(0, 8)}.bak`,
  );
  await atomicWriteFile(snapshotPath, record.content, { mode: 0o600, expectedSha256: null });

  const snapshot: SnapshotRecord = {
    path: snapshotPath,
    sha256: sha256(record.content),
    existed: record.existed,
    createdAt: now.toISOString(),
    reason,
  };
  if (record.mode !== undefined) {
    snapshot.mode = record.mode;
  }
  return snapshot;
}

export async function readVerifiedSnapshot(snapshot: SnapshotRecord): Promise<Buffer> {
  let content: Buffer;
  try {
    content = await readFile(snapshot.path);
  } catch (error) {
    throw new ConfigurationError(`Cannot read required snapshot ${snapshot.path}.`, { cause: error });
  }
  if (sha256(content) !== snapshot.sha256) {
    throw new ConfigurationError(`Snapshot integrity check failed for ${snapshot.path}.`);
  }
  return content;
}
