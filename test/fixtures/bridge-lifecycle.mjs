import { register } from "tsx/esm/api";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
register();
// Windows process.kill terminates instead of delivering a catchable console signal.
// Simulate the Node console event over fixture IPC; forced parent death is tested separately.
const fixtureSignal = value => {
  if (value?.fixtureSignal === "SIGINT" || value?.fixtureSignal === "SIGTERM") process.emit(value.fixtureSignal);
};
const loopbackFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error(`Fixture forbids external network: ${url.origin}`);
  return loopbackFetch(input, options);
};
const runtime = await import("../../src/bridge/runtime.ts");
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (args[0] === "_bridge") {
  const appHome = option("--app-home");
  const settings = JSON.parse(await readFile(path.join(appHome, "fixture.json"), "utf8"));
  // These files are test-owned process identity/readiness handshakes, not timings.
  await writeFile(path.join(appHome, "child.tmp"), JSON.stringify({ pid: process.pid }));
  await rename(path.join(appHome, "child.tmp"), path.join(appHome, "child.json"));
  if (settings.dropCommitAck || settings.pauseCommitAck) {
    const send = process.send.bind(process);
    process.send = (message, callback) => {
      if (message.type !== "committed") return send(message, callback);
      if (settings.pauseCommitAck) {
        void writeFile(path.join(appHome, "commit-written"), "ready");
        return true;
      }
      callback?.(null);
      return true;
    };
  }
  if (settings.failRuntimeSync || settings.gateRuntimeSync) {
    let runtimeSyncIntercepted = false;
    const open = fs.promises.open;
    fs.promises.open = async (...args) => {
      const handle = process.platform === "win32" && args[0] === path.join(appHome, "runtime")
        ? { sync: async () => {}, close: async () => {} } : await open(...args);
      if (args[0] === path.join(appHome, "runtime")) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const record = await readFile(path.join(appHome, "runtime", `${option("--owner")}.json`), "utf8").catch(() => "{}");
          if (!runtimeSyncIntercepted && JSON.parse(record).instanceId === option("--instance")) {
            // Fault only publication, not subsequent token/config rollback syncs.
            runtimeSyncIntercepted = true;
            if (settings.gateRuntimeSync) {
              await writeFile(path.join(appHome, "sync-pending"), "ready");
              while (!(await readFile(path.join(appHome, "release-sync"), "utf8").catch(() => ""))) {
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            }
            if (settings.failRuntimeSync) throw new Error("fixture directory sync failure after rename");
          }
          return await sync();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
  }
  const readKey = async () => {
    await writeFile(path.join(appHome, "reading-key"), "ready");
    if (settings.rejectKey) throw new Error("fixture credential reader failed");
    if (settings.blockKey) await new Promise(() => setInterval(() => {}, 1000));
    return "isolated-bridge-key";
  };
  await runtime.serveBridgeRuntime(
    path.join(appHome, "runtime", `${option("--owner")}.json`),
    option("--model"), option("--instance"), settings.blockKey || settings.rejectKey ? readKey : "isolated-bridge-key",
  );
} else {
  const settings = JSON.parse(await readFile(args[0], "utf8"));
  if (settings.spawnError) {
    const spawn = childProcess.spawn;
    childProcess.spawn = (_executable, args, options) => spawn(path.join(settings.paths.appHome, "missing-executable"), args, options);
    syncBuiltinESMExports();
  }
  if (settings.metadataFailure) {
    const target = settings.paths.openCodeBridgeRuntimeFile;
    await mkdir(target, { recursive: true });
    await runtime.serveBridgeRuntime(target, "fixture-model", "metadata-test", "isolated-key")
      .catch(() => process.send({ type: "metadata-failed" }));
    process.disconnect();
  } else if (settings.activation) {
    if (process.platform === "win32") process.on("message", fixtureSignal);
    const { enableCodexAutomatically, enableOpenCodeAutomatically } = await import("../../src/bridge/connection.ts");
    const { writeBridgeEvidence, sealBridgeProbeResult, BRIDGE_EVIDENCE_SCHEMA_VERSION, CHAT_BRIDGE_FEASIBILITY_CONTRACT } = await import("../../src/bridge/evidence.ts");
    const { krutrimProvider } = await import("../../src/providers/krutrim.ts");
    const { testCatalogOptions, supportedProvider } = await import("../helpers.ts");
    const { OpenCodeHarness } = await import("../../src/harnesses/opencode.ts");
    const { CodexHarness } = await import("../../src/harnesses/codex.ts");
    const key = "isolated-bridge-key";
    const model = settings.model ?? "Qwen3.6-35B-A3B";
    const now = new Date();
    const pass = { status: "pass", detail: "isolated fixture; no inference" };
    await writeBridgeEvidence(settings.paths.bridgeEvidenceDir, sealBridgeProbeResult({
      schemaVersion: BRIDGE_EVIDENCE_SCHEMA_VERSION, contract: CHAT_BRIDGE_FEASIBILITY_CONTRACT,
      providerId: krutrimProvider.id, baseUrl: krutrimProvider.baseUrl, model,
      outcome: "streaming-compatible", startedAt: now.toISOString(), completedAt: now.toISOString(),
      checks: { authentication: pass, nonStreamingToolCalling: pass, streamingToolCalling: pass, toolContinuation: pass, codexCanary: pass },
      observations: { requestCount: 5, streamEventCount: 8, argumentDeltaCount: 2 },
    }, key));
    const harness = settings.owner === "codex" ? CodexHarness : OpenCodeHarness;
    const original = harness.prototype.enable;
    harness.prototype.enable = async function (...args) {
      if (settings.pauseBefore) {
        process.send({ type: "before-enable" });
        await new Promise((resolve) => process.once("message", resolve));
      }
      if (settings.failBefore) throw new Error("fixture activation failed");
      const result = await original.apply(this, args);
      if (settings.signalAfter) {
        await new Promise((resolve) => {
          process.once(settings.signalAfter, resolve);
          (process.platform === "win32" ? process.emit(settings.signalAfter) : process.kill(process.pid, settings.signalAfter));
        });
      }
      if (settings.pauseAfter) {
        for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.send({ type: "interrupted" }));
        process.send({ type: "mutated" });
        await new Promise((resolve) => process.once("message", resolve));
      }
      if (settings.failAfter) throw new Error("fixture activation failed after mutation");
      return result;
    };
    let reads = 0;
    const credentialHandle = settings.blockActivationKey ? setInterval(() => {}, 1000) : undefined;
    const secrets = { read: async () => {
      if ((settings.blockActivationKey || settings.lateActivationKey) && ++reads === 2) {
        process.send({ type: "activation-reading-key" });
        if (settings.lateActivationKey) {
          return await new Promise((resolve, reject) => setTimeout(() => {
            process.send({ type: "credential-settled" });
            if (settings.lateActivationKey === "reject") reject(new Error("late credential failure"));
            else resolve(key);
          }, 1200));
        }
        // Never released by a signal or by the test. A native approval request
        // may likewise remain outstanding after its caller is cancelled.
        await new Promise(() => {});
      }
      return key;
    } };
    try {
      const directActivation = async () => {
        const { activateBridge } = await import("../../src/bridge/activation.ts");
        const { bridgeHelper } = await import("../../src/bridge/connection.ts");
        const { writeOpenCodeLaunchCredential } = await import("../../src/opencode/launch-credential.ts");
        const { deriveBridgeBearer } = await import("../../src/bridge/server.ts");
        const started = await runtime.startBridgeRuntime(settings.paths, import.meta.filename, settings.owner, model, { startupTimeoutMs: settings.timeout });
        return await activateBridge(settings.paths, settings.owner, started, async () => {
          if (settings.owner === "codex") return await new CodexHarness(settings.paths, { read: async () => key }, bridgeHelper(import.meta.filename, settings.paths, started.record.instanceId), testCatalogOptions)
            .enable({ ...supportedProvider, baseUrl: runtime.bridgeBaseUrl(started.record) }, model);
          await writeOpenCodeLaunchCredential(settings.paths.openCodeBridgeCredentialFile, deriveBridgeBearer(key, started.record.instanceId));
          return await new OpenCodeHarness(settings.paths).enable(model, runtime.bridgeBaseUrl(started.record), { credentialFile: settings.paths.openCodeBridgeCredentialFile });
        });
      };
      const { withKrutrimCapabilityLock } = await import("../../src/capabilities/krutrim.ts");
      const result = settings.gateRuntimeSync ? await withKrutrimCapabilityLock(settings.paths, directActivation) : settings.owner === "codex"
        ? await enableCodexAutomatically(settings.paths, import.meta.filename, secrets, model, now, { codexHarnessOptions: testCatalogOptions })
        : await enableOpenCodeAutomatically(settings.paths, import.meta.filename, { read: async () => key }, model, now);
      process.send({ type: "activated", result });
    } catch (error) { process.send({ type: "failed", message: error.message }); }
    finally { clearInterval(credentialHandle); process.removeListener("message", fixtureSignal); }
  } else try {
    const started = await runtime.startBridgeRuntime(settings.paths, import.meta.filename,
      settings.owner, "fixture-model", { startupTimeoutMs: settings.timeout ?? 5000 });
    process.send({ type: "ready", record: started.record, started: started.started });
    process.on("message", async (message) => {
      if (message === "commit") {
        try {
          await started.commit();
          process.send({ type: "committed" });
        } catch (error) {
          process.send({ type: "failed", message: error.message });
        }
      }
      if (message === "exit") process.exit(0);
    });
  } catch (error) {
    process.send({ type: "failed", message: error.message });
  }
}
