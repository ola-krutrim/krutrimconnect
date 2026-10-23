import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RestrictedFileSecretStore } from "../../src/secrets/fallback.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("restricted credential fallback", () => {
  it("enforces the platform-appropriate private fallback policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-secret-test-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "private");
    const file = path.join(directory, "credentials.json");
    const store = new RestrictedFileSecretStore(file);

    if (process.platform === "win32") {
      await expect(store.write("not-a-real-api-key")).rejects.toThrow(/disabled on Windows/u);
      await expect(store.read()).resolves.toBeNull();
      return;
    }

    await store.write("not-a-real-api-key");

    expect(await store.read()).toBe("not-a-real-api-key");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(store.delete()).resolves.toBe(true);
    await expect(store.read()).resolves.toBeNull();
    await expect(store.delete()).resolves.toBe(false);
  });
});
