import { afterEach, describe, expect, it } from "vitest";
import { readdir } from "node:fs/promises";

import {
  CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  CODEX_RESPONSES_TOOL_CONTRACT,
  readCapabilityEvidence,
  sealCapabilityProbeResult,
  writeCapabilityEvidence,
  type CapabilityProbeResult,
} from "../../src/capabilities/evidence.js";
import {
  probeAndStoreKrutrimCapabilities,
  withResolvedKrutrimProviderForModel,
} from "../../src/capabilities/krutrim.js";
import { krutrimProvider } from "../../src/providers/krutrim.js";
import {
  createTestWorkspace,
  testCatalogOptions,
  type TestWorkspace,
} from "../helpers.js";

const workspaces: TestWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (item) => await item.cleanup()));
});

function passingReport(model: string): CapabilityProbeResult {
  return {
    schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    contract: CODEX_RESPONSES_TOOL_CONTRACT,
    providerId: krutrimProvider.id,
    baseUrl: krutrimProvider.baseUrl,
    model,
    outcome: "passed",
    startedAt: "2026-08-11T04:59:00.000Z",
    completedAt: "2026-08-11T05:00:00.000Z",
    checks: {
      authentication: { status: "pass", detail: "pass" },
      responsesApi: { status: "pass", detail: "pass" },
      streaming: { status: "pass", detail: "pass" },
      toolCalling: { status: "pass", detail: "pass" },
      codexCanary: { status: "pass", detail: "full Codex pass" },
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

describe("Krutrim capability probe transaction", () => {
  it("fails native qualification when the real Codex canary is blocked after synthetic Responses passes", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "Qwen3.6-35B-A3B";
    const apiKey = "native-full-canary-test-key";
    const synthetic = passingReport(model);
    synthetic.checks.codexCanary = {
      status: "not-run",
      detail: "Full Codex canary was not run.",
    };

    const result = await probeAndStoreKrutrimCapabilities(test.paths, {
      model,
      apiKey,
      nativeProbe: async () => synthetic,
      codexCanary: async () => ({
        status: "fail",
        check: {
          status: "fail",
          httpStatus: 403,
          detail: "The full Codex Responses envelope was rejected by EdgeSuite/Akamai.",
        },
      }),
      ...testCatalogOptions,
    });

    expect(result.report).toMatchObject({
      outcome: "failed",
      checks: { codexCanary: { status: "fail", httpStatus: 403 } },
    });
    expect(result.resolution.status).toBe("partial");
    expect(result.resolution.capabilities.toolCalling.support).toBe("unknown");
  });

  it("stores valid native evidence only after the real Codex canary passes", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "Native-Full-Canary-Pass";
    const apiKey = "native-full-canary-pass-key";
    const synthetic = passingReport(model);
    synthetic.checks.codexCanary = {
      status: "not-run",
      detail: "Full Codex canary was not run.",
    };

    const result = await probeAndStoreKrutrimCapabilities(test.paths, {
      model,
      apiKey,
      nativeProbe: async () => synthetic,
      codexCanary: async () => ({
        status: "pass",
        check: {
          status: "pass",
          detail: "A real isolated Codex tool loop completed.",
        },
      }),
      ...testCatalogOptions,
    });

    expect(result.report.outcome).toBe("passed");
    expect(result.resolution).toMatchObject({ status: "valid" });
    expect(result.resolution.capabilities.toolCalling.support).toBe("supported");
  });

  it("blocks a credential-shaped model before evidence resolution or activation", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const apiKey = "credential-must-never-be-a-model";
    let operationCalled = false;

    await expect(
      withResolvedKrutrimProviderForModel(
        test.paths,
        apiKey,
        async () => apiKey,
        async () => {
          operationCalled = true;
        },
      ),
    ).rejects.toThrow(/model id contains the stored API key/u);
    expect(operationCalled).toBe(false);

    await expect(
      probeAndStoreKrutrimCapabilities(test.paths, { model: apiKey, apiKey }),
    ).rejects.toThrow(/model id contains the stored API key/u);
    expect((await readdir(test.paths.capabilityEvidenceDir)).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("invalidates an older pass before starting the network probe", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "Krutrim-Probe-Transaction";
    const apiKey = "transaction-test-key";
    await writeCapabilityEvidence(
      test.paths.capabilityEvidenceDir,
      sealCapabilityProbeResult(passingReport(model), apiKey),
    );
    let timeCalls = 0;

    await expect(
      probeAndStoreKrutrimCapabilities(test.paths, {
        model,
        apiKey,
        now: () => {
          timeCalls += 1;
          if (timeCalls === 1) {
            return new Date("2026-08-11T06:00:00.000Z");
          }
          throw new Error("simulated interruption after invalidation");
        },
      }),
    ).rejects.toThrow(/simulated interruption/u);

    const stored = await readCapabilityEvidence(
      test.paths.capabilityEvidenceDir,
      krutrimProvider.id,
      krutrimProvider.baseUrl,
      model,
    );
    expect(stored?.outcome).toBe("inconclusive");
    expect(stored?.observations.requestCount).toBe(0);
    expect(stored?.checks.responsesApi.status).toBe("not-run");
  });

  it("holds capability evidence stable through a guarded activation operation", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const model = "Krutrim-Probe-Activation-Lock";
    const apiKey = "activation-lock-test-key";
    await writeCapabilityEvidence(
      test.paths.capabilityEvidenceDir,
      sealCapabilityProbeResult(passingReport(model), apiKey),
    );

    let activationEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      activationEntered = resolve;
    });
    let releaseActivation!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const activation = withResolvedKrutrimProviderForModel(
      test.paths,
      model,
      async () => apiKey,
      async ({ resolution }) => {
        expect(resolution.status).toBe("valid");
        activationEntered();
        await release;
        const whileLocked = await readCapabilityEvidence(
          test.paths.capabilityEvidenceDir,
          krutrimProvider.id,
          krutrimProvider.baseUrl,
          model,
        );
        expect(whileLocked?.outcome).toBe("passed");
        return "activated";
      },
      new Date("2026-08-11T05:30:00.000Z"),
    );
    await entered;

    let timeCalls = 0;
    let probeSettled = false;
    const probing = probeAndStoreKrutrimCapabilities(test.paths, {
      model,
      apiKey,
      now: () => {
        timeCalls += 1;
        if (timeCalls === 1) {
          return new Date("2026-08-11T06:00:00.000Z");
        }
        throw new Error("simulated probe after activation");
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    ).finally(() => {
      probeSettled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(probeSettled).toBe(false);
    releaseActivation();
    await expect(activation).resolves.toBe("activated");
    expect(await probing).toBeInstanceOf(Error);

    const afterProbe = await readCapabilityEvidence(
      test.paths.capabilityEvidenceDir,
      krutrimProvider.id,
      krutrimProvider.baseUrl,
      model,
    );
    expect(afterProbe?.outcome).toBe("inconclusive");
  });
});
