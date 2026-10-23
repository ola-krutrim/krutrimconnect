import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  CAPABILITY_EVIDENCE_TTL_MS,
  CODEX_RESPONSES_TOOL_CONTRACT,
  bindModelCapabilities,
  capabilityEvidencePath,
  readCapabilityEvidence,
  resolveModelCapabilities,
  sealCapabilityProbeResult,
  writeCapabilityEvidence,
  type CapabilityProbeResult,
} from "../../src/capabilities/evidence.js";
import { fileMode } from "../../src/fs/atomic.js";
import { krutrimProvider } from "../../src/providers/krutrim.js";

const roots: string[] = [];
const apiKey = "test-key-that-must-never-be-persisted";
const completedAt = "2026-08-11T05:00:00.000Z";

function report(overrides: Partial<CapabilityProbeResult> = {}): CapabilityProbeResult {
  return {
    schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
    contract: CODEX_RESPONSES_TOOL_CONTRACT,
    providerId: krutrimProvider.id,
    baseUrl: krutrimProvider.baseUrl,
    model: "Krutrim-Test-Model",
    outcome: "passed",
    startedAt: "2026-08-11T04:59:00.000Z",
    completedAt,
    checks: {
      authentication: { status: "pass", detail: "credential accepted" },
      responsesApi: { status: "pass", detail: "responses accepted" },
      streaming: { status: "pass", detail: "canonical SSE accepted" },
      toolCalling: { status: "pass", detail: "tool loop accepted" },
      codexCanary: { status: "pass", detail: "full Codex canary accepted" },
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
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("model-bound capability evidence", () => {
  it("promotes only the exact model with a valid current-key HMAC", () => {
    const evidence = sealCapabilityProbeResult(report(), apiKey);
    const resolution = resolveModelCapabilities(
      krutrimProvider,
      evidence.model,
      evidence,
      apiKey,
      new Date(completedAt),
    );
    const bound = bindModelCapabilities(krutrimProvider, evidence.model, resolution.capabilities);

    expect(resolution.status).toBe("valid");
    expect(resolution.capabilities.responsesApi).toMatchObject({ support: "supported", evidence: "probed" });
    expect(resolution.capabilities.streaming).toMatchObject({ support: "supported", evidence: "probed" });
    expect(resolution.capabilities.toolCalling).toMatchObject({ support: "supported", evidence: "probed" });
    expect(resolution.capabilities.structuredOutput.support).toBe("unknown");
    expect(bound.capabilitiesFor({ id: evidence.model, source: "explicit" }).toolCalling.support).toBe("supported");
    expect(bound.capabilitiesFor({ id: "Different-Model", source: "explicit" }).toolCalling.support).toBe("unknown");
  });

  it("rejects evidence after credential rotation", () => {
    const evidence = sealCapabilityProbeResult(report(), apiKey);
    const resolution = resolveModelCapabilities(
      krutrimProvider,
      evidence.model,
      evidence,
      "rotated-key",
      new Date(completedAt),
    );

    expect(resolution.status).toBe("invalid");
    expect(resolution.capabilities.responsesApi.support).toBe("unknown");
    expect(resolution.detail).toMatch(/current credential|modified/u);
  });

  it("rejects a modified evidence summary even when the scope still matches", () => {
    const evidence = sealCapabilityProbeResult(report(), apiKey);
    evidence.checks.toolCalling.detail = "manually changed to passing";
    const resolution = resolveModelCapabilities(
      krutrimProvider,
      evidence.model,
      evidence,
      apiKey,
      new Date(completedAt),
    );

    expect(resolution.status).toBe("invalid");
    expect(resolution.capabilities.toolCalling.support).toBe("unknown");
  });

  it("expires passing evidence after the fixed 24-hour TTL", () => {
    const evidence = sealCapabilityProbeResult(report(), apiKey);
    const afterExpiry = new Date(Date.parse(completedAt) + CAPABILITY_EVIDENCE_TTL_MS);
    const resolution = resolveModelCapabilities(
      krutrimProvider,
      evidence.model,
      evidence,
      apiKey,
      afterExpiry,
    );

    expect(resolution.status).toBe("expired");
    expect(resolution.capabilities.toolCalling.support).toBe("unknown");
  });

  it("retains partial evidence without allowing the Codex tool-call gate", () => {
    const partialReport = report({
      outcome: "failed",
      checks: {
        ...report().checks,
        toolCalling: { status: "fail", detail: "continuation rejected" },
      },
    });
    const evidence = sealCapabilityProbeResult(partialReport, apiKey);
    const resolution = resolveModelCapabilities(
      krutrimProvider,
      evidence.model,
      evidence,
      apiKey,
      new Date(completedAt),
    );

    expect(resolution.status).toBe("partial");
    expect(resolution.capabilities.responsesApi.support).toBe("supported");
    expect(resolution.capabilities.streaming.support).toBe("supported");
    expect(resolution.capabilities.toolCalling.support).toBe("unknown");
  });

  it("stores only a private summary and never the API key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-evidence-test-"));
    roots.push(root);
    const directory = path.join(root, "capabilities", "krutrim");
    const evidence = sealCapabilityProbeResult(report(), apiKey);
    const storedPath = await writeCapabilityEvidence(directory, evidence);
    const source = await readFile(storedPath, "utf8");

    expect(source).not.toContain(apiKey);
    if (process.platform !== "win32") {
      expect(await fileMode(storedPath)).toBe(0o600);
    }
    expect(await readCapabilityEvidence(directory, evidence.providerId, evidence.baseUrl, evidence.model)).toEqual(
      evidence,
    );
  });

  it("reads legacy synthetic evidence only to reject it as missing a full Codex canary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-evidence-test-"));
    roots.push(root);
    const directory = path.join(root, "capabilities", "krutrim");
    await mkdir(directory, { recursive: true });
    const current = report();
    const target = capabilityEvidencePath(
      directory,
      current.providerId,
      current.baseUrl,
      current.model,
    );
    const {
      codexCanary: _codexCanary,
      ...legacyChecks
    } = current.checks;
    await writeFile(
      target,
      `${JSON.stringify({
        ...current,
        schemaVersion: 1,
        contract: "codex-responses-tools-v3",
        checks: legacyChecks,
        expiresAt: new Date(Date.parse(completedAt) + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
        integrity: { algorithm: "hmac-sha256", value: "0".repeat(64) },
      })}\n`,
      { mode: 0o600 },
    );

    const stored = await readCapabilityEvidence(
      directory,
      current.providerId,
      current.baseUrl,
      current.model,
    );
    expect(
      resolveModelCapabilities(
        krutrimProvider,
        current.model,
        stored,
        apiKey,
        new Date(completedAt),
      ),
    ).toMatchObject({
      status: "invalid",
      detail: expect.stringContaining("full Codex canary"),
      capabilities: {
        responsesApi: { support: "unknown", detail: expect.stringContaining("full Codex canary") },
        streaming: { support: "unknown", detail: expect.stringContaining("full Codex canary") },
        toolCalling: { support: "unknown", detail: expect.stringContaining("full Codex canary") },
      },
    });
  });

  it("uses a scope hash so model identifiers never become path components", () => {
    const directory = path.resolve("/tmp/krutrim-connect-capability-test");
    const first = capabilityEvidencePath(directory, "krutrim", krutrimProvider.baseUrl, "model/../../a");
    const second = capabilityEvidencePath(directory, "krutrim", krutrimProvider.baseUrl, "model-b");

    expect(path.dirname(first)).toBe(directory);
    expect(path.basename(first)).toMatch(/^[a-f0-9]{64}\.json$/u);
    expect(first).not.toBe(second);
  });
});
