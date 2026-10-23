import path from "node:path";

import { ensurePrivateDirectory, withFileLock } from "../fs/atomic.js";
import type { RuntimePaths } from "../paths.js";
import { krutrimProvider } from "../providers/krutrim.js";
import type { ProviderAdapter } from "../providers/types.js";
import { assertModelDoesNotExposeCredential } from "../security/model.js";
import { redactValue } from "../security/redact.js";
import {
  runKrutrimCodexProbe,
  type KrutrimProbeOptions,
} from "../probes/krutrim-responses.js";
import {
  prepareCodexModelCatalog,
  removeManagedCodexModelCatalog,
  type CodexCatalogTemplateLoader,
  type KrutrimModelMetadataResolver,
} from "../codex/model-catalog.js";
import {
  runCodexNativeCanary,
  type CodexNativeCanaryResult,
} from "../probes/codex-native-canary.js";
import {
  CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  CODEX_RESPONSES_TOOL_CONTRACT,
  bindModelCapabilities,
  readCapabilityEvidence,
  resolveModelCapabilities,
  sealCapabilityProbeResult,
  writeCapabilityEvidence,
  type CapabilityProbeResult,
  type ModelCapabilityResolution,
  type StoredCapabilityEvidence,
} from "./evidence.js";

export interface ResolvedKrutrimProvider {
  provider: ProviderAdapter;
  resolution: ModelCapabilityResolution;
}

export interface StoredKrutrimProbe extends ResolvedKrutrimProvider {
  report: CapabilityProbeResult;
  evidence: StoredCapabilityEvidence;
  evidencePath: string;
}

type ApiKeySource = string | (() => Promise<string>);

async function resolveApiKey(source: ApiKeySource): Promise<string> {
  return typeof source === "string" ? source : await source();
}

export async function withKrutrimCapabilityLock<T>(
  paths: RuntimePaths,
  operation: () => Promise<T>,
): Promise<T> {
  await ensurePrivateDirectory(paths.capabilityEvidenceDir);
  return await withFileLock(
    path.join(paths.capabilityEvidenceDir, ".probe.lock"),
    operation,
  );
}

export async function resolveKrutrimProviderForModel(
  paths: RuntimePaths,
  model: string,
  apiKey: string,
  now = new Date(),
): Promise<ResolvedKrutrimProvider> {
  const resolvedModel = krutrimProvider.resolveModel(model);
  assertModelDoesNotExposeCredential(resolvedModel.id, apiKey);
  const evidence = await readCapabilityEvidence(
    paths.capabilityEvidenceDir,
    krutrimProvider.id,
    krutrimProvider.baseUrl,
    resolvedModel.id,
  );
  const resolution = resolveModelCapabilities(
    krutrimProvider,
    resolvedModel.id,
    evidence,
    apiKey,
    now,
  );
  return {
    provider: bindModelCapabilities(
      krutrimProvider,
      resolvedModel.id,
      resolution.capabilities,
    ),
    resolution,
  };
}

export async function withResolvedKrutrimProviderForModel<T>(
  paths: RuntimePaths,
  model: string,
  apiKeySource: () => Promise<string>,
  operation: (resolved: ResolvedKrutrimProvider) => Promise<T>,
  now = new Date(),
): Promise<T> {
  return await withKrutrimCapabilityLock(paths, async () => {
    const apiKey = await apiKeySource();
    const resolved = await resolveKrutrimProviderForModel(paths, model, apiKey, now);
    return await operation(resolved);
  });
}

export interface StoredKrutrimProbeOptions
  extends Omit<KrutrimProbeOptions, "provider" | "apiKey"> {
  apiKey: ApiKeySource;
  nativeProbe?: (options: KrutrimProbeOptions) => Promise<CapabilityProbeResult>;
  codexCanary?: (options: {
    model: string;
    apiKey: string;
    modelCatalogPath: string;
  }) => Promise<CodexNativeCanaryResult>;
  metadataResolver?: KrutrimModelMetadataResolver;
  catalogTemplateLoader?: CodexCatalogTemplateLoader;
}

export async function probeAndStoreKrutrimCapabilities(
  paths: RuntimePaths,
  options: StoredKrutrimProbeOptions,
): Promise<StoredKrutrimProbe> {
  return await withKrutrimCapabilityLock(paths, async () => {
    const apiKey = await resolveApiKey(options.apiKey);
    const {
      apiKey: _apiKeySource,
      nativeProbe = runKrutrimCodexProbe,
      codexCanary = runCodexNativeCanary,
      metadataResolver,
      catalogTemplateLoader,
      ...probeOptions
    } = options;
    const resolvedModel = krutrimProvider.resolveModel(probeOptions.model).id;
    assertModelDoesNotExposeCredential(resolvedModel, apiKey);
    const pendingAt = (probeOptions.now?.() ?? new Date()).toISOString();
    const pendingResult: CapabilityProbeResult = {
      schemaVersion: CAPABILITY_EVIDENCE_SCHEMA_VERSION,
      contract: CODEX_RESPONSES_TOOL_CONTRACT,
      providerId: krutrimProvider.id,
      baseUrl: krutrimProvider.baseUrl,
      model: resolvedModel,
      outcome: "inconclusive",
      startedAt: pendingAt,
      completedAt: pendingAt,
      checks: {
        authentication: { status: "not-run", detail: "A new probe started but has not completed." },
        responsesApi: { status: "not-run", detail: "A new probe started but has not completed." },
        streaming: { status: "not-run", detail: "A new probe started but has not completed." },
        toolCalling: { status: "not-run", detail: "A new probe started but has not completed." },
        codexCanary: { status: "not-run", detail: "A new probe started but has not completed." },
      },
      observations: { requestCount: 0, eventTypes: [] },
    };
    // Invalidate an older pass before any network request. A crash or failed
    // final write therefore leaves fail-closed evidence rather than a stale
    // passing record.
    await writeCapabilityEvidence(
      paths.capabilityEvidenceDir,
      sealCapabilityProbeResult(pendingResult, apiKey),
    );
    const syntheticReport = await nativeProbe({
      ...probeOptions,
      apiKey,
      provider: krutrimProvider,
    });
    let report = syntheticReport;
    if (syntheticReport.outcome === "passed") {
      let canary: CodexNativeCanaryResult;
      let catalog: Awaited<ReturnType<typeof prepareCodexModelCatalog>> | undefined;
      try {
        catalog = await prepareCodexModelCatalog(paths, {
          model: resolvedModel,
          apiKey,
          mode: "native",
          ...(metadataResolver === undefined ? {} : { metadataResolver }),
          ...(catalogTemplateLoader === undefined ? {} : { templateLoader: catalogTemplateLoader }),
        });
        canary = await codexCanary({
          model: resolvedModel,
          apiKey,
          modelCatalogPath: catalog.path,
        });
      } catch {
        canary = {
          status: "inconclusive",
          check: {
            status: "fail",
            detail: "The managed-catalog native Codex canary failed before a qualification result was available.",
          },
        };
      } finally {
        if (catalog?.created === true) {
          await removeManagedCodexModelCatalog(
            paths,
            catalog.path,
            catalog.sha256,
          ).catch(() => undefined);
        }
      }
      report = {
        ...syntheticReport,
        outcome: canary.status === "pass"
          ? "passed"
          : canary.status === "fail"
            ? "failed"
            : "inconclusive",
        completedAt: (probeOptions.now?.() ?? new Date()).toISOString(),
        checks: {
          ...syntheticReport.checks,
          codexCanary: canary.check,
        },
      };
    }
    const evidence = sealCapabilityProbeResult(report, apiKey);
    const evidencePath = await writeCapabilityEvidence(paths.capabilityEvidenceDir, evidence);
    const resolution = resolveModelCapabilities(
      krutrimProvider,
      report.model,
      evidence,
      apiKey,
      new Date(report.completedAt),
    );
    return {
      report: redactValue(report, [apiKey]) as CapabilityProbeResult,
      evidence,
      evidencePath,
      resolution,
      provider: bindModelCapabilities(krutrimProvider, report.model, resolution.capabilities),
    };
  });
}
