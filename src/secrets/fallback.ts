import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { SecretStoreError } from "../errors.js";
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  removeFileDurably,
} from "../fs/atomic.js";
import type { SecretStore } from "./types.js";

interface CredentialFile {
  version: 1;
  apiKey: string;
}

export class RestrictedFileSecretStore implements SecretStore {
  readonly backend = "restricted-file" as const;
  readonly isFallback = true;
  readonly #filePath: string;

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  async read(): Promise<string | null> {
    if (process.platform === "win32") {
      return null;
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(this.#filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SecretStoreError(`Credential fallback is not a regular file: ${this.#filePath}`);
    }
    if ((info.mode & 0o077) !== 0) {
      throw new SecretStoreError(
        `Credential fallback permissions are too broad at ${this.#filePath}; expected mode 0600.`,
      );
    }

    try {
      const parsed = JSON.parse(await readFile(this.#filePath, "utf8")) as Partial<CredentialFile>;
      return parsed.version === 1 && typeof parsed.apiKey === "string" && parsed.apiKey.length > 0
        ? parsed.apiKey
        : null;
    } catch (error) {
      throw new SecretStoreError(`Cannot parse credential fallback at ${this.#filePath}.`, {
        cause: error,
      });
    }
  }

  async write(secret: string): Promise<void> {
    if (process.platform === "win32") {
      throw new SecretStoreError(
        "Plaintext credential fallback is disabled on Windows because POSIX file modes cannot enforce the required restriction.",
      );
    }
    await ensurePrivateDirectory(path.dirname(this.#filePath));
    const payload: CredentialFile = { version: 1, apiKey: secret };
    await atomicWriteFile(this.#filePath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  }

  async delete(): Promise<boolean> {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(this.#filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new SecretStoreError(`Credential fallback is not a regular file: ${this.#filePath}`);
    }
    await removeFileDurably(this.#filePath);
    return true;
  }
}
