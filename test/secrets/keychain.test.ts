import { describe, expect, it, vi } from "vitest";

import type { ProcessResult } from "../../src/process.js";
import {
  LinuxSecretServiceStore,
  MacOSKeychainStore,
  MACOS_KEYCHAIN_APPROVAL_TIMEOUT_MS,
  WindowsCredentialManagerStore,
  keychainAccountForAppHome,
  type CredentialCommandRunner,
} from "../../src/secrets/keychain.js";

function result(overrides: Partial<ProcessResult>): ProcessResult {
  return { code: 0, signal: null, stdout: "", stderr: "", ...overrides };
}

describe("OS credential stores", () => {
  const account = keychainAccountForAppHome("/private/test/krutrim-connect-app");

  it("uses distinct non-path keychain accounts for distinct application homes", () => {
    const first = keychainAccountForAppHome("/private/test/app-one");
    const second = keychainAccountForAppHome("/private/test/app-two");

    expect(first).not.toBe(second);
    expect(first).toMatch(/^app-[a-f0-9]{64}$/u);
    expect(first).not.toContain("app-one");
  });

  it("distinguishes a missing macOS item from an access failure", async () => {
    const entry = {
      getPassword: vi.fn(async () => undefined),
      setPassword: vi.fn(async () => undefined),
      deleteCredential: vi.fn(async () => false),
    };
    const missing = new MacOSKeychainStore(
      entry,
      account,
      async () => result({ code: 44, stderr: "The specified item could not be found in the keychain." }),
    );
    const denied = new MacOSKeychainStore(
      entry,
      account,
      async () => result({ code: 0 }),
    );

    await expect(missing.read()).resolves.toBeNull();
    await expect(denied.read()).rejects.toThrow(/lookup failed/u);
  });

  it("reads macOS credentials through the native entry without a second password prompt", async () => {
    const runner = vi.fn(async () => result({ code: 0 }));
    const getPassword = vi.fn(async (signal?: AbortSignal | null) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return "not-a-real-key";
    });
    const store = new MacOSKeychainStore(
      {
        getPassword,
        setPassword: vi.fn(async () => undefined),
        deleteCredential: vi.fn(async () => false),
      },
      account,
      runner,
    );

    await expect(store.read()).resolves.toBe("not-a-real-key");
    expect(getPassword).toHaveBeenCalledOnce();
    expect(runner).not.toHaveBeenCalled();
    expect(MACOS_KEYCHAIN_APPROVAL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("uses a metadata-only command to distinguish a missing macOS item", async () => {
    const calls: readonly string[][] = [];
    const mutableCalls = calls as string[][];
    const store = new MacOSKeychainStore(
      {
        getPassword: vi.fn(async () => undefined),
        deleteCredential: vi.fn(async () => false),
        setPassword: vi.fn(async () => undefined),
      },
      account,
      async (_command, args) => {
        mutableCalls.push([...args]);
        return result({ code: 44, stderr: "The specified item could not be found in the keychain." });
      },
    );

    await expect(store.read()).resolves.toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("-w");
  });

  it("handles a native null password result without dereferencing it", async () => {
    const store = new MacOSKeychainStore(
      {
        getPassword: vi.fn(async () => null) as never,
        deleteCredential: vi.fn(async () => false),
        setPassword: vi.fn(async () => undefined),
      },
      account,
      async () => result({ code: 44, stderr: "The specified item could not be found in the keychain." }),
    );

    await expect(store.read()).resolves.toBeNull();
  });

  it("sends a Linux Secret Service password only through stdin", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: CredentialCommandRunner = async (_command, args, input) => {
      calls.push(input === undefined ? { args } : { args, input });
      return result({});
    };
    const store = new LinuxSecretServiceStore("/usr/bin/secret-tool", account, runner);

    await store.write("not-a-real-key");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.join(" ")).not.toContain("not-a-real-key");
    expect(calls[0]?.input).toBe("not-a-real-key");
  });

  it("propagates Windows Credential Manager enumeration failures", async () => {
    const store = new WindowsCredentialManagerStore(
      {
        getPassword: vi.fn(async () => undefined),
        deleteCredential: vi.fn(async () => false),
        setPassword: vi.fn(async () => undefined),
      },
      vi.fn(async () => {
        throw new Error("credential manager locked");
      }),
      account,
    );

    await expect(store.read()).rejects.toThrow(/lookup failed/u);
  });

  it("deletes a macOS credential through the native entry", async () => {
    const deleteCredential = vi.fn(async (signal?: AbortSignal | null) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return true;
    });
    const store = new MacOSKeychainStore(
      {
        getPassword: vi.fn(async () => "not-a-real-key"),
        setPassword: vi.fn(async () => undefined),
        deleteCredential,
      },
      account,
    );

    await expect(store.delete()).resolves.toBe(true);
    expect(deleteCredential).toHaveBeenCalledOnce();
  });

  it("deletes a Linux Secret Service credential without placing it in arguments", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: CredentialCommandRunner = async (_command, args, input) => {
      calls.push(input === undefined ? { args } : { args, input });
      return args[0] === "lookup"
        ? result({ stdout: "not-a-real-key\n" })
        : result({});
    };
    const store = new LinuxSecretServiceStore("/usr/bin/secret-tool", account, runner);

    await expect(store.delete()).resolves.toBe(true);
    expect(calls.map((call) => call.args[0])).toEqual(["lookup", "clear"]);
    expect(calls.flatMap((call) => call.args)).not.toContain("not-a-real-key");
  });

  it("deletes exactly one matching Windows credential", async () => {
    const deleteCredential = vi.fn(async () => true);
    const store = new WindowsCredentialManagerStore(
      {
        getPassword: vi.fn(async () => "not-a-real-key"),
        setPassword: vi.fn(async () => undefined),
        deleteCredential,
      },
      vi.fn(async () => [{ account, password: "not-a-real-key" }]),
      account,
    );

    await expect(store.delete()).resolves.toBe(true);
    expect(deleteCredential).toHaveBeenCalledOnce();
  });
});
