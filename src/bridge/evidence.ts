import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigurationError } from "../errors.js";
import { atomicWriteFile, ensurePrivateDirectory } from "../fs/atomic.js";

export const BRIDGE_EVIDENCE_SCHEMA_VERSION = 6 as const;
export const CHAT_BRIDGE_FEASIBILITY_CONTRACT = "chat-direct-tools-deterministic-canary-v6";
const LEGACY_BRIDGE_EVIDENCE_SCHEMA_VERSION = 1 as const;
const LEGACY_CHAT_BRIDGE_FEASIBILITY_CONTRACT = "chat-tools-bridge-v1";
const PREVIOUS_BRIDGE_EVIDENCE_SCHEMA_VERSION = 2 as const;
const PREVIOUS_CHAT_BRIDGE_FEASIBILITY_CONTRACT = "chat-tools-codex-canary-v2";
const PRE_ISOLATION_BRIDGE_EVIDENCE_SCHEMA_VERSION = 3 as const;
const PRE_ISOLATION_CHAT_BRIDGE_FEASIBILITY_CONTRACT = "chat-tools-catalog-tool-canary-v3";
const PRE_DIRECT_TOOLS_BRIDGE_EVIDENCE_SCHEMA_VERSION = 4 as const;
const PRE_DIRECT_TOOLS_CHAT_BRIDGE_FEASIBILITY_CONTRACT = "chat-tools-catalog-isolated-canary-v4";
const PRE_DETERMINISTIC_CANARY_BRIDGE_EVIDENCE_SCHEMA_VERSION = 5 as const;
const PRE_DETERMINISTIC_CANARY_CHAT_BRIDGE_FEASIBILITY_CONTRACT = "chat-direct-tools-catalog-isolated-canary-v5";
export const BRIDGE_EVIDENCE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_BYTES = 256 * 1024;
const FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type BridgeProbeCheckStatus = "pass" | "fail" | "inconclusive" | "not-run";
export type BridgeProbeOutcome =
  | "streaming-compatible"
  | "buffered-compatible"
  | "failed"
  | "inconclusive";

export interface BridgeProbeCheck {
  status: BridgeProbeCheckStatus;
  detail: string;
  httpStatus?: number;
}

export interface BridgeProbeResult {
  schemaVersion: typeof BRIDGE_EVIDENCE_SCHEMA_VERSION;
  contract: typeof CHAT_BRIDGE_FEASIBILITY_CONTRACT;
  providerId: string;
  baseUrl: string;
  model: string;
  outcome: BridgeProbeOutcome;
  startedAt: string;
  completedAt: string;
  checks: {
    authentication: BridgeProbeCheck;
    nonStreamingToolCalling: BridgeProbeCheck;
    streamingToolCalling: BridgeProbeCheck;
    toolContinuation: BridgeProbeCheck;
    codexCanary: BridgeProbeCheck;
  };
  observations: {
    requestCount: number;
    streamEventCount: number;
    argumentDeltaCount: number;
  };
}

export interface StoredBridgeEvidence extends BridgeProbeResult {
  expiresAt: string;
  integrity: {
    algorithm: "hmac-sha256";
    value: string;
  };
}

interface LegacyStoredBridgeEvidence
  extends Omit<StoredBridgeEvidence, "schemaVersion" | "contract" | "checks"> {
  schemaVersion: typeof LEGACY_BRIDGE_EVIDENCE_SCHEMA_VERSION;
  contract: typeof LEGACY_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
  checks: Omit<BridgeProbeResult["checks"], "codexCanary">;
}

interface PreviousStoredBridgeEvidence
  extends Omit<StoredBridgeEvidence, "schemaVersion" | "contract"> {
  schemaVersion: typeof PREVIOUS_BRIDGE_EVIDENCE_SCHEMA_VERSION;
  contract: typeof PREVIOUS_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
}

interface PreIsolationStoredBridgeEvidence
  extends Omit<StoredBridgeEvidence, "schemaVersion" | "contract"> {
  schemaVersion: typeof PRE_ISOLATION_BRIDGE_EVIDENCE_SCHEMA_VERSION;
  contract: typeof PRE_ISOLATION_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
}

interface PreDirectToolsStoredBridgeEvidence
  extends Omit<StoredBridgeEvidence, "schemaVersion" | "contract"> {
  schemaVersion: typeof PRE_DIRECT_TOOLS_BRIDGE_EVIDENCE_SCHEMA_VERSION;
  contract: typeof PRE_DIRECT_TOOLS_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
}

interface PreDeterministicCanaryStoredBridgeEvidence
  extends Omit<StoredBridgeEvidence, "schemaVersion" | "contract"> {
  schemaVersion: typeof PRE_DETERMINISTIC_CANARY_BRIDGE_EVIDENCE_SCHEMA_VERSION;
  contract: typeof PRE_DETERMINISTIC_CANARY_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
}

type ReadableBridgeEvidence =
  | StoredBridgeEvidence
  | PreDeterministicCanaryStoredBridgeEvidence
  | PreDirectToolsStoredBridgeEvidence
  | PreIsolationStoredBridgeEvidence
  | PreviousStoredBridgeEvidence
  | LegacyStoredBridgeEvidence;

export type BridgeEvidenceStatus =
  | "valid"
  | "missing"
  | "invalid"
  | "expired"
  | "failed";

export interface BridgeEvidenceResolution {
  status: BridgeEvidenceStatus;
  usable: boolean;
  detail: string;
  evidence?: StoredBridgeEvidence;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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

function unsignedEvidence<T extends ReadableBridgeEvidence>(
  evidence: T,
): Omit<T, "integrity"> {
  const { integrity: _integrity, ...unsigned } = evidence;
  return unsigned;
}

function parseBridgeEvidence(source: string, target: string): ReadableBridgeEvidence {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigurationError(`Cannot parse bridge evidence at ${target}.`, { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`Bridge evidence has an invalid schema at ${target}.`);
  }
  const raw = value as Record<string, unknown>;
  const candidate = value as Partial<StoredBridgeEvidence>;
  const validCheck = (check: unknown): check is BridgeProbeCheck => {
    if (check === null || typeof check !== "object" || Array.isArray(check)) {
      return false;
    }
    const item = check as Partial<BridgeProbeCheck>;
    return (
      (item.status === "pass" ||
        item.status === "fail" ||
        item.status === "inconclusive" ||
        item.status === "not-run") &&
      typeof item.detail === "string" &&
      (item.httpStatus === undefined || Number.isSafeInteger(item.httpStatus))
    );
  };
  const checks = candidate.checks as Partial<BridgeProbeResult["checks"]> | undefined;
  const observations = candidate.observations as Partial<BridgeProbeResult["observations"]> | undefined;
  const currentContract =
    raw.schemaVersion === BRIDGE_EVIDENCE_SCHEMA_VERSION &&
    raw.contract === CHAT_BRIDGE_FEASIBILITY_CONTRACT;
  const legacyContract =
    raw.schemaVersion === LEGACY_BRIDGE_EVIDENCE_SCHEMA_VERSION &&
    raw.contract === LEGACY_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
  const previousContract =
    raw.schemaVersion === PREVIOUS_BRIDGE_EVIDENCE_SCHEMA_VERSION &&
    raw.contract === PREVIOUS_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
  const preIsolationContract =
    raw.schemaVersion === PRE_ISOLATION_BRIDGE_EVIDENCE_SCHEMA_VERSION &&
    raw.contract === PRE_ISOLATION_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
  const preDirectToolsContract =
    raw.schemaVersion === PRE_DIRECT_TOOLS_BRIDGE_EVIDENCE_SCHEMA_VERSION &&
    raw.contract === PRE_DIRECT_TOOLS_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
  const preDeterministicCanaryContract =
    raw.schemaVersion === PRE_DETERMINISTIC_CANARY_BRIDGE_EVIDENCE_SCHEMA_VERSION &&
    raw.contract === PRE_DETERMINISTIC_CANARY_CHAT_BRIDGE_FEASIBILITY_CONTRACT;
  if (
    (!currentContract && !preDeterministicCanaryContract && !preDirectToolsContract && !preIsolationContract && !previousContract && !legacyContract) ||
    typeof candidate.providerId !== "string" ||
    typeof candidate.baseUrl !== "string" ||
    typeof candidate.model !== "string" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.completedAt !== "string" ||
    typeof candidate.expiresAt !== "string" ||
    (candidate.outcome !== "streaming-compatible" &&
      candidate.outcome !== "buffered-compatible" &&
      candidate.outcome !== "failed" &&
      candidate.outcome !== "inconclusive") ||
    checks === undefined ||
    !validCheck(checks.authentication) ||
    !validCheck(checks.nonStreamingToolCalling) ||
    !validCheck(checks.streamingToolCalling) ||
    !validCheck(checks.toolContinuation) ||
    ((currentContract || preDeterministicCanaryContract || preDirectToolsContract || preIsolationContract || previousContract) &&
      !validCheck(checks.codexCanary)) ||
    observations === undefined ||
    !Number.isSafeInteger(observations.requestCount) ||
    !Number.isSafeInteger(observations.streamEventCount) ||
    !Number.isSafeInteger(observations.argumentDeltaCount) ||
    candidate.integrity?.algorithm !== "hmac-sha256" ||
    typeof candidate.integrity.value !== "string" ||
    !/^[0-9a-f]{64}$/u.test(candidate.integrity.value)
  ) {
    throw new ConfigurationError(`Bridge evidence has an invalid schema at ${target}.`);
  }
  return candidate as ReadableBridgeEvidence;
}

export function bridgeEvidencePath(
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

export function sealBridgeProbeResult(
  result: BridgeProbeResult,
  apiKey: string,
): StoredBridgeEvidence {
  if (apiKey.length === 0) {
    throw new ConfigurationError("Cannot seal bridge evidence without a credential.");
  }
  const completed = Date.parse(result.completedAt);
  if (!Number.isFinite(completed)) {
    throw new ConfigurationError("Bridge probe completion time is invalid.");
  }
  const unsigned: Omit<StoredBridgeEvidence, "integrity"> = {
    ...structuredClone(result),
    expiresAt: new Date(completed + BRIDGE_EVIDENCE_TTL_MS).toISOString(),
  };
  return {
    ...unsigned,
    integrity: {
      algorithm: "hmac-sha256",
      value: createHmac("sha256", apiKey)
        .update(canonicalJson(unsigned as unknown as JsonValue))
        .digest("hex"),
    },
  };
}

export async function writeBridgeEvidence(
  evidenceDirectory: string,
  evidence: StoredBridgeEvidence,
): Promise<string> {
  await ensurePrivateDirectory(evidenceDirectory);
  const target = bridgeEvidencePath(
    evidenceDirectory,
    evidence.providerId,
    evidence.baseUrl,
    evidence.model,
  );
  await atomicWriteFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  return target;
}

export async function readBridgeEvidence(
  evidenceDirectory: string,
  providerId: string,
  baseUrl: string,
  model: string,
): Promise<ReadableBridgeEvidence | null> {
  const target = bridgeEvidencePath(evidenceDirectory, providerId, baseUrl, model);
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
    throw new ConfigurationError(`Bridge evidence path is not a regular file: ${target}`);
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new ConfigurationError(`Bridge evidence is group- or world-accessible: ${target}`);
  }
  if (info.size > MAX_EVIDENCE_BYTES) {
    throw new ConfigurationError(`Bridge evidence is unexpectedly large: ${target}`);
  }
  return parseBridgeEvidence(await readFile(target, "utf8"), target);
}

export function resolveBridgeEvidence(
  providerId: string,
  baseUrl: string,
  model: string,
  evidence: ReadableBridgeEvidence | null,
  apiKey: string,
  now = new Date(),
): BridgeEvidenceResolution {
  if (evidence === null) {
    return {
      status: "missing",
      usable: false,
      detail: "No authenticated bridge evidence exists for this exact model.",
    };
  }
  const invalid = (detail: string): BridgeEvidenceResolution => ({
    status: "invalid",
    usable: false,
    detail,
    ...(evidence.schemaVersion === BRIDGE_EVIDENCE_SCHEMA_VERSION ? { evidence } : {}),
  });
  if (
    evidence.schemaVersion !== BRIDGE_EVIDENCE_SCHEMA_VERSION ||
    evidence.contract !== CHAT_BRIDGE_FEASIBILITY_CONTRACT
  ) {
    return invalid(
      "Older bridge evidence does not prove the deterministic installed-Codex direct exec_command continuation. Re-run activation for this exact model.",
    );
  }
  if (
    evidence.providerId !== providerId ||
    evidence.baseUrl !== baseUrl ||
    evidence.model !== model ||
    evidence.contract !== CHAT_BRIDGE_FEASIBILITY_CONTRACT
  ) {
    return invalid("Bridge evidence is bound to a different provider, endpoint, model, or contract.");
  }
  const unsigned = unsignedEvidence(evidence);
  const expected = createHmac("sha256", apiKey)
    .update(canonicalJson(unsigned as unknown as JsonValue))
    .digest("hex");
  const actualBytes = Buffer.from(evidence.integrity.value, "hex");
  const expectedBytes = Buffer.from(expected, "hex");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return invalid("Bridge evidence does not match the current credential or was modified.");
  }
  const completedAt = Date.parse(evidence.completedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(completedAt) ||
    !Number.isFinite(expiresAt) ||
    completedAt > nowMs + FUTURE_CLOCK_SKEW_MS ||
    expiresAt <= completedAt ||
    expiresAt - completedAt > BRIDGE_EVIDENCE_TTL_MS ||
    nowMs >= expiresAt
  ) {
    return {
      status: "expired",
      usable: false,
      detail: "Authenticated bridge evidence is expired or has invalid timestamps.",
      evidence,
    };
  }
  const checks = evidence.checks;
  const consistentPass =
    evidence.outcome === "streaming-compatible" &&
    checks.authentication.status === "pass" &&
    checks.nonStreamingToolCalling.status === "pass" &&
    checks.streamingToolCalling.status === "pass" &&
    checks.toolContinuation.status === "pass" &&
    checks.codexCanary.status === "pass" &&
    evidence.observations.requestCount >= 4 &&
    evidence.observations.argumentDeltaCount > 0;
  if (!consistentPass) {
    return {
      status: "failed",
      usable: false,
      detail:
        evidence.outcome === "buffered-compatible"
          ? "Buffered-only bridge evidence is insufficient for Codex streaming tool calls."
          : "The latest bridge probe did not establish a usable streaming Codex bridge.",
      evidence,
    };
  }
  return {
    status: "valid",
    usable: true,
    detail: `Model-bound bridge evidence is valid until ${evidence.expiresAt}.`,
    evidence,
  };
}
