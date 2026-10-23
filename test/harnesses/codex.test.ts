import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { krutrimProvider } from "../../src/providers/krutrim.js";
import { sha256, withFileLock } from "../../src/fs/atomic.js";
import { CodexHarness } from "../../src/harnesses/codex.js";
import {
  createTestWorkspace,
  supportedProvider,
  testCatalogOptions,
  type TestWorkspace,
} from "../helpers.js";

const workspaces: TestWorkspace[] = [];

async function workspace(): Promise<TestWorkspace> {
  const created = await createTestWorkspace();
  workspaces.push(created);
  return created;
}

async function runLockWorker(lockPath: string, eventsPath: string): Promise<void> {
  const worker = fileURLToPath(new URL("../fixtures/lock-worker.ts", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, lockPath, eventsPath], {
      cwd: path.resolve(fileURLToPath(new URL("../..", import.meta.url))),
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`lock worker exited ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      }
    });
  });
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (item) => await item.cleanup()));
});

describe("Codex harness", () => {
  it("restores the exact original bytes and mode", async () => {
    const test = await workspace();
    const original = Buffer.from(
      '\uFEFF# original bytes and comments\r\nmodel = "openai-model"\r\n\r\n[features]\r\nweb_search = true\r\n',
    );
    await writeFile(test.paths.codexConfig, original, { mode: 0o640 });
    await chmod(test.paths.codexConfig, 0o640);

    const enabled = await test.harness.enable(supportedProvider, "Krutrim-2");
    expect(enabled.changed).toBe(true);
    expect(enabled.snapshotPath).toBeTruthy();
    expect(enabled.modelCatalogPath).toBeTruthy();
    if (process.platform !== "win32") {
      expect((await stat(enabled.modelCatalogPath!)).mode & 0o777).toBe(0o600);
    }
    expect(await test.harness.status()).toMatchObject({
      state: "connected",
      modelCatalogPath: enabled.modelCatalogPath,
      modelContextWindow: 131_072,
    });
    const connected = await readFile(test.paths.codexConfig);
    expect(connected).not.toEqual(original);
    expect(connected.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(connected.toString("utf8")).toContain("\r\n");

    const disabled = await test.harness.disable();
    expect(disabled.changed).toBe(true);
    expect(await readFile(test.paths.codexConfig)).toEqual(original);
    if (process.platform !== "win32") {
      expect((await stat(test.paths.codexConfig)).mode & 0o777).toBe(0o640);
    }
    await expect(stat(enabled.modelCatalogPath!)).rejects.toMatchObject({ code: "ENOENT" });

    const repeated = await test.harness.disable();
    expect(repeated.changed).toBe(false);
  });

  it("deletes the managed config when no config existed before activation", async () => {
    const test = await workspace();
    await test.harness.enable(supportedProvider, "Krutrim-2");
    expect(await stat(test.paths.codexConfig)).toBeTruthy();
    await test.harness.disable();
    await expect(stat(test.paths.codexConfig)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write or create a snapshot on an idempotent second activation", async () => {
    const test = await workspace();
    await writeFile(test.paths.codexConfig, 'model = "original"\n');
    const first = await test.harness.enable(supportedProvider, "Krutrim-2");
    const afterFirst = await readFile(test.paths.codexConfig);
    const snapshotsAfterFirst = await readdir(test.paths.snapshotsDir);

    const second = await test.harness.enable(supportedProvider, "Krutrim-2");
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(await readFile(test.paths.codexConfig)).toEqual(afterFirst);
    expect(await readdir(test.paths.snapshotsDir)).toEqual(snapshotsAfterFirst);
  });

  it("preserves and adopts unrelated Codex drift when switching models", async () => {
    const test = await workspace();
    await writeFile(test.paths.codexConfig, 'model = "original"\n');
    await test.harness.enable(supportedProvider, "Krutrim-2");
    const managed = await readFile(test.paths.codexConfig, "utf8");
    const snapshotsAfterFirst = await readdir(test.paths.snapshotsDir);
    const withProjectTrust = `${managed}\n[projects."/workspace"]\ntrust_level = "trusted"\n`;
    await writeFile(test.paths.codexConfig, withProjectTrust);

    const status = await test.harness.status();
    expect(status).toMatchObject({
      state: "drifted",
      connectionMode: "native",
    });
    expect(status.detail).toMatch(/unrelated base user config/u);

    const repeated = await test.harness.enable(supportedProvider, "Krutrim-2");
    expect(repeated.changed).toBe(false);
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe(withProjectTrust);
    expect(await readdir(test.paths.snapshotsDir)).toEqual(snapshotsAfterFirst);

    const switched = await test.harness.enable(supportedProvider, "Krutrim-1");
    expect(switched.changed).toBe(true);
    const switchedSource = await readFile(test.paths.codexConfig, "utf8");
    expect(switchedSource).toContain('[projects."/workspace"]');
    expect(switchedSource).toContain('model = "Krutrim-1"');
    expect((await test.harness.status()).state).toBe("connected");

    await test.harness.disable();
    const restored = await readFile(test.paths.codexConfig, "utf8");
    expect(restored).toContain('[projects."/workspace"]');
    expect(restored).toContain('model = "original"');
    expect(restored).not.toContain("model_providers.krutrim");
  });

  it("keeps the initial baseline when changing models", async () => {
    const test = await workspace();
    const original = '# baseline\nmodel = "original"\n';
    await writeFile(test.paths.codexConfig, original);
    await test.harness.enable(supportedProvider, "Krutrim-1");
    await test.harness.enable(supportedProvider, "Krutrim-2");
    await test.harness.disable();
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe(original);
    expect((await readdir(test.paths.snapshotsDir)).length).toBe(2);
  });

  it("refuses drift by default and preserves it before forced exact restore", async () => {
    const test = await workspace();
    const original = 'model = "original"\n';
    await writeFile(test.paths.codexConfig, original);
    await test.harness.enable(supportedProvider, "Krutrim-2");
    await writeFile(test.paths.codexConfig, '# external edit\nmodel = "external"\n');

    await expect(test.harness.disable()).rejects.toThrow(/--force/u);
    const forced = await test.harness.disable({ force: true });
    expect(forced.rescueSnapshotPath).toBeTruthy();
    expect(await readFile(forced.rescueSnapshotPath!, "utf8")).toContain("# external edit");
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe(original);
  });

  it("treats managed catalog tampering as drift and preserves it on forced restore", async () => {
    const test = await workspace();
    const original = 'model = "original"\n';
    await writeFile(test.paths.codexConfig, original);
    const enabled = await test.harness.enable(supportedProvider, "Krutrim-2");
    await writeFile(enabled.modelCatalogPath!, '{"models":[]}\n', { mode: 0o600 });

    const status = await test.harness.status();
    expect(status.state).toBe("drifted");
    expect(status.detail).toMatch(/catalogue is missing, modified, unsafe/u);
    await expect(test.harness.disable()).rejects.toThrow(/--force/u);

    const forced = await test.harness.disable({ force: true });
    expect(forced.preservedCatalogPath).toBe(enabled.modelCatalogPath);
    expect(await readFile(enabled.modelCatalogPath!, "utf8")).toBe('{"models":[]}\n');
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe(original);
  });

  it("fails closed before any filesystem mutation when capabilities are unknown", async () => {
    const test = await workspace();
    const existing = '# untouched\n';
    await writeFile(test.paths.codexConfig, existing);

    await expect(test.harness.enable(krutrimProvider, "Krutrim-2")).rejects.toThrow(
      /No config was changed/u,
    );
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe(existing);
    await expect(stat(test.paths.appHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not use passing capability evidence from a different model", async () => {
    const test = await workspace();
    const existing = '# model-bound evidence must not cross scopes\n';
    await writeFile(test.paths.codexConfig, existing);
    const modelBoundProvider = {
      ...krutrimProvider,
      capabilitiesFor(resolved: ReturnType<typeof krutrimProvider.resolveModel>) {
        return resolved.id === "Krutrim-Allowed"
          ? supportedProvider.capabilities
          : krutrimProvider.capabilities;
      },
    };

    await expect(test.harness.enable(modelBoundProvider, "Krutrim-Different")).rejects.toThrow(
      /No config was changed/u,
    );
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe(existing);
    await expect(stat(test.paths.appHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked config", async () => {
    const test = await workspace();
    const target = path.join(test.root, "target.toml");
    await writeFile(target, 'model = "original"\n');
    await mkdir(path.dirname(test.paths.codexConfig), { recursive: true });
    await symlink(target, test.paths.codexConfig);
    await expect(test.harness.enable(supportedProvider, "Krutrim-2")).rejects.toThrow(/symlinked/u);
    expect(await readFile(target, "utf8")).toBe('model = "original"\n');
  });

  it("rejects a symlinked CODEX_HOME", async () => {
    const test = await workspace();
    const targetDirectory = path.join(test.root, "real-codex-home");
    await mkdir(targetDirectory);
    await rm(test.paths.codexHome, { recursive: true });
    await symlink(targetDirectory, test.paths.codexHome);

    await expect(test.harness.enable(supportedProvider, "Krutrim-2")).rejects.toThrow(
      /symlinked CODEX_HOME/u,
    );
    expect(await readdir(targetDirectory)).toEqual([]);
  });

  it("refuses restore when the baseline snapshot fails its integrity check", async () => {
    const test = await workspace();
    await writeFile(test.paths.codexConfig, 'model = "original"\n');
    await test.harness.enable(supportedProvider, "Krutrim-2");
    const managedConfig = await readFile(test.paths.codexConfig);
    const state = JSON.parse(await readFile(test.paths.stateFile, "utf8")) as {
      codex: { baseline: { path: string } };
    };
    await writeFile(state.codex.baseline.path, "corrupted snapshot");

    await expect(test.harness.disable()).rejects.toThrow(/integrity check failed/u);
    expect(await readFile(test.paths.codexConfig)).toEqual(managedConfig);
  });

  it("recovers a prepared enable transaction on either side of the config rename", async () => {
    const test = await workspace();
    const original = Buffer.from('model = "original"\n');
    await writeFile(test.paths.codexConfig, original);
    await test.harness.enable(supportedProvider, "Krutrim-2");
    const managed = await readFile(test.paths.codexConfig);
    const committedState = JSON.parse(await readFile(test.paths.stateFile, "utf8")) as {
      version: 1;
      codex: Record<string, unknown> & { connectedSha256: string };
    };
    const transaction = {
      id: "simulated-crash",
      operation: "enable",
      preparedAt: new Date().toISOString(),
      configPath: test.paths.codexConfig,
      beforeSha256: sha256(original),
      afterSha256: committedState.codex.connectedSha256,
      nextCodex: committedState.codex,
    };

    await writeFile(test.paths.codexConfig, original);
    await writeFile(test.paths.stateFile, `${JSON.stringify({ version: 1, codexTransaction: transaction })}\n`);
    expect((await test.harness.status()).state).toBe("disconnected");
    expect(JSON.parse(await readFile(test.paths.stateFile, "utf8"))).toEqual({ version: 1 });

    await writeFile(test.paths.codexConfig, managed);
    await writeFile(test.paths.stateFile, `${JSON.stringify({ version: 1, codexTransaction: transaction })}\n`);
    expect((await test.harness.status()).state).toBe("connected");
    const recovered = JSON.parse(await readFile(test.paths.stateFile, "utf8")) as Record<string, unknown>;
    expect(recovered.codex).toEqual(committedState.codex);
    expect(recovered.codexTransaction).toBeUndefined();
  });

  it("recovers a prepared disable transaction after the baseline rename", async () => {
    const test = await workspace();
    const original = Buffer.from('model = "original"\n');
    await writeFile(test.paths.codexConfig, original);
    await test.harness.enable(supportedProvider, "Krutrim-2");
    const managed = await readFile(test.paths.codexConfig);
    const committedState = JSON.parse(await readFile(test.paths.stateFile, "utf8")) as {
      version: 1;
      codex: Record<string, unknown> & {
        connectedSha256: string;
        baseline: { sha256: string };
      };
    };
    const transaction = {
      id: "simulated-disable-crash",
      operation: "disable",
      preparedAt: new Date().toISOString(),
      configPath: test.paths.codexConfig,
      beforeSha256: committedState.codex.connectedSha256,
      afterSha256: committedState.codex.baseline.sha256,
      previousCodex: committedState.codex,
    };

    await writeFile(test.paths.codexConfig, managed);
    await writeFile(
      test.paths.stateFile,
      `${JSON.stringify({ version: 1, codex: committedState.codex, codexTransaction: transaction })}\n`,
    );
    expect((await test.harness.status()).state).toBe("connected");

    await writeFile(test.paths.codexConfig, original);
    await writeFile(
      test.paths.stateFile,
      `${JSON.stringify({ version: 1, codex: committedState.codex, codexTransaction: transaction })}\n`,
    );
    expect((await test.harness.status()).state).toBe("disconnected");
    expect(JSON.parse(await readFile(test.paths.stateFile, "utf8"))).toEqual({ version: 1 });
  });

  it("clears a prepared journal when compare-and-swap rejects a pre-rename edit", async () => {
    const test = await workspace();
    const original = 'model = "original"\n';
    const external = '# concurrent external edit\nmodel = "external"\n';
    await writeFile(test.paths.codexConfig, original);
    const harness = new CodexHarness(
      test.paths,
      { read: async () => "test-secret-never-logged" },
      {
        command: "/absolute/node",
        args: ["/absolute/krutrimconnect.js", "_credential", "read", "--app-home", test.paths.appHome],
      },
      {
        ...testCatalogOptions,
        beforeConfigMutation: async () => await writeFile(test.paths.codexConfig, external),
      },
    );

    await expect(harness.enable(supportedProvider, "Krutrim-2")).rejects.toThrow(/changed after it was read/u);
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe(external);
    expect(JSON.parse(await readFile(test.paths.stateFile, "utf8"))).toEqual({ version: 1 });
    expect((await test.harness.status()).state).toBe("disconnected");
  });

  it("restores the baseline with force after CODEX_HOME was externally removed", async () => {
    const test = await workspace();
    const original = 'model = "original"\n';
    await writeFile(test.paths.codexConfig, original);
    await test.harness.enable(supportedProvider, "Krutrim-2");
    await rm(test.paths.codexHome, { recursive: true });

    const restored = await test.harness.disable({ force: true });
    expect(restored.changed).toBe(true);
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe(original);
  });

  it("reuses an orphaned lock file because OS locks are released on process exit", async () => {
    const test = await workspace();
    const lockPath = path.join(test.paths.codexHome, ".krutrim-connect.lock");
    await writeFile(lockPath, "");

    expect((await test.harness.status()).state).toBe("disconnected");
    expect((await stat(lockPath)).isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("serializes concurrent owners without stealing an active lock", async () => {
    const test = await workspace();
    const lockPath = path.join(test.paths.codexHome, ".krutrim-connect.lock");
    let active = 0;
    let maximumActive = 0;
    await Promise.all(
      Array.from({ length: 12 }, async () =>
        await withFileLock(lockPath, async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );
    expect(maximumActive).toBe(1);
    expect((await stat(lockPath)).isFile()).toBe(true);
  });

  it("serializes concurrent contenders sharing one orphaned lock file", async () => {
    const test = await workspace();
    const lockPath = path.join(test.paths.codexHome, ".krutrim-connect.lock");
    await writeFile(lockPath, "");
    let active = 0;
    let maximumActive = 0;

    await Promise.all(
      Array.from({ length: 24 }, async () =>
        await withFileLock(lockPath, async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 3));
          active -= 1;
        }),
      ),
    );

    expect(maximumActive).toBe(1);
    expect((await stat(lockPath)).isFile()).toBe(true);
  });

  it("serializes concurrent lock holders across processes", async () => {
    const test = await workspace();
    const lockPath = path.join(test.paths.codexHome, ".krutrim-connect.lock");
    const eventsPath = path.join(test.root, "lock-events.log");
    await writeFile(lockPath, "");
    await writeFile(eventsPath, "");

    await Promise.all(
      Array.from({ length: 12 }, async () => await runLockWorker(lockPath, eventsPath)),
    );

    const events = (await readFile(eventsPath, "utf8")).trim().split("\n");
    let active = 0;
    let maximumActive = 0;
    for (const event of events) {
      active += event.startsWith("start ") ? 1 : -1;
      maximumActive = Math.max(maximumActive, active);
      expect(active).toBeGreaterThanOrEqual(0);
    }
    expect(events.filter((event) => event.startsWith("start "))).toHaveLength(12);
    expect(active).toBe(0);
    expect(maximumActive).toBe(1);
  }, 15000);
});
