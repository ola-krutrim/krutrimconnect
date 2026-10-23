import { randomUUID, createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { tryLock, unlock } from "fs-native-extensions";

import { AtomicWriteError, ConfigurationError } from "../errors.js";
import { beforeFileMutation } from "./mutations.js";

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  const missing: string[] = [];
  let cursor = path.resolve(directory);

  while (true) {
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ConfigurationError(`Private directory path is not a real directory: ${cursor}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      missing.unshift(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw new ConfigurationError(`Cannot find an existing parent for private directory ${directory}.`);
      }
      cursor = parent;
    }
  }

  for (const child of missing) {
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const info = await lstat(child);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ConfigurationError(`Private directory path is not a real directory: ${child}`);
      }
    }
    await chmod(child, 0o700);
    await syncDirectory(child);
    await syncDirectory(path.dirname(child));
  }

  await chmod(path.resolve(directory), 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export interface AtomicWriteOptions {
  mode?: number;
  expectedSha256?: string | null;
}

export async function atomicWriteFile(
  target: string,
  content: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = path.dirname(target);
  const targetMode = options.mode ?? 0o600;
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let committed = false;
  try {
    handle = await open(temporary, "wx", targetMode);
    await handle.chmod(targetMode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;

    await beforeFileMutation(target, sha256(content));
    if (options.expectedSha256 !== undefined) {
      let currentHash: string | null = null;
      try {
        currentHash = sha256(await readFile(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      if (currentHash !== options.expectedSha256) {
        throw new ConfigurationError(
          `Refusing to replace ${target} because it changed after it was read. Retry the command.`,
        );
      }
    }

    await rename(temporary, target);
    committed = true;
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (!committed) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    throw new AtomicWriteError(
      `File replacement completed but its parent directory could not be synchronized: ${target}`,
      true,
      { cause: error },
    );
  }
}

export async function fileMode(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

export async function removeFileDurably(target: string, options: { expectedSha256?: string | null } = {}): Promise<void> {
  await beforeFileMutation(target, null);
  const maximumAttempts = process.platform === "win32" ? 20 : 1;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      if (options.expectedSha256 !== undefined) {
        let currentHash: string | null = null;
        try { currentHash = sha256(await readFile(target)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (currentHash !== options.expectedSha256) {
          throw new ConfigurationError(`Refusing to remove ${target} because it changed after it was read. Retry the command.`);
        }
      }
      await unlink(target);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return;
      }
      const retryable = code === "EBUSY" || code === "EPERM" || code === "EACCES";
      if (!retryable || attempt === maximumAttempts) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    await syncDirectory(path.dirname(target));
  } catch (error) {
    throw new AtomicWriteError(
      `File removal completed but its parent directory could not be synchronized: ${target}`,
      true,
      { cause: error },
    );
  }
}

async function acquireNativeExclusiveLock(fileDescriptor: number, lockPath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    if (tryLock(fileDescriptor)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new ConfigurationError(
        `Another KrutrimConnect operation still holds the OS lock at ${lockPath}.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 50)));
  }
}

export async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  try {
    const existing = await lstat(lockPath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new ConfigurationError(`Lock path is not a regular file: ${lockPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const noFollow = process.platform === "win32" ? 0 : fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow, 0o600);
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw new ConfigurationError(`Lock path is not a regular file: ${lockPath}`);
    }
    await handle.chmod(0o600);
    await acquireNativeExclusiveLock(handle.fd, lockPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw new ConfigurationError(`Could not acquire the KrutrimConnect lock at ${lockPath}.`, {
      cause: error,
    });
  }
  const lockedHandle = handle;

  let operationError: unknown;
  let result: T | undefined;
  try {
    result = await operation();
  } catch (error) {
    operationError = error;
  } finally {
    let unlockError: unknown;
    try {
      unlock(lockedHandle.fd);
    } catch (error) {
      unlockError = error;
    }
    const closeError = await lockedHandle.close().then(
      () => undefined,
      (error: unknown) => error,
    );
    if (operationError === undefined && (unlockError !== undefined || closeError !== undefined)) {
      throw new ConfigurationError(`Could not release the KrutrimConnect lock at ${lockPath}.`, {
        cause: unlockError ?? closeError,
      });
    }
  }
  if (operationError !== undefined) {
    throw operationError;
  }
  return result as T;
}
