import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import { SecretStoreError } from "../errors.js";
import { runProcess, type ProcessResult } from "../process.js";
import type { SecretBackend, SecretStore } from "./types.js";

const SERVICE = "krutrim-connect";
const MACOS_SECURITY = "/usr/bin/security";
const LINUX_SECRET_TOOL_CANDIDATES = ["/usr/bin/secret-tool", "/bin/secret-tool"] as const;

type NativeEntry = Pick<
  import("@napi-rs/keyring").AsyncEntry,
  "deleteCredential" | "getPassword" | "setPassword"
>;
type CredentialFinder = typeof import("@napi-rs/keyring").findCredentialsAsync;
export type CredentialCommandRunner = (
  command: string,
  args: readonly string[],
  input?: string,
) => Promise<ProcessResult>;

const defaultRunner: CredentialCommandRunner = async (command, args, input) =>
  await runProcess(command, args, {
    ...(input === undefined ? {} : { input }),
    timeoutMs: 5000,
    maxOutputBytes: 16 * 1024,
  });

export const MACOS_KEYCHAIN_APPROVAL_TIMEOUT_MS = 60_000;

function passwordFromStdout(stdout: string): string | null {
  const password = stdout.replace(/\r?\n$/u, "");
  return password.length > 0 ? password : null;
}

export function keychainAccountForAppHome(appHome: string): string {
  const digest = createHash("sha256").update(path.resolve(appHome)).digest("hex");
  return `app-${digest}`;
}

export class MacOSKeychainStore implements SecretStore {
  readonly backend = "macos-keychain" as const;
  readonly isFallback = false;
  readonly #entry: NativeEntry;
  readonly #account: string;
  readonly #run: CredentialCommandRunner;

  constructor(entry: NativeEntry, account: string, run: CredentialCommandRunner = defaultRunner) {
    this.#entry = entry;
    this.#account = account;
    this.#run = run;
  }

  async read(): Promise<string | null> {
    let password: string | null | undefined;
    try {
      password = await this.#entry.getPassword(
        AbortSignal.timeout(MACOS_KEYCHAIN_APPROVAL_TIMEOUT_MS),
      ) as string | null | undefined;
    } catch (error) {
      throw new SecretStoreError("macOS Keychain lookup failed.", { cause: error });
    }
    if (typeof password === "string") {
      return password.length > 0 ? password : null;
    }

    // @napi-rs/keyring currently collapses both a missing item and a native
    // access/backend error to `undefined` (and some releases return `null`).
    // Query only the item's metadata to
    // preserve that distinction without retrieving the password through a
    // second executable (which would create a separate Keychain ACL prompt).
    let result: ProcessResult;
    try {
      result = await this.#run(MACOS_SECURITY, [
        "find-generic-password",
        "-a",
        this.#account,
        "-s",
        SERVICE,
      ]);
    } catch (error) {
      throw new SecretStoreError("macOS Keychain lookup failed.", { cause: error });
    }
    if (/could not be found|item not found|errSecItemNotFound/iu.test(result.stderr)) {
      return null;
    }
    if (result.code === 0) {
      throw new SecretStoreError(
        "macOS Keychain lookup failed: the credential exists, but native access was denied or unavailable.",
      );
    }
    throw new SecretStoreError(`macOS Keychain lookup failed (exit ${result.code ?? "signal"}).`);
  }

  async write(secret: string): Promise<void> {
    try {
      await this.#entry.setPassword(secret);
    } catch (error) {
      throw new SecretStoreError("macOS Keychain update failed.", { cause: error });
    }
  }

  async delete(): Promise<boolean> {
    try {
      return await this.#entry.deleteCredential(
        AbortSignal.timeout(MACOS_KEYCHAIN_APPROVAL_TIMEOUT_MS),
      );
    } catch (error) {
      throw new SecretStoreError("macOS Keychain deletion failed.", { cause: error });
    }
  }
}

export class LinuxSecretServiceStore implements SecretStore {
  readonly backend = "linux-secret-service" as const;
  readonly isFallback = false;
  readonly #command: string;
  readonly #account: string;
  readonly #run: CredentialCommandRunner;

  constructor(command: string, account: string, run: CredentialCommandRunner = defaultRunner) {
    this.#command = command;
    this.#account = account;
    this.#run = run;
  }

  async read(): Promise<string | null> {
    let result: ProcessResult;
    try {
      result = await this.#run(this.#command, [
        "lookup",
        "service",
        SERVICE,
        "account",
        this.#account,
      ]);
    } catch (error) {
      throw new SecretStoreError("Linux Secret Service lookup failed.", { cause: error });
    }
    if (result.code === 0) {
      return passwordFromStdout(result.stdout);
    }
    if (result.code === 1 && result.stderr.trim().length === 0) {
      return null;
    }
    throw new SecretStoreError(`Linux Secret Service lookup failed (exit ${result.code ?? "signal"}).`);
  }

  async write(secret: string): Promise<void> {
    let result: ProcessResult;
    try {
      result = await this.#run(
        this.#command,
        ["store", "--label=krutrim-connect", "service", SERVICE, "account", this.#account],
        secret,
      );
    } catch (error) {
      throw new SecretStoreError("Linux Secret Service update failed.", { cause: error });
    }
    if (result.code !== 0) {
      throw new SecretStoreError(`Linux Secret Service update failed (exit ${result.code ?? "signal"}).`);
    }
  }

  async delete(): Promise<boolean> {
    if (await this.read() === null) {
      return false;
    }
    let result: ProcessResult;
    try {
      result = await this.#run(this.#command, [
        "clear",
        "service",
        SERVICE,
        "account",
        this.#account,
      ]);
    } catch (error) {
      throw new SecretStoreError("Linux Secret Service deletion failed.", { cause: error });
    }
    if (result.code !== 0) {
      throw new SecretStoreError(
        `Linux Secret Service deletion failed (exit ${result.code ?? "signal"}).`,
      );
    }
    return true;
  }
}

export class WindowsCredentialManagerStore implements SecretStore {
  readonly backend = "windows-credential-manager" as const;
  readonly isFallback = false;
  readonly #entry: NativeEntry;
  readonly #findCredentials: CredentialFinder;
  readonly #account: string;

  constructor(entry: NativeEntry, findCredentials: CredentialFinder, account: string) {
    this.#entry = entry;
    this.#findCredentials = findCredentials;
    this.#account = account;
  }

  async read(): Promise<string | null> {
    let credentials: Awaited<ReturnType<CredentialFinder>>;
    try {
      credentials = await this.#findCredentials(SERVICE);
    } catch (error) {
      throw new SecretStoreError("Windows Credential Manager lookup failed.", { cause: error });
    }
    const matches = credentials.filter((credential) => credential.account === this.#account);
    if (matches.length === 0) {
      return null;
    }
    if (matches.length !== 1) {
      throw new SecretStoreError("Windows Credential Manager contains ambiguous matching entries.");
    }
    return matches[0]?.password || null;
  }

  async write(secret: string): Promise<void> {
    try {
      await this.#entry.setPassword(secret);
    } catch (error) {
      throw new SecretStoreError("Windows Credential Manager update failed.", { cause: error });
    }
  }

  async delete(): Promise<boolean> {
    let credentials: Awaited<ReturnType<CredentialFinder>>;
    try {
      credentials = await this.#findCredentials(SERVICE);
    } catch (error) {
      throw new SecretStoreError("Windows Credential Manager lookup failed.", { cause: error });
    }
    const matches = credentials.filter((credential) => credential.account === this.#account);
    if (matches.length === 0) {
      return false;
    }
    if (matches.length !== 1) {
      throw new SecretStoreError("Windows Credential Manager contains ambiguous matching entries.");
    }
    try {
      const deleted = await this.#entry.deleteCredential();
      if (!deleted) {
        throw new Error("Credential Manager reported that no credential was deleted");
      }
      return true;
    } catch (error) {
      throw new SecretStoreError("Windows Credential Manager deletion failed.", { cause: error });
    }
  }
}

async function firstExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next fixed system path.
    }
  }
  return null;
}

async function nativeEntry(account: string): Promise<{
  entry: NativeEntry;
  findCredentials: CredentialFinder;
} | null> {
  try {
    const { AsyncEntry, findCredentialsAsync } = await import("@napi-rs/keyring");
    return {
      entry: new AsyncEntry(SERVICE, account),
      findCredentials: findCredentialsAsync,
    };
  } catch {
    return null;
  }
}

export async function findSystemKeychainStore(account: string): Promise<SecretStore | null> {
  if (process.platform === "linux") {
    const command = await firstExecutable(LINUX_SECRET_TOOL_CANDIDATES);
    return command ? new LinuxSecretServiceStore(command, account) : null;
  }
  if (process.platform === "darwin") {
    const native = await nativeEntry(account);
    return native ? new MacOSKeychainStore(native.entry, account) : null;
  }
  if (process.platform === "win32") {
    const native = await nativeEntry(account);
    return native
      ? new WindowsCredentialManagerStore(native.entry, native.findCredentials, account)
      : null;
  }
  return null;
}

export type SystemSecretBackend = Exclude<SecretBackend, "restricted-file">;
