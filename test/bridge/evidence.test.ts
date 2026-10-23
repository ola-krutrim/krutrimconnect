import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BRIDGE_EVIDENCE_SCHEMA_VERSION,
  BRIDGE_EVIDENCE_TTL_MS,
  CHAT_BRIDGE_FEASIBILITY_CONTRACT,
  bridgeEvidencePath,
  readBridgeEvidence,
  resolveBridgeEvidence,
  sealBridgeProbeResult,
  writeBridgeEvidence,
  type BridgeProbeResult,
} from "../../src/bridge/evidence.js";
import { fileMode } from "../../src/fs/atomic.js";
import { krutrimProvider } from "../../src/providers/krutrim.js";

const roots: string[] = [];
const apiKey = "bridge-evidence-key-never-persist";
const completedAt = "2026-08-12T12:00:00.000Z";

function report(): BridgeProbeResult {
  return {
    schemaVersion: BRIDGE_EVIDENCE_SCHEMA_VERSION,
    contract: CHAT_BRIDGE_FEASIBILITY_CONTRACT,
    providerId: krutrimProvider.id,
    baseUrl: krutrimProvider.baseUrl,
    model: "Krutrim-Bridge-Test-Model",
    outcome: "streaming-compatible",
    startedAt: "2026-08-12T11:59:00.000Z",
    completedAt,
    checks: {
      authentication: { status: "pass", detail: "credential accepted" },
      nonStreamingToolCalling: { status: "pass", detail: "tool call accepted" },
      streamingToolCalling: { status: "pass", detail: "tool deltas accepted" },
      toolContinuation: { status: "pass", detail: "tool result accepted" },
      codexCanary: { status: "pass", detail: "full Codex canary accepted" },
    },
    observations: { requestCount: 5, streamEventCount: 5, argumentDeltaCount: 2 },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("model-bound bridge evidence", () => {
  it("seals bridge results independently with a fixed 24-hour TTL", () => {
    const evidence = sealBridgeProbeResult(report(), apiKey);

    expect(evidence.expiresAt).toBe(
      new Date(Date.parse(completedAt) + BRIDGE_EVIDENCE_TTL_MS).toISOString(),
    );
    expect(evidence.integrity).toMatchObject({ algorithm: "hmac-sha256" });
    expect(evidence.integrity.value).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(evidence)).not.toContain(apiKey);
  });

  it("writes only private evidence and never uses the model as a path component", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-bridge-evidence-"));
    roots.push(root);
    const directory = path.join(root, "bridge-capabilities", "krutrim");
    const evidence = sealBridgeProbeResult(report(), apiKey);
    const storedPath = await writeBridgeEvidence(directory, evidence);
    const source = await readFile(storedPath, "utf8");

    expect(source).not.toContain(apiKey);
    if (process.platform !== "win32") {
      expect(await fileMode(storedPath)).toBe(0o600);
    }
    expect(path.dirname(storedPath)).toBe(directory);
    expect(path.basename(storedPath)).toMatch(/^[a-f0-9]{64}\.json$/u);
  });

  it("hashes provider, endpoint, and exact model into the evidence scope", () => {
    const directory = path.resolve("/tmp/krutrim-connect-bridge-evidence-test");
    const first = bridgeEvidencePath(directory, "krutrim", krutrimProvider.baseUrl, "model/../../a");
    const second = bridgeEvidencePath(directory, "krutrim", krutrimProvider.baseUrl, "model-b");

    expect(path.dirname(first)).toBe(directory);
    expect(path.basename(first)).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(first).not.toBe(second);
  });

  it("accepts only intact, current, streaming-compatible evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-bridge-evidence-"));
    roots.push(root);
    const directory = path.join(root, "bridge-capabilities", "krutrim");
    const evidence = sealBridgeProbeResult(report(), apiKey);
    await writeBridgeEvidence(directory, evidence);

    const stored = await readBridgeEvidence(
      directory,
      evidence.providerId,
      evidence.baseUrl,
      evidence.model,
    );
    expect(
      resolveBridgeEvidence(
        evidence.providerId,
        evidence.baseUrl,
        evidence.model,
        stored,
        apiKey,
        new Date(completedAt),
      ),
    ).toMatchObject({ status: "valid", usable: true });

    expect(
      resolveBridgeEvidence(
        evidence.providerId,
        evidence.baseUrl,
        evidence.model,
        stored,
        "rotated-key",
        new Date(completedAt),
      ),
    ).toMatchObject({ status: "invalid", usable: false });

    expect(
      resolveBridgeEvidence(
        evidence.providerId,
        evidence.baseUrl,
        evidence.model,
        stored,
        apiKey,
        new Date(Date.parse(evidence.expiresAt) + 1),
      ),
    ).toMatchObject({ status: "expired", usable: false });
  });

  it("does not qualify buffered-only evidence for Codex", () => {
    const buffered = report();
    buffered.outcome = "buffered-compatible";
    buffered.checks.streamingToolCalling = { status: "fail", detail: "no streamed arguments" };
    buffered.observations.argumentDeltaCount = 0;
    const evidence = sealBridgeProbeResult(buffered, apiKey);
    expect(
      resolveBridgeEvidence(
        evidence.providerId,
        evidence.baseUrl,
        evidence.model,
        evidence,
        apiKey,
        new Date(completedAt),
      ),
    ).toMatchObject({ status: "failed", usable: false });
  });

  it("does not qualify streaming tool evidence when the full Codex canary failed", () => {
    const canaryFailed = report();
    canaryFailed.outcome = "failed";
    canaryFailed.checks.codexCanary = {
      status: "fail",
      detail: "real Codex payload was rejected",
      httpStatus: 400,
    };
    const evidence = sealBridgeProbeResult(canaryFailed, apiKey);
    expect(
      resolveBridgeEvidence(
        evidence.providerId,
        evidence.baseUrl,
        evidence.model,
        evidence,
        apiKey,
        new Date(completedAt),
      ),
    ).toMatchObject({ status: "failed", usable: false });
  });

  it("reads legacy evidence only to reject it as missing managed metadata and a tool canary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-bridge-evidence-"));
    roots.push(root);
    const directory = path.join(root, "bridge-capabilities", "krutrim");
    await mkdir(directory, { recursive: true });
    const target = bridgeEvidencePath(
      directory,
      krutrimProvider.id,
      krutrimProvider.baseUrl,
      report().model,
    );
    const current = report();
    const legacyChecks = {
      authentication: current.checks.authentication,
      nonStreamingToolCalling: current.checks.nonStreamingToolCalling,
      streamingToolCalling: current.checks.streamingToolCalling,
      toolContinuation: current.checks.toolContinuation,
    };
    await writeFile(
      target,
      `${JSON.stringify({
        ...current,
        schemaVersion: 1,
        contract: "chat-tools-bridge-v1",
        checks: legacyChecks,
        expiresAt: new Date(Date.parse(completedAt) + BRIDGE_EVIDENCE_TTL_MS).toISOString(),
        integrity: { algorithm: "hmac-sha256", value: "0".repeat(64) },
      })}\n`,
      { mode: 0o600 },
    );

    const stored = await readBridgeEvidence(
      directory,
      krutrimProvider.id,
      krutrimProvider.baseUrl,
      current.model,
    );
    expect(
      resolveBridgeEvidence(
        krutrimProvider.id,
        krutrimProvider.baseUrl,
        current.model,
        stored,
        apiKey,
        new Date(completedAt),
      ),
    ).toMatchObject({
      status: "invalid",
      usable: false,
      detail: expect.stringContaining("deterministic installed-Codex"),
    });
  });

  it("rejects pre-isolation full-Codex evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-bridge-evidence-"));
    roots.push(root);
    const directory = path.join(root, "bridge-capabilities", "krutrim");
    await mkdir(directory, { recursive: true });
    const current = report();
    const target = bridgeEvidencePath(
      directory,
      current.providerId,
      current.baseUrl,
      current.model,
    );
    await writeFile(
      target,
      `${JSON.stringify({
        ...current,
        schemaVersion: 3,
        contract: "chat-tools-catalog-tool-canary-v3",
        expiresAt: new Date(Date.parse(completedAt) + BRIDGE_EVIDENCE_TTL_MS).toISOString(),
        integrity: { algorithm: "hmac-sha256", value: "0".repeat(64) },
      })}\n`,
      { mode: 0o600 },
    );

    const stored = await readBridgeEvidence(
      directory,
      current.providerId,
      current.baseUrl,
      current.model,
    );
    expect(
      resolveBridgeEvidence(
        current.providerId,
        current.baseUrl,
        current.model,
        stored,
        apiKey,
        new Date(completedAt),
      ),
    ).toMatchObject({
      status: "invalid",
      usable: false,
      detail: expect.stringContaining("deterministic installed-Codex"),
    });
  });

  it("rejects bridge evidence from the pre-direct tool contract", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-bridge-evidence-"));
    roots.push(root);
    const directory = path.join(root, "bridge-capabilities", "krutrim");
    await mkdir(directory, { recursive: true });
    const current = report();
    const target = bridgeEvidencePath(
      directory,
      current.providerId,
      current.baseUrl,
      current.model,
    );
    await writeFile(
      target,
      `${JSON.stringify({
        ...current,
        schemaVersion: 4,
        contract: "chat-tools-catalog-isolated-canary-v4",
        expiresAt: new Date(Date.parse(completedAt) + BRIDGE_EVIDENCE_TTL_MS).toISOString(),
        integrity: { algorithm: "hmac-sha256", value: "0".repeat(64) },
      })}\n`,
      { mode: 0o600 },
    );

    const stored = await readBridgeEvidence(
      directory,
      current.providerId,
      current.baseUrl,
      current.model,
    );
    expect(
      resolveBridgeEvidence(
        current.providerId,
        current.baseUrl,
        current.model,
        stored,
        apiKey,
        new Date(completedAt),
      ),
    ).toMatchObject({
      status: "invalid",
      usable: false,
      detail: expect.stringContaining("deterministic installed-Codex"),
    });
  });

  it("rejects bridge evidence from the non-deterministic direct-tool canary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-bridge-evidence-"));
    roots.push(root);
    const directory = path.join(root, "bridge-capabilities", "krutrim");
    await mkdir(directory, { recursive: true });
    const current = report();
    const target = bridgeEvidencePath(
      directory,
      current.providerId,
      current.baseUrl,
      current.model,
    );
    await writeFile(
      target,
      `${JSON.stringify({
        ...current,
        schemaVersion: 5,
        contract: "chat-direct-tools-catalog-isolated-canary-v5",
        expiresAt: new Date(Date.parse(completedAt) + BRIDGE_EVIDENCE_TTL_MS).toISOString(),
        integrity: { algorithm: "hmac-sha256", value: "0".repeat(64) },
      })}\n`,
      { mode: 0o600 },
    );

    const stored = await readBridgeEvidence(
      directory,
      current.providerId,
      current.baseUrl,
      current.model,
    );
    expect(
      resolveBridgeEvidence(
        current.providerId,
        current.baseUrl,
        current.model,
        stored,
        apiKey,
        new Date(completedAt),
      ),
    ).toMatchObject({
      status: "invalid",
      usable: false,
      detail: expect.stringContaining("deterministic installed-Codex"),
    });
  });
});
