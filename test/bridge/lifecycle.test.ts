import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { bridgeBaseUrl, bridgeIsHealthy, readBridgeRuntime, serveBridgeRuntime, stopBridgeRuntime, type BridgeRuntimeRecord } from "../../src/bridge/runtime.js";
import { createTestWorkspace, supportedProvider, testCatalogOptions } from "../helpers.js";
import { CodexHarness } from "../../src/harnesses/codex.js";
import { OpenCodeHarness } from "../../src/harnesses/opencode.js";
import { bridgeHelper } from "../../src/bridge/connection.js";
import { deriveBridgeBearer } from "../../src/bridge/server.js";
import { writeOpenCodeLaunchCredential } from "../../src/opencode/launch-credential.js";
import { randomUUID } from "node:crypto";
import { withKrutrimCapabilityLock } from "../../src/capabilities/krutrim.js";

it.each((["opencode", "codex"] as const).flatMap((owner) =>
  (["SIGINT", "SIGTERM", "SIGKILL"] as const).map((signal) => [owner, signal] as const),
))("%s parent %s during credential read leaves no pre-record child", async (owner, signal) => {
  const run = await setup(owner, { blockKey: true });
  try {
    const childPid = await run.child();
    const entered = await until(async () => readFile(path.join(run.test.paths.appHome, "reading-key"), "utf8").catch(() => ""), (v) => v === "ready");
    expect(entered).toBe("ready");
    await kill(run.parent, signal);
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    expect(await readBridgeRuntime(owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile)).toBeNull();
  } finally { await run.cleanup(); }
}, 15000);

it("runtime metadata-write failure closes the listening server", async () => {
  const run = await setup("opencode", { metadataFailure: true });
  try {
    await run.message("metadata-failed");
    expect(await until(async () => run.parent.exitCode !== null, (v) => v)).toBe(true);
  } finally { await run.cleanup(); }
}, 10000);

it("spawn errors reject without publishing metadata or creating a child", async () => {
  const run = await setup("codex", { spawnError: true });
  try {
    expect((await run.message("failed")).message).toMatch(/ENOENT/);
    expect(await readBridgeRuntime(run.test.paths.codexBridgeRuntimeFile)).toBeNull();
    expect(await readFile(path.join(run.test.paths.appHome, "child.json"), "utf8").catch(() => null)).toBeNull();
  } finally { await run.cleanup(); }
}, 10000);

it("startup timeout terminates the child it created before rejecting", async () => {
  const run = await setup("opencode", { blockKey: true, timeout: 1000 });
  try {
    const childPid = await run.child();
    const failed = await run.message("failed");
    expect(failed.message).toMatch(/did not become healthy/);
    expect(running(childPid)).toBe(false);
  } finally { await run.cleanup(); }
}, 10000);

it.each(["opencode", "codex"] as const)("%s automatic activation commits a persistent bridge", async (owner) => {
  const run = await setup(owner, { activation: true });
  try {
    await run.child();
    await run.message("activated");
    const file = owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile;
    const record = await readBridgeRuntime(file);
    expect(record).not.toBeNull();
    await kill(run.parent);
    expect(await bridgeIsHealthy(record!)).toBe(true);
  } finally { await run.cleanup(); }
}, 15000);

it.each(["opencode", "codex"] as const)("%s activation failure after mutation restores config and state", async (owner) => {
  const run = await setup(owner, { activation: true, failAfter: true });
  try {
    const childPid = await run.child();
    expect((await run.message("failed")).message).toMatch(/fixture activation failed/);
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    const config = owner === "codex" ? run.test.paths.codexConfig : run.test.paths.openCodeConfig;
    const state = owner === "codex" ? run.test.paths.stateFile : run.test.paths.openCodeStateFile;
    expect(await readFile(config, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(state, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(run.test.paths.openCodeBridgeCredentialFile, "utf8").catch(() => null)).toBeNull();
  } finally { await run.cleanup(); }
}, 15000);

it.each(["opencode", "codex"] as const)("%s parent loss between config mutation and commit restores the connection", async (owner) => {
  const run = await setup(owner, { activation: true, pauseAfter: true });
  try {
    const childPid = await run.child();
    await run.message("mutated");
    const config = owner === "codex" ? run.test.paths.codexConfig : run.test.paths.openCodeConfig;
    const state = owner === "codex" ? run.test.paths.stateFile : run.test.paths.openCodeStateFile;
    expect(await readFile(config, "utf8")).toContain("127.0.0.1");
    await kill(run.parent);
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    expect(await readFile(config, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(state, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(run.test.paths.openCodeBridgeCredentialFile, "utf8").catch(() => null)).toBeNull();
  } finally { await run.cleanup(); }
}, 15000);

it.each((["opencode", "codex"] as const).flatMap((owner) =>
  (["SIGINT", "SIGTERM"] as const).map((signal) => [owner, signal] as const),
))("%s %s after mutation rolls back without a test release", async (owner, signal) => {
  const run = await setup(owner, { activation: true, signalAfter: signal });
  try {
    const childPid = await run.child();
    expect((await run.message("failed")).message).toMatch(/interrupted/);
    expect(running(childPid)).toBe(false);
    const config = owner === "codex" ? run.test.paths.codexConfig : run.test.paths.openCodeConfig;
    const state = owner === "codex" ? run.test.paths.stateFile : run.test.paths.openCodeStateFile;
    expect(await readFile(config, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(state, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(run.test.paths.openCodeBridgeCredentialFile, "utf8").catch(() => null)).toBeNull();
    expect(await readBridgeRuntime(owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile)).toBeNull();
  } finally { await run.cleanup(); }
}, 15000);

it.each(["resolve", "reject"])("late credential %s cannot resume a cancelled activation", async (outcome) => {
  const run = await setup("codex", { activation: true, lateActivationKey: outcome });
  try {
    const childPid = await run.child();
    await run.message("activation-reading-key");
    run.parent.kill("SIGTERM");
    expect((await run.message("failed")).message).toMatch(/interrupted/);
    expect(run.messages.some((m) => m.type === "credential-settled")).toBe(false);
    expect(running(childPid)).toBe(false);
    await run.message("credential-settled");
    expect(await until(async () => run.parent.exitCode, (v) => v !== null)).toBe(0);
    expect(await readFile(run.test.paths.codexConfig, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(run.test.paths.stateFile, "utf8").catch(() => null)).toBeNull();
    expect(await readdir(run.test.paths.codexModelCatalogDir).catch(() => [])).toEqual([]);
    expect(run.messages.some((m) => m.type === "activated")).toBe(false);
  } finally { await run.cleanup(); }
}, 10000);

it.each((["SIGINT", "SIGTERM"] as const).flatMap((signal) =>
  (["new", "replacement", "reused"] as const).map((mode) => [signal, mode] as const),
))("%s cancels %s activation with a never-resolving credential reader", async (signal, mode) => {
  let previous: BridgeRuntimeRecord | undefined;
  let serving: Promise<void> | undefined;
  let oldFiles: { file: string; content: string | null }[] = [];
  const run = await setup("codex", { activation: true, blockActivationKey: true }, async (test) => {
    if (mode !== "new") {
      const model = mode === "reused" ? "Qwen3.6-35B-A3B" : "gemma-4-E4B-it";
      serving = serveBridgeRuntime(test.paths.codexBridgeRuntimeFile, model, randomUUID(), "isolated-bridge-key");
      previous = (await until(() => readBridgeRuntime(test.paths.codexBridgeRuntimeFile), (v) => v !== null))!;
      await new CodexHarness(test.paths, { read: async () => "isolated-bridge-key" }, bridgeHelper(fixture, test.paths, previous.instanceId), testCatalogOptions)
        .enable({ ...supportedProvider, baseUrl: bridgeBaseUrl(previous) }, model);
    }
    const files = [test.paths.codexConfig, test.paths.stateFile];
    const saved = JSON.parse(await readFile(test.paths.stateFile, "utf8").catch(() => "{}")) as { codex?: { modelCatalogPath: string } };
    if (saved.codex) files.push(saved.codex.modelCatalogPath);
    oldFiles = await Promise.all(files.map(async (file) => ({ file, content: await readFile(file, "utf8").catch(() => null) })));
  });
  try {
    const childPid = mode === "reused" ? undefined : await run.child();
    await run.message("activation-reading-key");
    run.parent.kill(signal);
    // No release message: cancellation must settle with the reader blocked.
    expect((await run.message("failed")).message).toMatch(/interrupted/);
    await withKrutrimCapabilityLock(run.test.paths, async () => {});
    if (childPid !== undefined) expect(running(childPid)).toBe(false);
    for (const { file, content } of oldFiles) expect(await readFile(file, "utf8").catch(() => null), file).toBe(content);
    expect(await readBridgeRuntime(run.test.paths.codexBridgeRuntimeFile)).toEqual(previous ?? null);
    if (previous) expect(await bridgeIsHealthy(previous)).toBe(true);
  } finally {
    if (previous) await stopBridgeRuntime(run.test.paths.codexBridgeRuntimeFile, previous);
    await serving;
    await run.cleanup();
  }
}, 15000);

it.each((["opencode", "codex"] as const).flatMap((owner) =>
  (["parent-loss", "pending-fsync"] as const).map((fault) => [owner, fault] as const),
))("%s replacement %s keeps the old runtime discoverable and restores exact state", async (owner, fault) => {
  let previous!: BridgeRuntimeRecord;
  let serving!: Promise<void>;
  let oldFiles: { file: string; content: string | null }[] = [];
  const run = await setup(owner, { activation: true, pauseAfter: fault === "parent-loss", gateRuntimeSync: fault === "pending-fsync", failRuntimeSync: fault === "pending-fsync", timeout: 1000 }, async (test) => {
    const runtimeFile = owner === "codex" ? test.paths.codexBridgeRuntimeFile : test.paths.openCodeBridgeRuntimeFile;
    const model = "gemma-4-E4B-it";
    const key = "isolated-bridge-key";
    serving = serveBridgeRuntime(runtimeFile, model, randomUUID(), key);
    previous = (await until(() => readBridgeRuntime(runtimeFile), (v) => v !== null))!;
    if (owner === "codex") {
      await new CodexHarness(test.paths, { read: async () => key }, bridgeHelper(fixture, test.paths, previous.instanceId), testCatalogOptions)
        .enable({ ...supportedProvider, baseUrl: bridgeBaseUrl(previous) }, model);
    } else {
      await writeOpenCodeLaunchCredential(test.paths.openCodeBridgeCredentialFile, deriveBridgeBearer(key, previous.instanceId));
      await new OpenCodeHarness(test.paths).enable(model, bridgeBaseUrl(previous), { credentialFile: test.paths.openCodeBridgeCredentialFile });
    }
    const config = owner === "codex" ? test.paths.codexConfig : test.paths.openCodeConfig;
    const state = owner === "codex" ? test.paths.stateFile : test.paths.openCodeStateFile;
    const files = [config, state, test.paths.openCodeBridgeCredentialFile];
    if (owner === "codex") {
      const saved = JSON.parse(await readFile(state, "utf8")) as { codex: { modelCatalogPath: string } };
      files.push(saved.codex.modelCatalogPath);
    }
    oldFiles = await Promise.all(files.map(async (file) => ({ file, content: await readFile(file, "utf8").catch(() => null) })));
  });
  const runtimeFile = owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile;
  try {
    const childPid = await run.child();
    if (fault === "parent-loss") {
      await run.message("mutated");
      expect(await readBridgeRuntime(runtimeFile)).toEqual(previous);
      expect(await bridgeIsHealthy(previous)).toBe(true);
      await kill(run.parent);
    } else {
      expect(await until(async () => readFile(path.join(run.test.paths.appHome, "sync-pending"), "utf8").catch(() => ""), (v) => v === "ready")).toBe("ready");
      expect((await readBridgeRuntime(runtimeFile))?.pid).toBe(childPid);
      // The canonical rename is visible, but its durability has not completed.
      await new Promise((resolve) => setTimeout(resolve, 1300));
      expect(run.messages.some((m) => m.type === "activated")).toBe(false);
      await writeFile(path.join(run.test.paths.appHome, "release-sync"), "fail");
      await run.message("failed");
    }
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    expect(await readBridgeRuntime(runtimeFile)).toEqual(previous);
    expect(await bridgeIsHealthy(previous)).toBe(true);
    for (const { file, content } of oldFiles) expect(await readFile(file, "utf8").catch(() => null), file).toBe(content);
  } finally {
    await stopBridgeRuntime(runtimeFile, previous);
    await serving;
    await run.cleanup();
  }
}, 15000);

it.each((["opencode", "codex"] as const).flatMap((owner) =>
  [false, true].flatMap((failRuntimeSync) =>
    ["Qwen3.6-35B-A3B", "gemma-4-E4B-it"].map((model) => [owner, failRuntimeSync, model] as const)),
))("%s pending canonical runtime (fsync failure: %s) rejects a second activation for %s after parent death", async (owner, failRuntimeSync, model) => {
  let previous!: BridgeRuntimeRecord;
  let serving!: Promise<void>;
  let oldFiles: { file: string; content: string | null }[] = [];
  const run = await setup(owner, { activation: true, gateRuntimeSync: true, failRuntimeSync, timeout: 1000 }, async (test) => {
    const runtimeFile = owner === "codex" ? test.paths.codexBridgeRuntimeFile : test.paths.openCodeBridgeRuntimeFile;
    const key = "isolated-bridge-key";
    serving = serveBridgeRuntime(runtimeFile, "gemma-4-E4B-it", randomUUID(), key);
    previous = (await until(() => readBridgeRuntime(runtimeFile), (v) => v !== null))!;
    const files = owner === "codex" ? [test.paths.codexConfig, test.paths.stateFile] :
      [test.paths.openCodeConfig, test.paths.openCodeStateFile, test.paths.openCodeBridgeCredentialFile];
    if (owner === "codex") {
      await new CodexHarness(test.paths, { read: async () => key }, bridgeHelper(fixture, test.paths, previous.instanceId), testCatalogOptions)
        .enable({ ...supportedProvider, baseUrl: bridgeBaseUrl(previous) }, previous.model);
      const saved = JSON.parse(await readFile(test.paths.stateFile, "utf8")) as { codex: { modelCatalogPath: string } };
      files.push(saved.codex.modelCatalogPath);
    } else {
      await writeOpenCodeLaunchCredential(test.paths.openCodeBridgeCredentialFile, deriveBridgeBearer(key, previous.instanceId));
      await new OpenCodeHarness(test.paths).enable(previous.model, bridgeBaseUrl(previous), { credentialFile: test.paths.openCodeBridgeCredentialFile });
    }
    oldFiles = await Promise.all(files.map(async (file) => ({ file, content: await readFile(file, "utf8").catch(() => null) })));
  });
  const runtimeFile = owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile;
  let retry: ChildProcess | undefined;
  try {
    const childPid = await run.child();
    expect(await until(async () => readFile(path.join(run.test.paths.appHome, "sync-pending"), "utf8").catch(() => ""), (v) => v === "ready")).toBe("ready");
    const pending = (await readBridgeRuntime(runtimeFile))!;
    expect(pending.pid).toBe(childPid);
    expect(await bridgeIsHealthy(pending)).toBe(true);
    expect(await bridgeIsHealthy(pending, true)).toBe(false);
    await kill(run.parent);
    const files = [...oldFiles.map(({ file }) => file), runtimeFile, path.join(run.test.paths.appHome, "child.json")];
    if (owner === "codex") {
      const saved = JSON.parse(await readFile(run.test.paths.stateFile, "utf8")) as { codex: { modelCatalogPath: string } };
      files.push(saved.codex.modelCatalogPath);
    }
    const pendingFiles = await Promise.all(files.map(async (file) => ({ file, content: await readFile(file, "utf8").catch(() => null) })));
    const settings = path.join(run.test.paths.appHome, "fixture.json");
    await writeFile(settings, JSON.stringify({ paths: run.test.paths, owner, activation: true, model }));
    retry = spawn(process.execPath, [fixture, settings], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const [message] = await once(retry, "message") as [{ type: string; message?: string }];
    expect(message.type).toBe("failed");
    expect(message.message).toMatch(/activation.*pending.*retry/i);
    await kill(retry);
    for (const { file, content } of pendingFiles) expect(await readFile(file, "utf8").catch(() => null), file).toBe(content);
    expect(await readFile(`${runtimeFile}.activation.json`, "utf8").catch(() => null)).toBeNull();
    expect(await bridgeIsHealthy(pending)).toBe(true);
    expect(await bridgeIsHealthy(previous)).toBe(true);
    await writeFile(path.join(run.test.paths.appHome, "release-sync"), "release");
    if (failRuntimeSync) {
      expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
      expect(await readBridgeRuntime(runtimeFile)).toEqual(previous);
      expect(await bridgeIsHealthy(previous)).toBe(true);
      for (const { file, content } of oldFiles) expect(await readFile(file, "utf8").catch(() => null), file).toBe(content);
    } else {
      expect(await until(() => bridgeIsHealthy(pending, true), (v) => v)).toBe(true);
      expect(await until(() => bridgeIsHealthy(previous), (v) => !v)).toBe(false);
      for (const { file, content } of pendingFiles) expect(await readFile(file, "utf8").catch(() => null), file).toBe(content);
      // Once fsync succeeds a fresh automatic activation may reuse the child.
      await writeFile(settings, JSON.stringify({ paths: run.test.paths, owner, activation: true, model: pending.model }));
      retry = spawn(process.execPath, [fixture, settings], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
      const [committed] = await once(retry, "message") as [{ type: string }];
      expect(committed.type).toBe("activated");
      expect(await readBridgeRuntime(runtimeFile)).toEqual(pending);
      expect(JSON.parse(await readFile(path.join(run.test.paths.appHome, "child.json"), "utf8")).pid).toBe(childPid);
      expect(await bridgeIsHealthy(pending, true)).toBe(true);
    }
  } finally {
    if (retry) await kill(retry);
    // A broken replacement may have spawned a second child; retain both identities.
    const latest = JSON.parse(await readFile(path.join(run.test.paths.appHome, "child.json"), "utf8").catch(() => "null")) as { pid: number } | null;
    if (latest && running(latest.pid)) {
      process.kill(latest.pid, "SIGKILL");
      expect(await until(async () => running(latest.pid), (v) => !v)).toBe(false);
    }
    await stopBridgeRuntime(runtimeFile, previous);
    await serving;
    await run.cleanup();
  }
}, 15000);

it("a lost commit acknowledgement does not roll back a published activation", async () => {
  const run = await setup("opencode", { activation: true, dropCommitAck: true });
  try {
    const childPid = await run.child();
    await run.message("activated");
    const record = await readBridgeRuntime(run.test.paths.openCodeBridgeRuntimeFile);
    expect(record?.pid).toBe(childPid);
    expect(await bridgeIsHealthy(record!)).toBe(true);
    expect(await readFile(run.test.paths.openCodeConfig, "utf8")).toContain(bridgeBaseUrl(record!));
  } finally { await run.cleanup(); }
}, 10000);

it("commit retires the old runtime even if the parent dies before acknowledgement", async () => {
  let old!: BridgeRuntimeRecord;
  let serving!: Promise<void>;
  const run = await setup("opencode", { pauseCommitAck: true }, async (test) => {
    serving = serveBridgeRuntime(test.paths.openCodeBridgeRuntimeFile, "old-model", randomUUID(), "isolated-key");
    old = (await until(() => readBridgeRuntime(test.paths.openCodeBridgeRuntimeFile), (v) => v !== null))!;
  });
  try {
    await run.child();
    const { record } = await run.message("ready") as { record: BridgeRuntimeRecord };
    run.parent.send("commit");
    expect(await until(async () => readFile(path.join(run.test.paths.appHome, "commit-written"), "utf8").catch(() => ""), (v) => v === "ready")).toBe("ready");
    await kill(run.parent);
    expect(await bridgeIsHealthy(record)).toBe(true);
    expect(await until(() => bridgeIsHealthy(old), (v) => !v)).toBe(false);
  } finally {
    await stopBridgeRuntime(run.test.paths.openCodeBridgeRuntimeFile, old);
    await serving;
    await run.cleanup();
  }
}, 15000);

it("OpenCode parent loss after credential write but before creating config home restores the credential", async () => {
  const run = await setup("opencode", { activation: true, pauseBefore: true });
  try {
    const childPid = await run.child();
    await run.message("before-enable");
    expect(await readFile(run.test.paths.openCodeBridgeCredentialFile, "utf8")).not.toBe("");
    await kill(run.parent);
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    expect(await readFile(run.test.paths.openCodeBridgeCredentialFile, "utf8").catch(() => null)).toBeNull();
  } finally { await run.cleanup(); }
}, 10000);

it("runtime publication failure after rename restores the previous healthy record", async () => {
  let old!: BridgeRuntimeRecord;
  let serving!: Promise<void>;
  const run = await setup("opencode", { failRuntimeSync: true }, async (test) => {
    serving = serveBridgeRuntime(test.paths.openCodeBridgeRuntimeFile, "old-model", randomUUID(), "isolated-key");
    old = (await until(() => readBridgeRuntime(test.paths.openCodeBridgeRuntimeFile), (v) => v !== null))!;
  });
  try {
    const childPid = await run.child();
    await run.message("ready");
    run.parent.send("commit");
    await run.message("failed");
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    expect(await bridgeIsHealthy(old)).toBe(true);
    expect(await readBridgeRuntime(run.test.paths.openCodeBridgeRuntimeFile)).toEqual(old);
  } finally {
    await stopBridgeRuntime(run.test.paths.openCodeBridgeRuntimeFile, old);
    await serving;
    await run.cleanup();
  }
}, 15000);

it("credential-read startup errors leave no owned child", async () => {
  const run = await setup("codex", { rejectKey: true });
  try {
    const childPid = await run.child();
    expect((await run.message("failed")).message).toMatch(/exited before activation/);
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    expect(await readBridgeRuntime(run.test.paths.codexBridgeRuntimeFile)).toBeNull();
  } finally { await run.cleanup(); }
}, 10000);

it.each((["opencode", "codex"] as const).flatMap((owner) =>
  [false, true].map((afterMutation) => [owner, afterMutation] as const),
))("%s activation failure (after mutation: %s) never stops a reused healthy runtime", async (owner, afterMutation) => {
  let old!: BridgeRuntimeRecord;
  let serving!: Promise<void>;
  const run = await setup(owner, { activation: true, failBefore: !afterMutation, failAfter: afterMutation }, async (test) => {
    const file = owner === "codex" ? test.paths.codexBridgeRuntimeFile : test.paths.openCodeBridgeRuntimeFile;
    serving = serveBridgeRuntime(file, "Qwen3.6-35B-A3B", randomUUID(), "isolated-bridge-key");
    old = (await until(() => readBridgeRuntime(file), (v) => v !== null))!;
  });
  const file = owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile;
  try {
    expect((await run.message("failed")).message).toMatch(/fixture activation failed/);
    expect(await readFile(path.join(run.test.paths.appHome, "child.json"), "utf8").catch(() => null)).toBeNull();
    expect(await bridgeIsHealthy(old)).toBe(true);
    expect(await readBridgeRuntime(file)).toEqual(old);
    expect(await readFile(run.test.paths.openCodeBridgeCredentialFile, "utf8").catch(() => null)).toBeNull();
  } finally {
    await stopBridgeRuntime(file, old);
    await serving;
    await run.cleanup();
  }
}, 10000);

it("parent-loss rollback preserves external edits and private recovery data", async () => {
  const run = await setup("codex", { activation: true, pauseAfter: true });
  try {
    const childPid = await run.child();
    await run.message("mutated");
    await writeFile(run.test.paths.codexConfig, "# external edit\n");
    await kill(run.parent);
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    expect(await readFile(run.test.paths.codexConfig, "utf8")).toBe("# external edit\n");
    const files = await readdir(path.dirname(run.test.paths.codexBridgeRuntimeFile)).catch(() => []);
    expect(files.filter((file) => file.endsWith(".recovery.json"))).toHaveLength(1);
  } finally { await run.cleanup(); }
}, 10000);

it("parent loss closes in-flight local sockets instead of keeping the pending child alive", async () => {
  const run = await setup("opencode");
  let socket: Socket | undefined;
  try {
    const childPid = await run.child();
    const { record } = await run.message("ready") as { record: BridgeRuntimeRecord };
    socket = connect(record.port, "127.0.0.1");
    await once(socket, "connect");
    const response = once(socket, "data");
    socket.write(`POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${deriveBridgeBearer("isolated-bridge-key", record.instanceId)}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nExpect: 100-continue\r\n\r\n{`);
    expect(String((await response)[0])).toContain("100 Continue");
    await kill(run.parent);
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
  } finally { socket?.destroy(); await run.cleanup(); }
}, 10000);

it.each(["opencode", "codex"] as const)("%s interrupted reused activation is recovered before another activation", async (owner) => {
  let old!: BridgeRuntimeRecord;
  let serving!: Promise<void>;
  const run = await setup(owner, { activation: true, pauseAfter: true }, async (test) => {
    const file = owner === "codex" ? test.paths.codexBridgeRuntimeFile : test.paths.openCodeBridgeRuntimeFile;
    serving = serveBridgeRuntime(file, "Qwen3.6-35B-A3B", randomUUID(), "isolated-bridge-key");
    old = (await until(() => readBridgeRuntime(file), (v) => v !== null))!;
  });
  let retry: ChildProcess | undefined;
  const file = owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile;
  try {
    await run.message("mutated");
    await kill(run.parent);
    expect(await bridgeIsHealthy(old)).toBe(true);
    const settings = path.join(run.test.paths.appHome, "fixture.json");
    await writeFile(settings, JSON.stringify({ paths: run.test.paths, owner, activation: true, failBefore: true }));
    retry = spawn(process.execPath, [fixture, settings], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const [message] = await once(retry, "message") as [{ type: string }];
    expect(message.type).toBe("failed");
    const config = owner === "codex" ? run.test.paths.codexConfig : run.test.paths.openCodeConfig;
    const state = owner === "codex" ? run.test.paths.stateFile : run.test.paths.openCodeStateFile;
    expect(await readFile(config, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(state, "utf8").catch(() => null)).toBeNull();
    expect(await readFile(run.test.paths.openCodeBridgeCredentialFile, "utf8").catch(() => null)).toBeNull();
    expect(await bridgeIsHealthy(old)).toBe(true);
  } finally {
    if (retry) await kill(retry);
    await stopBridgeRuntime(file, old);
    await serving;
    await run.cleanup();
  }
}, 15000);

const fixture = fileURLToPath(new URL("../fixtures/bridge-lifecycle.mjs", import.meta.url));
async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value: T;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return value;
}
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function setup(owner: "codex" | "opencode", extra: object = {}, beforeStart?: (test: Awaited<ReturnType<typeof createTestWorkspace>>) => Promise<void>) {
  const test = await createTestWorkspace();
  await mkdir(test.paths.appHome, { recursive: true });
  const settings = path.join(test.paths.appHome, "fixture.json");
  await writeFile(settings, JSON.stringify({ paths: test.paths, owner, ...extra }));
  await beforeStart?.(test);
  const parent = spawn(process.execPath, [fixture, settings], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = "";
  parent.stderr!.on("data", (chunk) => { errors += String(chunk); });
  const messages: Record<string, unknown>[] = [];
  parent.on("message", (message) => messages.push(message as Record<string, unknown>));
  let childPid: number | undefined;
  return {
    test, parent, messages,
    async child() {
      // Node/tsx bootstrap can exceed three seconds on hosted Intel runners.
      const identity = await until(async () => JSON.parse(await readFile(path.join(test.paths.appHome, "child.json"), "utf8").catch(() => "null")) as { pid: number } | null, (v) => v !== null, 10000);
      expect(identity, `${errors}\n${JSON.stringify(messages)}`).not.toBeNull();
      childPid = identity!.pid;
      return childPid;
    },
    async message(type: string) {
      const message = await until(async () => messages.find((m) => m.type === type), (v) => v !== undefined, 10000);
      expect(message, `${errors}\n${JSON.stringify(messages)}`).toBeDefined();
      return message!;
    },
    async cleanup() {
      await kill(parent);
      childPid ??= JSON.parse(await readFile(path.join(test.paths.appHome, "child.json"), "utf8").catch(() => "null"))?.pid;
      // Only the PID reported by this isolated fixture is ever signalled.
      if (childPid !== undefined && running(childPid)) {
        process.kill(childPid, "SIGKILL");
        expect(await until(async () => running(childPid!), (v) => !v), "fixture child must exit before workspace cleanup").toBe(false);
      }
      await test.cleanup();
    },
  };
}
async function kill(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  await exited;
}

it.each(["opencode", "codex"] as const)("%s pending bridge exits when its parent is killed", async (owner) => {
  const run = await setup(owner);
  try {
    const childPid = await run.child();
    const ready = await run.message("ready");
    const record = ready.record as BridgeRuntimeRecord;
    expect(await bridgeIsHealthy(record)).toBe(true);
    await kill(run.parent);
    expect(await until(() => bridgeIsHealthy(record), (v) => !v)).toBe(false);
    expect(await until(async () => running(childPid), (v) => !v)).toBe(false);
    expect(await readBridgeRuntime(owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile)).toBeNull();
  } finally { await run.cleanup(); }
}, 15000);

it.each(["opencode", "codex"] as const)("%s publishes only on commit and survives successful parent exit", async (owner) => {
  const run = await setup(owner);
  try {
    await run.child();
    const { record } = await run.message("ready") as { record: BridgeRuntimeRecord };
    const runtimeFile = owner === "codex" ? run.test.paths.codexBridgeRuntimeFile : run.test.paths.openCodeBridgeRuntimeFile;
    expect(await readBridgeRuntime(runtimeFile)).toBeNull();
    run.parent.send("commit");
    await run.message("committed");
    expect(await readBridgeRuntime(runtimeFile)).toEqual(record);
    await kill(run.parent);
    expect(await bridgeIsHealthy(record)).toBe(true);
  } finally { await run.cleanup(); }
}, 15000);
