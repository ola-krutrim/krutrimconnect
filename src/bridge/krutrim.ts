import type { RuntimePaths } from "../paths.js";
import { krutrimProvider } from "../providers/krutrim.js";
import { assertModelDoesNotExposeCredential } from "../security/model.js";
import { redactValue } from "../security/redact.js";
import { withKrutrimCapabilityLock } from "../capabilities/krutrim.js";
import {
  BRIDGE_EVIDENCE_SCHEMA_VERSION,
  CHAT_BRIDGE_FEASIBILITY_CONTRACT,
  readBridgeEvidence,
  resolveBridgeEvidence,
  sealBridgeProbeResult,
  writeBridgeEvidence,
  type BridgeProbeResult,
  type BridgeEvidenceResolution,
  type StoredBridgeEvidence,
  type BridgeProbeCheck,
} from "./evidence.js";
import {
  runKrutrimChatBridgeProbe,
  type KrutrimChatBridgeProbeOptions,
} from "../probes/krutrim-chat-tools.js";
import { runCodexBridgeCanary } from "../probes/codex-bridge-canary.js";
import {
  prepareCodexModelCatalog,
  removeManagedCodexModelCatalog,
  type CodexCatalogTemplateLoader,
  type KrutrimModelMetadataResolver,
} from "../codex/model-catalog.js";

type ApiKeySource = string | (() => Promise<string>);

export interface StoredKrutrimBridgeProbe {
  report: BridgeProbeResult;
  evidence: StoredBridgeEvidence;
  evidencePath: string;
}

export interface StoredKrutrimBridgeProbeOptions
  extends Omit<KrutrimChatBridgeProbeOptions, "provider" | "apiKey"> {
  apiKey: ApiKeySource;
  codexCanary?: (options: {
    model: string;
    apiKey: string;
    modelCatalogPath: string;
  }) => Promise<BridgeProbeCheck>;
  metadataResolver?: KrutrimModelMetadataResolver;
  catalogTemplateLoader?: CodexCatalogTemplateLoader;
}

export async function resolveKrutrimBridgeForModel(
  paths: RuntimePaths,
  model: string,
  apiKey: string,
  now = new Date(),
): Promise<BridgeEvidenceResolution> {
  const resolvedModel = krutrimProvider.resolveModel(model).id;
  assertModelDoesNotExposeCredential(resolvedModel, apiKey);
  const evidence = await readBridgeEvidence(
    paths.bridgeEvidenceDir,
    krutrimProvider.id,
    krutrimProvider.baseUrl,
    resolvedModel,
  );
  return resolveBridgeEvidence(
    krutrimProvider.id,
    krutrimProvider.baseUrl,
    resolvedModel,
    evidence,
    apiKey,
    now,
  );
}

async function resolveApiKey(source: ApiKeySource): Promise<string> {
  return typeof source === "string" ? source : await source();
}

export async function probeAndStoreKrutrimBridgeCapabilities(
  paths: RuntimePaths,
  options: StoredKrutrimBridgeProbeOptions,
): Promise<StoredKrutrimBridgeProbe> {
  return await withKrutrimCapabilityLock(paths, async () => {
    const apiKey = await resolveApiKey(options.apiKey);
    const {
      apiKey: _apiKeySource,
      codexCanary = runCodexBridgeCanary,
      metadataResolver,
      catalogTemplateLoader,
      ...probeOptions
    } = options;
    const model = krutrimProvider.resolveModel(probeOptions.model).id;
    assertModelDoesNotExposeCredential(model, apiKey);

    const pendingAt = (probeOptions.now?.() ?? new Date()).toISOString();
    const pending: BridgeProbeResult = {
      schemaVersion: BRIDGE_EVIDENCE_SCHEMA_VERSION,
      contract: CHAT_BRIDGE_FEASIBILITY_CONTRACT,
      providerId: krutrimProvider.id,
      baseUrl: krutrimProvider.baseUrl,
      model,
      outcome: "inconclusive",
      startedAt: pendingAt,
      completedAt: pendingAt,
      checks: {
        authentication: { status: "not-run", detail: "A new bridge probe started but has not completed." },
        nonStreamingToolCalling: { status: "not-run", detail: "A new bridge probe started but has not completed." },
        streamingToolCalling: { status: "not-run", detail: "A new bridge probe started but has not completed." },
        toolContinuation: { status: "not-run", detail: "A new bridge probe started but has not completed." },
        codexCanary: { status: "not-run", detail: "A new bridge probe started but has not completed." },
      },
      observations: { requestCount: 0, streamEventCount: 0, argumentDeltaCount: 0 },
    };
    await writeBridgeEvidence(paths.bridgeEvidenceDir, sealBridgeProbeResult(pending, apiKey));

    const feasibility = await runKrutrimChatBridgeProbe({
      ...probeOptions,
      provider: krutrimProvider,
      apiKey,
    });
    let report = feasibility;
    if (feasibility.outcome === "streaming-compatible") {
      let codexCanaryCheck: BridgeProbeCheck;
      let catalog: Awaited<ReturnType<typeof prepareCodexModelCatalog>> | undefined;
      try {
        catalog = await prepareCodexModelCatalog(paths, {
          model,
          apiKey,
          mode: "bridge",
          ...(metadataResolver === undefined ? {} : { metadataResolver }),
          ...(catalogTemplateLoader === undefined ? {} : { templateLoader: catalogTemplateLoader }),
        });
        codexCanaryCheck = await codexCanary({
          model,
          apiKey,
          modelCatalogPath: catalog.path,
        });
      } catch {
        codexCanaryCheck = {
          status: "inconclusive",
          detail: "The managed-catalog Codex canary failed before a qualification result was available.",
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
        ...feasibility,
        outcome: codexCanaryCheck.status === "pass"
          ? "streaming-compatible"
          : codexCanaryCheck.status === "fail"
            ? "failed"
            : "inconclusive",
        completedAt: (probeOptions.now?.() ?? new Date()).toISOString(),
        checks: {
          ...feasibility.checks,
          codexCanary: codexCanaryCheck,
        },
      };
    }
    const evidence = sealBridgeProbeResult(report, apiKey);
    const evidencePath = await writeBridgeEvidence(paths.bridgeEvidenceDir, evidence);
    return {
      report: redactValue(report, [apiKey]) as BridgeProbeResult,
      evidence,
      evidencePath,
    };
  });
}
