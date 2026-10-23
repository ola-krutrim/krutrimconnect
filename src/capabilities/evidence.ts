import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigurationError } from "../errors.js";
import { atomicWriteFile, ensurePrivateDirectory } from "../fs/atomic.js";
import type {
  CapabilityFlag,
  ProviderAdapter,
  ProviderCapabilities,
} from "../providers/types.js";

export const CAPABILITY_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const CODEX_RESPONSES_TOOL_CONTRACT = "codex-responses-tools-full-canary-v4";
const LEGACY_CAPABILITY_EVIDENCE_SCHEMA_VERSION = 1 as const;
const LEGACY_CODEX_RESPONSES_TOOL_CONTRACT = "codex-responses-tools-v3";
export const CAPABILITY_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_EVIDENCE_BYTES = 256 * 1024;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type ProbeCheckStatus = "pass" | "fail" | "not-run";
export type ProbeOutcome = "passed" | "failed" | "inconclusive";

export interface CapabilityProbeCheck {
  status: ProbeCheckStatus;
  detail: string;
  httpStatus?: number;
}

export interface CapabilityProbeResult {
  schemaVersion: typeof CAPABILITY_EVIDENCE_SCHEMA_VERSION;
  contract: typeof CODEX_RESPONSES_TOOL_CONTRACT;
  providerId: string;
  baseUrl: string;
  model: string;
  outcome: ProbeOutcome;
  startedAt: string;
  completedAt: string;
  checks: {
    authentication: CapabilityProbeCheck;
    responsesApi: CapabilityProbeCheck;
    streaming: CapabilityProbeCheck;
    toolCalling: CapabilityProbeCheck;
    codexCanary: CapabilityProbeCheck;
  };
  observations: {
    requestCount: number;
    eventTypes: string[];
  };
}

export interface StoredCapabilityEvidence extends CapabilityProbeResult {
  expiresAt: string;
  integrity: {
    algorithm: "hmac-sha256";
    value: string;
  };
}

interface LegacyStoredCapabilityEvidence
  extends Omit<StoredCapabilityEvidence, "schemaVersion" | "contract" | "checks"> {
  schemaVersion: typeof LEGACY_CAPABILITY_EVIDENCE_SCHEMA_VERSION;
  contract: typeof LEGACY_CODEX_RESPONSES_TOOL_CONTRACT;
  checks: Omit<CapabilityProbeResult["checks"], "codexCanary">;
}

type ReadableCapabilityEvidence = StoredCapabilityEvidence | LegacyStoredCapabilityEvidence;

export type CapabilityEvidenceStatus =
  | "missing"
  | "valid"
  | "partial"
  | "failed"
  | "expired"
  | "invalid";

export interface ModelCapabilityResolution {
  status: CapabilityEvidenceStatus;
  detail: string;
  capabilities: ProviderCapabilities;
  evidence?: StoredCapabilityEvidence;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function unsignedEvidence<T extends ReadableCapabilityEvidence>(evidence: T): Omit<T, "integrity"> {
  const { integrity: _integrity, ...unsigned } = evidence;
  return unsigned;
}

function evidenceMac(
  evidence: Omit<StoredCapabilityEvidence, "integrity">,
  apiKey: string,
): string {
  return createHmac("sha256", apiKey)
    .update(canonicalJson(evidence as unknown as JsonValue))
    .digest("hex");
}

function validIsoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function validCheck(value: unknown): value is CapabilityProbeCheck {
  if (!isRecord(value)) {
    return false;
  }
  if (!(value.status === "pass" || value.status === "fail" || value.status === "not-run")) {
    return false;
  }
  if (typeof value.detail !== "string" || value.detail.length > 2_000) {
    return false;
  }
  return (
    value.httpStatus === undefined ||
    (Number.isInteger(value.httpStatus) && (value.httpStatus as number) >= 100 && (value.httpStatus as number) <= 599)
  );
}

function parseEvidence(source: string, evidencePath: string): ReadableCapabilityEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigurationError(`Cannot parse capability evidence at ${evidencePath}.`, {
      cause: error,
    });
  }
  if (!isRecord(parsed) || !isRecord(parsed.checks) || !isRecord(parsed.observations)) {
    throw new ConfigurationError(`Capability evidence has an invalid schema at ${evidencePath}.`);
  }
  const outcome = parsed.outcome;
  const integrity = parsed.integrity;
  const eventTypes = parsed.observations.eventTypes;
  const currentContract =
    parsed.schemaVersion === CAPABILITY_EVIDENCE_SCHEMA_VERSION &&
    parsed.contract === CODEX_RESPONSES_TOOL_CONTRACT;
  const legacyContract =
    parsed.schemaVersion === LEGACY_CAPABILITY_EVIDENCE_SCHEMA_VERSION &&
    parsed.contract === LEGACY_CODEX_RESPONSES_TOOL_CONTRACT;
  if (
    (!currentContract && !legacyContract) ||
    typeof parsed.providerId !== "string" ||
    typeof parsed.baseUrl !== "string" ||
    typeof parsed.model !== "string" ||
    !(outcome === "passed" || outcome === "failed" || outcome === "inconclusive") ||
    typeof parsed.startedAt !== "string" ||
    !validIsoTimestamp(parsed.startedAt) ||
    typeof parsed.completedAt !== "string" ||
    !validIsoTimestamp(parsed.completedAt) ||
    typeof parsed.expiresAt !== "string" ||
    !validIsoTimestamp(parsed.expiresAt) ||
    !validCheck(parsed.checks.authentication) ||
    !validCheck(parsed.checks.responsesApi) ||
    !validCheck(parsed.checks.streaming) ||
    !validCheck(parsed.checks.toolCalling) ||
    (currentContract && !validCheck(parsed.checks.codexCanary)) ||
    !Number.isInteger(parsed.observations.requestCount) ||
    (parsed.observations.requestCount as number) < 0 ||
    (parsed.observations.requestCount as number) > 20 ||
    !Array.isArray(eventTypes) ||
    eventTypes.length > 100 ||
    !eventTypes.every((item) => typeof item === "string" && item.length <= 200) ||
    !isRecord(integrity) ||
    integrity.algorithm !== "hmac-sha256" ||
    typeof integrity.value !== "string" ||
    !/^[a-f0-9]{64}$/u.test(integrity.value)
  ) {
    throw new ConfigurationError(`Capability evidence has an invalid schema at ${evidencePath}.`);
  }
  const copyCheck = (check: CapabilityProbeCheck): CapabilityProbeCheck => ({
    status: check.status,
    detail: check.detail,
    ...(check.httpStatus === undefined ? {} : { httpStatus: check.httpStatus }),
  });
  const base = {
    schemaVersion: parsed.schemaVersion,
    contract: parsed.contract,
    providerId: parsed.providerId as string,
    baseUrl: parsed.baseUrl as string,
    model: parsed.model as string,
    outcome: outcome as ProbeOutcome,
    startedAt: parsed.startedAt as string,
    completedAt: parsed.completedAt as string,
    expiresAt: parsed.expiresAt as string,
    checks: {
      authentication: copyCheck(parsed.checks.authentication as CapabilityProbeCheck),
      responsesApi: copyCheck(parsed.checks.responsesApi as CapabilityProbeCheck),
      streaming: copyCheck(parsed.checks.streaming as CapabilityProbeCheck),
      toolCalling: copyCheck(parsed.checks.toolCalling as CapabilityProbeCheck),
      ...(currentContract
        ? { codexCanary: copyCheck(parsed.checks.codexCanary as CapabilityProbeCheck) }
        : {}),
    },
    observations: {
      requestCount: parsed.observations.requestCount as number,
      eventTypes: [...(eventTypes as string[])],
    },
    integrity: {
      algorithm: "hmac-sha256",
      value: (integrity as { value: string }).value,
    },
  };
  return base as ReadableCapabilityEvidence;
}

export function capabilityEvidencePath(
  evidenceDirectory: string,
  providerId: string,
  baseUrl: string,
  model: string,
): string {
  const scope = createHash("sha256")
    .update(providerId)
    .update("\0")
    .update(baseUrl)
    .update("\0")
    .update(model)
    .digest("hex");
  return path.join(evidenceDirectory, `${scope}.json`);
}

export function sealCapabilityProbeResult(
  result: CapabilityProbeResult,
  apiKey: string,
): StoredCapabilityEvidence {
  if (apiKey.length === 0) {
    throw new ConfigurationError("Cannot seal capability evidence without a credential.");
  }
  const completed = Date.parse(result.completedAt);
  if (!Number.isFinite(completed)) {
    throw new ConfigurationError("Capability probe completion time is invalid.");
  }
  const unsigned: Omit<StoredCapabilityEvidence, "integrity"> = {
    ...structuredClone(result),
    expiresAt: new Date(completed + CAPABILITY_EVIDENCE_TTL_MS).toISOString(),
  };
  return {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      value: evidenceMac(unsigned, apiKey),
    },
  };
}

export async function writeCapabilityEvidence(
  evidenceDirectory: string,
  evidence: StoredCapabilityEvidence,
): Promise<string> {
  await ensurePrivateDirectory(evidenceDirectory);
  const target = capabilityEvidencePath(
    evidenceDirectory,
    evidence.providerId,
    evidence.baseUrl,
    evidence.model,
  );
  await atomicWriteFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export async function readCapabilityEvidence(
  evidenceDirectory: string,
  providerId: string,
  baseUrl: string,
  model: string,
): Promise<ReadableCapabilityEvidence | null> {
  const target = capabilityEvidencePath(evidenceDirectory, providerId, baseUrl, model);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ConfigurationError(`Capability evidence path is not a regular file: ${target}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new ConfigurationError(`Capability evidence is group- or world-accessible: ${target}`);
  }
  if (info.size > MAX_EVIDENCE_BYTES) {
    throw new ConfigurationError(`Capability evidence is unexpectedly large: ${target}`);
  }
  return parseEvidence(await readFile(target, "utf8"), target);
}

function unverifiedCapability(base: CapabilityFlag, detail: string): CapabilityFlag {
  if (base.support !== "unknown") {
    return base;
  }
  return { support: "unknown", evidence: "probed", detail };
}

function checkedCapability(
  base: CapabilityFlag,
  check: CapabilityProbeCheck,
  prerequisite: boolean,
  verifiedAt: string,
): CapabilityFlag {
  if (prerequisite && check.status === "pass") {
    return {
      support: "supported",
      evidence: "probed",
      detail: `Authenticated conformance probe passed for this exact model at ${verifiedAt}.`,
    };
  }
  return unverifiedCapability(base, `Latest authenticated probe did not establish support: ${check.detail}`);
}

export function resolveModelCapabilities(
  provider: ProviderAdapter,
  model: string,
  evidence: ReadableCapabilityEvidence | null,
  apiKey: string,
  now = new Date(),
): ModelCapabilityResolution {
  const base = provider.capabilities;
  if (evidence === null) {
    const detail = "No authenticated capability evidence exists for this exact model.";
    return {
      status: "missing",
      detail,
      capabilities: {
        ...base,
        responsesApi: { ...base.responsesApi, detail },
        streaming: { ...base.streaming, detail },
        toolCalling: { ...base.toolCalling, detail },
      },
    };
  }
  if (
    evidence.schemaVersion !== CAPABILITY_EVIDENCE_SCHEMA_VERSION ||
    evidence.contract !== CODEX_RESPONSES_TOOL_CONTRACT ||
    evidence.providerId !== provider.id ||
    evidence.baseUrl !== provider.baseUrl ||
    evidence.model !== model
  ) {
    const detail =
      evidence.schemaVersion !== CAPABILITY_EVIDENCE_SCHEMA_VERSION ||
      evidence.contract !== CODEX_RESPONSES_TOOL_CONTRACT
        ? "Older capability evidence does not include a real full Codex canary. Re-run the Codex probe for this exact model."
        : "Capability evidence is bound to a different provider, endpoint, model, or contract.";
    return {
      status: "invalid",
      detail,
      capabilities: {
        ...base,
        responsesApi: unverifiedCapability(base.responsesApi, detail),
        streaming: unverifiedCapability(base.streaming, detail),
        toolCalling: unverifiedCapability(base.toolCalling, detail),
      },
      ...(evidence.schemaVersion === CAPABILITY_EVIDENCE_SCHEMA_VERSION ? { evidence } : {}),
    };
  }

  const expected = evidenceMac(unsignedEvidence(evidence), apiKey);
  const actualBytes = Buffer.from(evidence.integrity.value, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    const detail = "Capability evidence does not match the current credential or was modified.";
    return {
      status: "invalid",
      detail,
      capabilities: {
        ...base,
        responsesApi: unverifiedCapability(base.responsesApi, detail),
        streaming: unverifiedCapability(base.streaming, detail),
        toolCalling: unverifiedCapability(base.toolCalling, detail),
      },
      evidence,
    };
  }

  const completedAt = Date.parse(evidence.completedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const nowMs = now.getTime();
  if (
    completedAt > nowMs + FUTURE_CLOCK_SKEW_MS ||
    expiresAt <= completedAt ||
    expiresAt - completedAt > CAPABILITY_EVIDENCE_TTL_MS ||
    nowMs >= expiresAt
  ) {
    const detail = "Authenticated capability evidence is expired or has invalid timestamps.";
    return {
      status: "expired",
      detail,
      capabilities: {
        ...base,
        responsesApi: unverifiedCapability(base.responsesApi, detail),
        streaming: unverifiedCapability(base.streaming, detail),
        toolCalling: unverifiedCapability(base.toolCalling, detail),
      },
      evidence,
    };
  }

  const authPassed = evidence.checks.authentication.status === "pass";
  const observedEvents = new Set(evidence.observations.eventTypes);
  const hasTextContract = [
    "response.created",
    "response.output_item.added",
    "response.output_text.delta",
    "response.output_item.done",
    "response.completed",
  ].every((type) => observedEvents.has(type));
  const hasStreamedToolContract = [
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
  ].every((type) => observedEvents.has(type));
  const allChecksPassed =
    authPassed &&
    evidence.checks.responsesApi.status === "pass" &&
    evidence.checks.streaming.status === "pass" &&
    evidence.checks.toolCalling.status === "pass" &&
    evidence.checks.codexCanary.status === "pass";
  const outcomeIsConsistent =
    evidence.outcome === "passed"
      ? allChecksPassed && evidence.observations.requestCount === 7
      : !allChecksPassed;
  if (!outcomeIsConsistent) {
    const detail = "Capability evidence has an internally inconsistent probe outcome.";
    return {
      status: "invalid",
      detail,
      capabilities: {
        ...base,
        responsesApi: unverifiedCapability(base.responsesApi, detail),
        streaming: unverifiedCapability(base.streaming, detail),
        toolCalling: unverifiedCapability(base.toolCalling, detail),
      },
      evidence,
    };
  }
  const responsesPassed =
    authPassed && evidence.checks.responsesApi.status === "pass" && hasTextContract;
  const streamingPassed =
    responsesPassed && evidence.checks.streaming.status === "pass" && hasStreamedToolContract;
  const toolPassed =
    streamingPassed &&
    evidence.outcome === "passed" &&
    evidence.checks.toolCalling.status === "pass" &&
    evidence.checks.codexCanary.status === "pass" &&
    evidence.observations.requestCount === 7;
  const capabilities: ProviderCapabilities = {
    ...base,
    responsesApi: checkedCapability(
      base.responsesApi,
      evidence.checks.responsesApi,
      responsesPassed,
      evidence.completedAt,
    ),
    streaming: checkedCapability(
      base.streaming,
      evidence.checks.streaming,
      streamingPassed,
      evidence.completedAt,
    ),
    toolCalling: checkedCapability(
      base.toolCalling,
      evidence.checks.toolCalling,
      toolPassed,
      evidence.completedAt,
    ),
  };
  const passedCount = [responsesPassed, streamingPassed, toolPassed].filter(Boolean).length;
  return {
    status: toolPassed ? "valid" : passedCount > 0 ? "partial" : "failed",
    detail: toolPassed
      ? `Model-bound capability evidence is valid until ${evidence.expiresAt}.`
      : "The latest probe did not establish every Codex-required capability.",
    capabilities,
    evidence,
  };
}

export function bindModelCapabilities(
  provider: ProviderAdapter,
  model: string,
  capabilities: ProviderCapabilities,
): ProviderAdapter {
  return {
    ...provider,
    capabilitiesFor(resolved) {
      return resolved.id === model ? capabilities : provider.capabilitiesFor(resolved);
    },
  };
}
