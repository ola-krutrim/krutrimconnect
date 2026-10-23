import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  adoptLegacyBridgeRuntime,
  bridgeIsHealthy,
  readBridgeRuntime,
  serveBridgeRuntime,
  startBridgeRuntime,
  stopBridgeRuntime,
  type BridgeRuntimeRecord,
} from "../../src/bridge/runtime.js";
import { createTestWorkspace, type TestWorkspace } from "../helpers.js";
import { BRIDGE_RUNTIME_CONTRACT } from "../../src/bridge/server.js";

it.each(["committed", "legacy", "pending", "null-marker", "string-marker", "failed-auth", "bad-json", "wrong-contract", "wrong-model", "bad-content-type"])(
  "authenticated %s health is not confused with a reusable committed runtime", async (kind) => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const record: BridgeRuntimeRecord = {
      version: 1, instanceId: randomUUID(), controlToken: "a".repeat(64), pid: process.pid,
      host: "127.0.0.1", port: 1, model: "fixture-model", startedAt: new Date().toISOString(),
    };
    const server = createServer((request, response) => {
      const authenticated = request.headers["x-krutrim-connect-instance"] === record.controlToken;
      response.writeHead(authenticated && kind !== "failed-auth" ? 200 : 403, {
        "Content-Type": kind === "bad-content-type" ? "text/plain" : "application/json",
      });
      const health = {
        model: kind === "wrong-model" ? "wrong" : record.model,
        contract: kind === "wrong-contract" ? "wrong" : BRIDGE_RUNTIME_CONTRACT,
        ...(kind === "legacy" ? {} : { activationCommitted: kind === "pending" ? false :
          kind === "null-marker" ? null : kind === "string-marker" ? "true" : true }),
      };
      response.end(kind === "bad-json" ? "{" : JSON.stringify(health));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    record.port = (server.address() as { port: number }).port;
    const runtimeFile = test.paths.openCodeBridgeRuntimeFile;
    try {
      await mkdir(path.dirname(runtimeFile), { recursive: true });
      const original = JSON.stringify(record);
      await writeFile(runtimeFile, original, { mode: 0o600 });
      expect(await bridgeIsHealthy(record)).toBe(["committed", "legacy", "pending"].includes(kind));
      expect(await bridgeIsHealthy(record, true)).toBe(kind === "committed");
      const start = startBridgeRuntime(test.paths, path.join(test.paths.appHome, "missing-entrypoint.mjs"), "opencode", record.model, { startupTimeoutMs: 1000 });
      if (kind === "committed" || kind === "legacy") {
        const reused = await start;
        expect(reused.started).toBe(false);
        expect(reused.record).toEqual(record);
        await reused.commit();
        await reused.abort();
      } else if (kind === "pending") {
        await expect(start).rejects.toThrow(/activation.*pending.*retry/i);
      } else {
        // An unhealthy response must never select no-op committed reuse.
        await expect(start).rejects.toThrow(/exited before activation/);
      }
      expect(await readBridgeRuntime(runtimeFile)).toEqual(record);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  },
);

interface ActiveBridge {
  runtimeFile: string;
  record: BridgeRuntimeRecord;
  serving: Promise<void>;
}

const activeBridges: ActiveBridge[] = [];
const workspaces: TestWorkspace[] = [];

async function waitForRuntime(runtimeFile: string): Promise<BridgeRuntimeRecord> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const record = await readBridgeRuntime(runtimeFile);
    if (record !== null && await bridgeIsHealthy(record)) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for bridge runtime: ${runtimeFile}`);
}

async function startBridge(
  runtimeFile: string,
  model: string,
  apiKey = "isolated-runtime-test-key",
): Promise<ActiveBridge> {
  const serving = serveBridgeRuntime(
    runtimeFile,
    model,
    randomUUID(),
    apiKey,
  );
  const active = {
    runtimeFile,
    record: await waitForRuntime(runtimeFile),
    serving,
  };
  activeBridges.push(active);
  return active;
}

afterEach(async () => {
  for (const active of activeBridges.splice(0).reverse()) {
    const record = await readBridgeRuntime(active.runtimeFile).catch(() => null);
    if (record !== null) {
      await stopBridgeRuntime(active.runtimeFile, record).catch(() => undefined);
    }
    await active.serving.catch(() => undefined);
  }
  await Promise.all(workspaces.splice(0).map(async (workspace) => await workspace.cleanup()));
});

describe("per-harness bridge runtimes", () => {
  it("keeps different Codex and OpenCode models healthy at the same time", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const codex = await startBridge(
      test.paths.codexBridgeRuntimeFile,
      "Qwen3.6-35B-A3B",
    );
    const opencode = await startBridge(
      test.paths.openCodeBridgeRuntimeFile,
      "gemma-4-E4B-it",
    );

    expect(codex.record.model).toBe("Qwen3.6-35B-A3B");
    expect(opencode.record.model).toBe("gemma-4-E4B-it");
    expect(codex.record.port).not.toBe(opencode.record.port);

    await stopBridgeRuntime(test.paths.codexBridgeRuntimeFile, codex.record);
    await codex.serving;
    expect(await bridgeIsHealthy(opencode.record)).toBe(true);
  });

  it("adopts an exclusive legacy singleton without restarting it", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const legacy = await startBridge(
      test.paths.bridgeRuntimeFile,
      "Qwen3.6-35B-A3B",
    );

    const adopted = await adoptLegacyBridgeRuntime(test.paths, "codex");

    expect(adopted).toEqual(legacy.record);
    expect(await readBridgeRuntime(test.paths.bridgeRuntimeFile)).toBeNull();
    expect(await readBridgeRuntime(test.paths.codexBridgeRuntimeFile)).toEqual(
      legacy.record,
    );
    expect(await bridgeIsHealthy(legacy.record)).toBe(true);

    await stopBridgeRuntime(test.paths.codexBridgeRuntimeFile, legacy.record);
    await legacy.serving;
  });

  it("never sends /shutdown to a foreign process on a stale port (KAPI-17721)", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const record: BridgeRuntimeRecord = {
      version: 1, instanceId: randomUUID(), controlToken: "b".repeat(64), pid: process.pid,
      host: "127.0.0.1", port: 1, model: "fixture-model", startedAt: new Date().toISOString(),
    };
    const requests: string[] = [];
    // Unrelated app squatting the old bridge port; rejects the health check.
    const sentinel = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.writeHead(403, { "Content-Type": "text/plain" });
      response.end("not your bridge");
    });
    sentinel.listen(0, "127.0.0.1");
    await once(sentinel, "listening");
    record.port = (sentinel.address() as { port: number }).port;
    const runtimeFile = test.paths.codexBridgeRuntimeFile;
    try {
      await mkdir(path.dirname(runtimeFile), { recursive: true });
      await writeFile(runtimeFile, JSON.stringify(record), { mode: 0o600 });
      const stopped = await stopBridgeRuntime(runtimeFile, record);
      expect(stopped).toBe(true);
      expect(requests.some((line) => line.includes("/shutdown"))).toBe(false);
      expect(await readBridgeRuntime(runtimeFile)).toBeNull();
    } finally {
      sentinel.closeAllConnections();
      await new Promise<void>((resolve, reject) => sentinel.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("still shuts down a genuine bridge that identifies itself", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const bridge = await startBridge(test.paths.codexBridgeRuntimeFile, "Qwen3.6-35B-A3B");
    expect(await bridgeIsHealthy(bridge.record)).toBe(true);
    expect(await stopBridgeRuntime(bridge.runtimeFile, bridge.record)).toBe(true);
    await bridge.serving;
    expect(await bridgeIsHealthy(bridge.record)).toBe(false);
  });
});
