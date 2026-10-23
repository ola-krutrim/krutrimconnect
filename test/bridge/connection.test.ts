import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_EVIDENCE_SCHEMA_VERSION,
  CHAT_BRIDGE_FEASIBILITY_CONTRACT,
  sealBridgeProbeResult,
  writeBridgeEvidence,
  type BridgeProbeResult,
} from "../../src/bridge/evidence.js";
import {
  decideCodexRoute,
  enableCodexAutomatically,
  enableOpenCodeAutomatically,
  qualifyBridgeRoute,
  qualifyCodexRoute,
  shouldRetryBridgeQualification,
  type AutomaticCodexRouteDecision,
} from "../../src/bridge/connection.js";
import {
  bridgeIsHealthy,
  readBridgeRuntime,
  serveBridgeRuntime,
  stopBridgeRuntime,
  type BridgeRuntimeRecord,
} from "../../src/bridge/runtime.js";
import { deriveBridgeBearer } from "../../src/bridge/server.js";
import {
  CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  CODEX_RESPONSES_TOOL_CONTRACT,
  sealCapabilityProbeResult,
  type CapabilityProbeResult,
} from "../../src/capabilities/evidence.js";
import { OpenCodeHarness } from "../../src/harnesses/opencode.js";
import { krutrimProvider } from "../../src/providers/krutrim.js";
import {
  createTestWorkspace,
  testCatalogOptions,
  type TestWorkspace,
} from "../helpers.js";

const workspaces: TestWorkspace[] = [];
const qualificationApiKey = "automatic-qualification-key";
const qualificationTime = "2026-08-17T04:00:00.000Z";

function nativeProbeReport(model: string): CapabilityProbeResult {
  return {
    schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    contract: CODEX_RESPONSES_TOOL_CONTRACT,
    providerId: krutrimProvider.id,
    baseUrl: krutrimProvider.baseUrl,
    model,
    outcome: "failed",
    startedAt: qualificationTime,
    completedAt: qualificationTime,
    checks: {
      authentication: { status: "pass", detail: "authenticated" },
      responsesApi: { status: "pass", detail: "responses passed" },
      streaming: { status: "pass", detail: "streaming passed" },
      toolCalling: { status: "pass", detail: "tool loop passed" },
      codexCanary: { status: "fail", detail: "full Codex request failed" },
    },
    observations: {
      requestCount: 7,
      eventTypes: [
        "response.created",
        "response.output_item.added",
        "response.output_text.delta",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
        "response.completed",
      ],
    },
  };
}

function bridgeProbeReport(model: string): BridgeProbeResult {
  return {
    schemaVersion: BRIDGE_EVIDENCE_SCHEMA_VERSION,
    contract: CHAT_BRIDGE_FEASIBILITY_CONTRACT,
    providerId: krutrimProvider.id,
    baseUrl: krutrimProvider.baseUrl,
    model,
    outcome: "streaming-compatible",
    startedAt: qualificationTime,
    completedAt: qualificationTime,
    checks: {
      authentication: { status: "pass", detail: "authenticated" },
      nonStreamingToolCalling: { status: "pass", detail: "passed" },
      streamingToolCalling: { status: "pass", detail: "passed" },
      toolContinuation: { status: "pass", detail: "passed" },
      codexCanary: { status: "pass", detail: "passed" },
    },
    observations: { requestCount: 5, streamEventCount: 8, argumentDeltaCount: 2 },
  };
}

function retryableBridgeProbeReport(model: string): BridgeProbeResult {
  const report = bridgeProbeReport(model);
  return {
    ...report,
    outcome: "failed",
    checks: {
      ...report.checks,
      toolContinuation: { status: "fail", detail: "model omitted the tool result once" },
      codexCanary: { status: "not-run", detail: "not run after continuation failure" },
    },
  };
}

function missingDecision(): AutomaticCodexRouteDecision {
  return {
    native: {
      status: "missing",
      detail: "missing",
      capabilities: krutrimProvider.capabilities,
    },
  };
}

function bridgeDecision(): AutomaticCodexRouteDecision {
  return {
    ...missingDecision(),
    mode: "bridge",
    bridge: { status: "valid", usable: true, detail: "valid bridge" },
  };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (workspace) => await workspace.cleanup()));
});

describe("automatic Codex route selection", () => {
  it("selects a valid streaming bridge when native Responses evidence is absent", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const apiKey = "route-decision-test-key";
    const completedAt = "2026-08-13T05:00:00.000Z";
    const report: BridgeProbeResult = {
      schemaVersion: BRIDGE_EVIDENCE_SCHEMA_VERSION,
      contract: CHAT_BRIDGE_FEASIBILITY_CONTRACT,
      providerId: krutrimProvider.id,
      baseUrl: krutrimProvider.baseUrl,
      model: "bridge-model",
      outcome: "streaming-compatible",
      startedAt: "2026-08-13T04:59:00.000Z",
      completedAt,
      checks: {
        authentication: { status: "pass", detail: "passed" },
        nonStreamingToolCalling: { status: "pass", detail: "passed" },
        streamingToolCalling: { status: "pass", detail: "passed" },
        toolContinuation: { status: "pass", detail: "passed" },
        codexCanary: { status: "pass", detail: "passed" },
      },
      observations: { requestCount: 5, streamEventCount: 8, argumentDeltaCount: 2 },
    };
    await writeBridgeEvidence(test.paths.bridgeEvidenceDir, sealBridgeProbeResult(report, apiKey));

    const decision = await decideCodexRoute(
      test.paths,
      report.model,
      apiKey,
      new Date(completedAt),
    );
    expect(decision.mode).toBe("bridge");
    expect(decision.native.status).toBe("missing");
    expect(decision.bridge).toMatchObject({ status: "valid", usable: true });
  });

  it("does not select a bridge for the wrong credential", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const decision = await decideCodexRoute(
      test.paths,
      "bridge-model",
      "no-matching-evidence",
      new Date("2026-08-13T05:00:00.000Z"),
    );
    expect(decision.mode).toBeUndefined();
    expect(decision.native.status).toBe("missing");
    expect(decision.bridge).toMatchObject({ status: "missing", usable: false });
  });

  it("does not select bridge evidence whose full Codex canary failed", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const apiKey = "route-canary-failure-key";
    const completedAt = "2026-08-13T05:00:00.000Z";
    const report: BridgeProbeResult = {
      schemaVersion: BRIDGE_EVIDENCE_SCHEMA_VERSION,
      contract: CHAT_BRIDGE_FEASIBILITY_CONTRACT,
      providerId: krutrimProvider.id,
      baseUrl: krutrimProvider.baseUrl,
      model: "bridge-canary-failed-model",
      outcome: "failed",
      startedAt: "2026-08-13T04:59:00.000Z",
      completedAt,
      checks: {
        authentication: { status: "pass", detail: "passed" },
        nonStreamingToolCalling: { status: "pass", detail: "passed" },
        streamingToolCalling: { status: "pass", detail: "passed" },
        toolContinuation: { status: "pass", detail: "passed" },
        codexCanary: { status: "fail", detail: "full Codex payload rejected" },
      },
      observations: { requestCount: 5, streamEventCount: 8, argumentDeltaCount: 2 },
    };
    await writeBridgeEvidence(test.paths.bridgeEvidenceDir, sealBridgeProbeResult(report, apiKey));

    const decision = await decideCodexRoute(test.paths, report.model, apiKey, new Date(completedAt));
    expect(decision.mode).toBeUndefined();
    expect(decision.bridge).toMatchObject({ status: "failed", usable: false });
  });
});

describe("one-command automatic qualification", () => {
  it("retries authenticated bridge probes but not authentication failures", () => {
    expect(shouldRetryBridgeQualification(retryableBridgeProbeReport("transient-model"))).toBe(true);
    const authenticationFailure = retryableBridgeProbeReport("unauthorized-model");
    authenticationFailure.checks.authentication = { status: "inconclusive", detail: "unauthorized" };
    expect(shouldRetryBridgeQualification(authenticationFailure)).toBe(false);
  });

  it("reuses valid cached Codex evidence without running inference", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const nativeProbe = vi.fn();
    const bridgeProbe = vi.fn();

    const result = await qualifyCodexRoute(
      test.paths,
      "cached-bridge-model",
      qualificationApiKey,
      {
        decideRoute: async () => bridgeDecision(),
        nativeProbe,
        bridgeProbe,
      },
    );

    expect(result).toMatchObject({ usedCachedEvidence: true, decision: { mode: "bridge" } });
    expect(nativeProbe).not.toHaveBeenCalled();
    expect(bridgeProbe).not.toHaveBeenCalled();
  });

  it("runs native then bridge qualification internally and selects the established route", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "automatic-bridge-model";
    const decisions = [missingDecision(), missingDecision(), bridgeDecision()];
    const stages: string[] = [];
    const nativeProbe = vi.fn(async () => nativeProbeReport(model));
    const bridgeProbe = vi.fn(async () => bridgeProbeReport(model));

    const result = await qualifyCodexRoute(test.paths, model, qualificationApiKey, {
      decideRoute: async () => decisions.shift() ?? bridgeDecision(),
      nativeProbe,
      bridgeProbe,
      onStage: (stage) => stages.push(stage),
    });

    expect(result).toMatchObject({ usedCachedEvidence: false, decision: { mode: "bridge" } });
    expect(stages).toEqual(["native", "bridge"]);
    expect(nativeProbe).toHaveBeenCalledOnce();
    expect(bridgeProbe).toHaveBeenCalledOnce();
  });

  it("retries a transient Codex bridge qualification up to twice", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "transient-codex-bridge-model";
    const decisions = [missingDecision(), missingDecision(), bridgeDecision()];
    const bridgeProbe = vi.fn()
      .mockResolvedValueOnce(retryableBridgeProbeReport(model))
      .mockResolvedValueOnce(retryableBridgeProbeReport(model))
      .mockResolvedValueOnce(bridgeProbeReport(model));

    const result = await qualifyCodexRoute(test.paths, model, qualificationApiKey, {
      decideRoute: async () => decisions.shift() ?? bridgeDecision(),
      nativeProbe: async () => nativeProbeReport(model),
      bridgeProbe,
      retryDelay: async () => undefined,
    });

    expect(result.decision.mode).toBe("bridge");
    expect(result.bridgeProbe?.outcome).toBe("streaming-compatible");
    expect(bridgeProbe).toHaveBeenCalledTimes(3);
  });

  it("does not repeat a current authenticated native failure before trying the bridge", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "known-native-failure";
    const knownFailure = missingDecision();
    knownFailure.native = {
      status: "partial",
      detail: "native canary failed",
      capabilities: krutrimProvider.capabilities,
      evidence: sealCapabilityProbeResult(nativeProbeReport(model), qualificationApiKey),
    };
    const decisions = [knownFailure, bridgeDecision()];
    const nativeProbe = vi.fn();
    const bridgeProbe = vi.fn(async () => bridgeProbeReport(model));

    const result = await qualifyCodexRoute(test.paths, model, qualificationApiKey, {
      decideRoute: async () => decisions.shift() ?? bridgeDecision(),
      nativeProbe,
      bridgeProbe,
    });

    expect(result.decision.mode).toBe("bridge");
    expect(nativeProbe).not.toHaveBeenCalled();
    expect(bridgeProbe).toHaveBeenCalledOnce();
  });

  it("qualifies OpenCode's bridge internally only when cached evidence is unavailable", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "automatic-opencode-model";
    const resolutions = [
      { status: "missing" as const, usable: false, detail: "missing" },
      { status: "valid" as const, usable: true, detail: "valid" },
    ];
    const bridgeProbe = vi.fn(async () => bridgeProbeReport(model));

    const result = await qualifyBridgeRoute(test.paths, model, qualificationApiKey, {
      resolveBridge: async () => resolutions.shift() ?? resolutions[0]!,
      bridgeProbe,
    });

    expect(result).toMatchObject({ usedCachedEvidence: false, resolution: { usable: true } });
    expect(bridgeProbe).toHaveBeenCalledOnce();
  });

  it("retries a transient OpenCode bridge qualification up to twice", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "transient-opencode-bridge-model";
    const resolutions = [
      { status: "missing" as const, usable: false, detail: "missing" },
      { status: "valid" as const, usable: true, detail: "valid" },
    ];
    const bridgeProbe = vi.fn()
      .mockResolvedValueOnce(retryableBridgeProbeReport(model))
      .mockResolvedValueOnce(retryableBridgeProbeReport(model))
      .mockResolvedValueOnce(bridgeProbeReport(model));

    const result = await qualifyBridgeRoute(test.paths, model, qualificationApiKey, {
      resolveBridge: async () => resolutions.shift() ?? resolutions[0]!,
      bridgeProbe,
      retryDelay: async () => undefined,
    });

    expect(result.resolution.usable).toBe(true);
    expect(result.bridgeProbe?.outcome).toBe("streaming-compatible");
    expect(bridgeProbe).toHaveBeenCalledTimes(3);
  });
});

interface ServedBridge {
  runtimeFile: string;
  record: BridgeRuntimeRecord;
  serving: Promise<void>;
}

async function waitForBridgeRuntime(runtimeFile: string): Promise<BridgeRuntimeRecord> {
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

async function serveTestBridge(
  runtimeFile: string,
  model: string,
  apiKey: string,
): Promise<ServedBridge> {
  const serving = serveBridgeRuntime(runtimeFile, model, randomUUID(), apiKey);
  return {
    runtimeFile,
    record: await waitForBridgeRuntime(runtimeFile),
    serving,
  };
}

async function stopTestBridge(active: ServedBridge): Promise<void> {
  const current = await readBridgeRuntime(active.runtimeFile).catch(() => null);
  if (current !== null) {
    await stopBridgeRuntime(active.runtimeFile, current);
  }
  await active.serving;
}

describe("simultaneous Codex and OpenCode activation", () => {
  const cases = [
    ["Codex then OpenCode", ["codex", "opencode"] as const],
    ["OpenCode then Codex", ["opencode", "codex"] as const],
  ] as const;

  it.each(cases)("%s supports different bridge models", async (_name, order) => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const apiKey = "simultaneous-activation-key";
    const codexModel = "Qwen3.6-35B-A3B";
    const openCodeModel = "gemma-4-E4B-it";
    for (const model of [codexModel, openCodeModel]) {
      await writeBridgeEvidence(
        test.paths.bridgeEvidenceDir,
        sealBridgeProbeResult(bridgeProbeReport(model), apiKey),
      );
    }

    const activeBridges = [
      await serveTestBridge(test.paths.codexBridgeRuntimeFile, codexModel, apiKey),
      await serveTestBridge(test.paths.openCodeBridgeRuntimeFile, openCodeModel, apiKey),
    ];
    try {
      for (const harness of order) {
        if (harness === "codex") {
          await enableCodexAutomatically(
            test.paths,
            "/test/krutrimconnect.js",
            { read: async () => apiKey },
            codexModel,
            new Date(qualificationTime),
            { codexHarnessOptions: testCatalogOptions },
          );
        } else {
          await enableOpenCodeAutomatically(
            test.paths,
            "/test/krutrimconnect.js",
            { read: async () => apiKey },
            openCodeModel,
            new Date(qualificationTime),
          );
        }
      }

      expect(await test.harness.status()).toMatchObject({
        state: "connected",
        model: codexModel,
        connectionMode: "bridge",
      });
      expect(await new OpenCodeHarness(test.paths).status()).toMatchObject({
        state: "connected",
        model: openCodeModel,
        connectionMode: "bridge",
      });
      const codexRuntime = await readBridgeRuntime(test.paths.codexBridgeRuntimeFile);
      const openCodeRuntime = await readBridgeRuntime(test.paths.openCodeBridgeRuntimeFile);
      expect(codexRuntime).toMatchObject({ model: codexModel });
      expect(openCodeRuntime).toMatchObject({ model: openCodeModel });
      expect(codexRuntime?.port).not.toBe(openCodeRuntime?.port);
      expect(await readFile(test.paths.openCodeBridgeCredentialFile, "utf8")).toBe(
        deriveBridgeBearer(apiKey, openCodeRuntime!.instanceId),
      );
      expect(JSON.parse(await readFile(test.paths.openCodeConfig, "utf8"))).toMatchObject({
        provider: {
          krutrim: {
            options: { apiKey: `{file:${test.paths.openCodeBridgeCredentialFile}}` },
          },
        },
      });
      expect(await readFile(test.paths.openCodeConfig, "utf8")).not.toContain(apiKey);

      await stopBridgeRuntime(test.paths.codexBridgeRuntimeFile, codexRuntime!);
      await activeBridges[0]!.serving;
      expect(await bridgeIsHealthy(openCodeRuntime!)).toBe(true);
    } finally {
      await Promise.all(activeBridges.map(stopTestBridge));
    }
  });
});
