import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import {
  KRUTRIM_CREDENTIAL_VALIDATION_METHOD,
  KRUTRIM_MODELS_URL,
  type CredentialValidationDescription,
} from "../auth.js";
import { SecretStoreError } from "../errors.js";
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  removeFileDurably,
} from "../fs/atomic.js";
import type { RuntimePaths } from "../paths.js";
import { RestrictedFileSecretStore } from "./fallback.js";
import { findSystemKeychainStore, keychainAccountForAppHome } from "./keychain.js";
import type {
  RemovedSecretResult,
  SecretBackend,
  SecretReader,
  SecretStore,
  StoredSecretResult,
} from "./types.js";

export function validateApiKey(secret: string): void {
  if (secret.length === 0) {
    throw new SecretStoreError("The API key is empty.");
  }
  if (secret !== secret.trim()) {
    throw new SecretStoreError("The API key must not contain surrounding whitespace.");
  }
  if (secret.length > 4096 || /[\u0000-\u001f\u007f]/u.test(secret)) {
    throw new SecretStoreError("The API key contains invalid characters or is unexpectedly long.");
  }
}

export interface SecretDescription {
  present: boolean;
  backend: SecretBackend | "none";
  validation: CredentialValidationDescription;
}

export interface SecretInspection extends SecretDescription {
  secret: string | null;
}

interface CredentialBackendRecord {
  version: 1 | 2;
  backend: SecretBackend;
  validation?: unknown;
}

interface StoredPassedCredentialValidation {
  status: "validated";
  method: typeof KRUTRIM_CREDENTIAL_VALIDATION_METHOD;
  endpoint: typeof KRUTRIM_MODELS_URL;
  validatedAt: string;
  integrity: {
    algorithm: "hmac-sha256";
    value: string;
  };
}

const SECRET_BACKENDS: readonly SecretBackend[] = [
  "macos-keychain",
  "linux-secret-service",
  "windows-credential-manager",
  "restricted-file",
];

async function readBackendRecord(file: string): Promise<CredentialBackendRecord | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new SecretStoreError(`Credential backend record is not a regular file: ${file}`);
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CredentialBackendRecord>;
    if ((parsed.version !== 1 && parsed.version !== 2) || !SECRET_BACKENDS.includes(parsed.backend as SecretBackend)) {
      throw new Error("Unsupported credential backend record");
    }
    return parsed as CredentialBackendRecord;
  } catch (error) {
    throw new SecretStoreError(`Cannot parse credential backend record at ${file}.`, { cause: error });
  }
}

function validationPayload(
  validation: Omit<StoredPassedCredentialValidation, "integrity">,
): string {
  return JSON.stringify({
    provider: "krutrim",
    status: validation.status,
    method: validation.method,
    endpoint: validation.endpoint,
    validatedAt: validation.validatedAt,
  });
}

function sealValidation(
  validation: CredentialValidationDescription,
  secret: string,
): unknown {
  if (validation.status !== "validated") {
    return validation;
  }
  const unsigned = {
    status: validation.status,
    method: validation.method,
    endpoint: validation.endpoint,
    validatedAt: validation.validatedAt,
  };
  return {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      value: createHmac("sha256", secret).update(validationPayload(unsigned)).digest("hex"),
    },
  } satisfies StoredPassedCredentialValidation;
}

function describeValidation(
  value: unknown,
  secret: string,
): CredentialValidationDescription {
  if (value === undefined) {
    return { status: "not-performed" };
  }
  const status = value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>).status
    : undefined;
  if (status === "skipped") {
    return { status: "skipped" };
  }
  if (status === "not-performed") {
    return { status: "not-performed" };
  }
  const candidate = value as Partial<StoredPassedCredentialValidation> | null;
  if (
    candidate === null ||
    candidate.status !== "validated" ||
    candidate.method !== KRUTRIM_CREDENTIAL_VALIDATION_METHOD ||
    candidate.endpoint !== KRUTRIM_MODELS_URL ||
    typeof candidate.validatedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.validatedAt)) ||
    candidate.integrity?.algorithm !== "hmac-sha256" ||
    typeof candidate.integrity.value !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.integrity.value)
  ) {
    return { status: "invalid" };
  }
  const unsigned = {
    status: candidate.status,
    method: candidate.method,
    endpoint: candidate.endpoint,
    validatedAt: candidate.validatedAt,
  };
  const expected = createHmac("sha256", secret)
    .update(validationPayload(unsigned))
    .digest();
  const supplied = Buffer.from(candidate.integrity.value, "hex");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return { status: "invalid" };
  }
  return unsigned;
}

async function writeBackendRecord(
  file: string,
  backend: SecretBackend,
  secret: string,
  validation: CredentialValidationDescription,
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(file));
  const record: CredentialBackendRecord = {
    version: 2,
    backend,
    validation: sealValidation(validation, secret),
  };
  await atomicWriteFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export class SecretManager implements SecretReader {
  readonly #fallback: RestrictedFileSecretStore;
  readonly #keychain: Awaited<ReturnType<typeof findSystemKeychainStore>>;
  readonly #backendFile: string;

  private constructor(
    keychain: Awaited<ReturnType<typeof findSystemKeychainStore>>,
    fallback: RestrictedFileSecretStore,
    backendFile: string,
  ) {
    this.#keychain = keychain;
    this.#fallback = fallback;
    this.#backendFile = backendFile;
  }

  static async create(
    paths: RuntimePaths,
    keychainOverride?: SecretStore | null,
  ): Promise<SecretManager> {
    return new SecretManager(
      keychainOverride === undefined
        ? await findSystemKeychainStore(keychainAccountForAppHome(paths.appHome))
        : keychainOverride,
      new RestrictedFileSecretStore(paths.fallbackSecretFile),
      paths.credentialBackendFile,
    );
  }

  async #readWithBackend(): Promise<{
    secret: string | null;
    backend: SecretBackend | "none";
    validation: unknown;
  }> {
    const selected = await readBackendRecord(this.#backendFile);
    if (selected) {
      if (selected.backend === this.#fallback.backend) {
        return {
          secret: await this.#fallback.read(),
          backend: this.#fallback.backend,
          validation: selected.validation,
        };
      }
      if (!this.#keychain || this.#keychain.backend !== selected.backend) {
        throw new SecretStoreError(
          `The selected credential backend (${selected.backend}) is unavailable on this system. Run krutrimconnect login to select an available backend.`,
        );
      }
      return {
        secret: await this.#keychain.read(),
        backend: this.#keychain.backend,
        validation: selected.validation,
      };
    }

    // Legacy discovery is fail-closed: backend access errors are never treated as
    // a missing entry and never silently select an older plaintext credential.
    if (this.#keychain) {
      const keychainSecret = await this.#keychain.read();
      if (keychainSecret !== null) {
        return {
          secret: keychainSecret,
          backend: this.#keychain.backend,
          validation: undefined,
        };
      }
    }
    const fallbackSecret = await this.#fallback.read();
    return {
      secret: fallbackSecret,
      backend: fallbackSecret === null ? "none" : this.#fallback.backend,
      validation: undefined,
    };
  }

  async read(): Promise<string | null> {
    return (await this.inspect()).secret;
  }

  async describe(): Promise<SecretDescription> {
    const { secret: _secret, ...description } = await this.inspect();
    return description;
  }

  async inspect(): Promise<SecretInspection> {
    const { secret, backend, validation } = await this.#readWithBackend();
    if (secret !== null) {
      validateApiKey(secret);
      return {
        present: true,
        backend,
        secret,
        validation: describeValidation(validation, secret),
      };
    }
    return {
      present: false,
      backend,
      secret: null,
      validation: { status: "not-performed" },
    };
  }

  async #removeStale(store: SecretStore): Promise<{
    removed: boolean;
    failed: boolean;
  }> {
    try {
      if (!store.isFallback && await store.read() === null) {
        return { removed: false, failed: false };
      }
      return { removed: await store.delete(), failed: false };
    } catch {
      return { removed: false, failed: true };
    }
  }

  async store(
    secret: string,
    allowFileFallback: boolean,
    validation: CredentialValidationDescription = { status: "not-performed" },
  ): Promise<StoredSecretResult> {
    validateApiKey(secret);
    if (this.#keychain) {
      try {
        await this.#keychain.write(secret);
      } catch (error) {
        if (!allowFileFallback) {
          throw new SecretStoreError(
            "The OS keychain update failed. Re-run with --allow-file-fallback only if a mode-0600 plaintext fallback is acceptable.",
            { cause: error },
          );
        }
        await this.#fallback.write(secret);
        await writeBackendRecord(
          this.#backendFile,
          this.#fallback.backend,
          secret,
          validation,
        );
        const cleanup = await this.#removeStale(this.#keychain);
        return {
          backend: this.#fallback.backend,
          usedFallback: true,
          keychainFailure: "OS keychain update failed",
          removedStaleBackends: cleanup.removed ? [this.#keychain.backend] : [],
          cleanupFailures: cleanup.failed ? [this.#keychain.backend] : [],
          validation,
        };
      }
      await writeBackendRecord(this.#backendFile, this.#keychain.backend, secret, validation);
      const cleanup = await this.#removeStale(this.#fallback);
      return {
        backend: this.#keychain.backend,
        usedFallback: false,
        removedStaleBackends: cleanup.removed ? [this.#fallback.backend] : [],
        cleanupFailures: cleanup.failed ? [this.#fallback.backend] : [],
        validation,
      };
    }
    if (!allowFileFallback) {
      throw new SecretStoreError(
        "No supported OS keychain was found. Re-run with --allow-file-fallback to use the documented mode-0600 plaintext fallback.",
      );
    }
    if (process.platform === "win32") {
      throw new SecretStoreError(
        "The native Windows Credential Manager backend is unavailable, and plaintext fallback is disabled on Windows.",
      );
    }
    await this.#fallback.write(secret);
    await writeBackendRecord(this.#backendFile, this.#fallback.backend, secret, validation);
    return {
      backend: this.#fallback.backend,
      usedFallback: true,
      removedStaleBackends: [],
      cleanupFailures: [],
      validation,
    };
  }

  async clear(): Promise<RemovedSecretResult> {
    const selected = await readBackendRecord(this.#backendFile);
    const removedBackends: SecretBackend[] = [];
    const missingBackends: SecretBackend[] = [];
    const failures: SecretBackend[] = [];

    const removeStore = async (store: SecretStore): Promise<void> => {
      try {
        if (!store.isFallback && await store.read() === null) {
          missingBackends.push(store.backend);
          return;
        }
        const removed = await store.delete();
        if (removed) {
          removedBackends.push(store.backend);
        } else {
          missingBackends.push(store.backend);
        }
      } catch {
        failures.push(store.backend);
      }
    };

    if (this.#keychain) {
      await removeStore(this.#keychain);
    } else if (selected && selected.backend !== this.#fallback.backend) {
      failures.push(selected.backend);
    }
    await removeStore(this.#fallback);

    const unavailableBackends = [...new Set(failures)];
    if (unavailableBackends.length > 0) {
      throw new SecretStoreError(
        `Could not remove every local credential copy (${unavailableBackends.join(", ")}). ` +
          "The backend selection was retained to prevent a stale credential from becoming active. Retry logout after restoring backend access.",
      );
    }

    const removedBackendRecord = selected !== null;
    await removeFileDurably(this.#backendFile);
    return {
      changed: removedBackendRecord || removedBackends.length > 0,
      removedBackends,
      missingBackends,
      removedBackendRecord,
    };
  }
}
