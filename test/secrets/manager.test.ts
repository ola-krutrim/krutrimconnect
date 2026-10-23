import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { SecretManager } from "../../src/secrets/manager.js";
import type { SecretStore } from "../../src/secrets/types.js";
import { createTestWorkspace, type TestWorkspace } from "../helpers.js";

const workspaces: TestWorkspace[] = [];

async function workspace(): Promise<TestWorkspace> {
  const created = await createTestWorkspace();
  workspaces.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (item) => await item.cleanup()));
});

describe("credential backend selection", () => {
  it("does not treat a keychain access error as a missing entry", async () => {
    const test = await workspace();
    await mkdir(test.paths.appHome, { mode: 0o700 });
    await writeFile(test.paths.fallbackSecretFile, '{"version":1,"apiKey":"stale-fallback"}\n', {
      mode: 0o600,
    });
    const failingKeychain: SecretStore = {
      backend: "macos-keychain",
      isFallback: false,
      read: async () => {
        throw new Error("keychain locked");
      },
      write: async () => undefined,
      delete: async () => false,
    };
    const manager = await SecretManager.create(test.paths, failingKeychain);

    await expect(manager.read()).rejects.toThrow(/keychain locked/u);
  });

  it.runIf(process.platform !== "win32")(
    "persists an explicit fallback choice so a broken keychain is not retried",
    async () => {
      const test = await workspace();
      const failingKeychain: SecretStore = {
        backend: "macos-keychain",
        isFallback: false,
        read: async () => {
          throw new Error("keychain locked");
        },
        write: async () => {
          throw new Error("keychain locked");
        },
        delete: async () => false,
      };
      const manager = await SecretManager.create(test.paths, failingKeychain);

      await expect(manager.store("not-a-real-key", true)).resolves.toMatchObject({
        backend: "restricted-file",
        usedFallback: true,
      });
      await expect(manager.read()).resolves.toBe("not-a-real-key");
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed when Credential Manager fails instead of persisting plaintext",
    async () => {
      const test = await workspace();
      const failingKeychain: SecretStore = {
        backend: "windows-credential-manager",
        isFallback: false,
        read: async () => null,
        write: async () => {
          throw new Error("credential manager unavailable");
        },
        delete: async () => false,
      };
      const manager = await SecretManager.create(test.paths, failingKeychain);

      await expect(manager.store("not-a-real-key", true)).rejects.toThrow(/disabled on Windows/u);
    },
  );

  it("uses a newly selected keychain instead of an older fallback file", async () => {
    const test = await workspace();
    await mkdir(test.paths.appHome, { recursive: true });
    await writeFile(
      test.paths.fallbackSecretFile,
      '{"version":1,"apiKey":"older-fallback-key"}\n',
      { mode: 0o600 },
    );
    await writeFile(
      test.paths.credentialBackendFile,
      '{"version":1,"backend":"restricted-file"}\n',
      { mode: 0o600 },
    );
    let keychainValue: string | null = null;
    const keychain: SecretStore = {
      backend: "macos-keychain",
      isFallback: false,
      read: async () => keychainValue,
      write: async (secret) => {
        keychainValue = secret;
      },
      delete: async () => false,
    };
    const manager = await SecretManager.create(test.paths, keychain);

    const result = await manager.store("newer-keychain-key", false);
    expect(result.removedStaleBackends).toEqual(["restricted-file"]);
    await expect(lstat(test.paths.fallbackSecretFile))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.read()).resolves.toBe("newer-keychain-key");
  });

  it("persists credential-bound validation evidence and detects tampering", async () => {
    const test = await workspace();
    let keychainValue: string | null = null;
    const keychain: SecretStore = {
      backend: "macos-keychain",
      isFallback: false,
      read: async () => keychainValue,
      write: async (secret) => {
        keychainValue = secret;
      },
      delete: async () => false,
    };
    const manager = await SecretManager.create(test.paths, keychain);
    const validation = {
      status: "validated" as const,
      method: "authenticated-model-catalogue-v1" as const,
      endpoint: "https://cloud.olakrutrim.com/v1/models" as const,
      validatedAt: "2026-08-27T00:00:00.000Z",
    };

    await expect(manager.store("candidate-key", false, validation))
      .resolves.toMatchObject({ validation });
    await expect(manager.describe()).resolves.toEqual({
      present: true,
      backend: "macos-keychain",
      validation,
    });
    const stored = await readFile(test.paths.credentialBackendFile, "utf8");
    expect(stored).not.toContain("candidate-key");
    const record = JSON.parse(stored) as {
      version: number;
      validation: { validatedAt: string; integrity: { value: string } };
    };
    expect(record.version).toBe(2);
    expect(record.validation.integrity.value).toMatch(/^[a-f0-9]{64}$/u);

    record.validation.validatedAt = "2026-08-28T00:00:00.000Z";
    await writeFile(
      test.paths.credentialBackendFile,
      `${JSON.stringify(record)}\n`,
      { mode: 0o600 },
    );
    await expect(manager.describe()).resolves.toMatchObject({
      present: true,
      validation: { status: "invalid" },
    });
  });

  it.runIf(process.platform !== "win32")(
    "removes active and stale local credential copies idempotently",
    async () => {
      const test = await workspace();
      await mkdir(test.paths.appHome, { recursive: true });
      await writeFile(
        test.paths.fallbackSecretFile,
        '{"version":1,"apiKey":"stale-fallback-key"}\n',
        { mode: 0o600 },
      );
      await writeFile(
        test.paths.credentialBackendFile,
        '{"version":1,"backend":"macos-keychain"}\n',
        { mode: 0o600 },
      );
      let keychainValue: string | null = "active-keychain-key";
      const keychain: SecretStore = {
        backend: "macos-keychain",
        isFallback: false,
        read: async () => keychainValue,
        write: async (secret) => {
          keychainValue = secret;
        },
        delete: async () => {
          if (keychainValue === null) {
            return false;
          }
          keychainValue = null;
          return true;
        },
      };
      const manager = await SecretManager.create(test.paths, keychain);

      await expect(manager.clear()).resolves.toMatchObject({
        changed: true,
        removedBackends: ["macos-keychain", "restricted-file"],
        removedBackendRecord: true,
      });
      await expect(manager.describe()).resolves.toEqual({
        present: false,
        backend: "none",
        validation: { status: "not-performed" },
      });
      await expect(lstat(test.paths.credentialBackendFile))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(test.paths.fallbackSecretFile))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(manager.clear()).resolves.toMatchObject({ changed: false });
    },
  );

  it.runIf(process.platform !== "win32")(
    "retains fail-closed backend selection when stale-copy cleanup fails",
    async () => {
      const test = await workspace();
      await mkdir(test.paths.appHome, { recursive: true });
      await writeFile(
        test.paths.fallbackSecretFile,
        '{"version":1,"apiKey":"active-fallback-key"}\n',
        { mode: 0o600 },
      );
      await writeFile(
        test.paths.credentialBackendFile,
        '{"version":1,"backend":"restricted-file"}\n',
        { mode: 0o600 },
      );
      const keychain: SecretStore = {
        backend: "macos-keychain",
        isFallback: false,
        read: async () => "stale-keychain-key",
        write: async () => undefined,
        delete: async () => {
          throw new Error("keychain locked");
        },
      };
      const manager = await SecretManager.create(test.paths, keychain);

      await expect(manager.clear()).rejects.toThrow(/backend selection was retained/u);
      await expect(manager.describe()).resolves.toEqual({
        present: false,
        backend: "restricted-file",
        validation: { status: "not-performed" },
      });
      await expect(lstat(test.paths.credentialBackendFile)).resolves.toBeTruthy();
    },
  );
});
