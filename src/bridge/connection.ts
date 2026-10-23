import { activateBridge, recoverReusedBridgeActivation } from "./activation.js";
import type { CredentialHelperConfig } from "../config/codex-toml.js";
import { CapabilityError } from "../errors.js";
import { CodexHarness } from "../harnesses/codex.js";
import { OpenCodeHarness } from "../harnesses/opencode.js";
import type { EnableResult, HarnessStatus } from "../harnesses/types.js";
import type { RuntimePaths } from "../paths.js";
import {
  probeAndStoreKrutrimCapabilities,
  resolveKrutrimProviderForModel,
  withKrutrimCapabilityLock,
} from "../capabilities/krutrim.js";
import { krutrimProvider } from "../providers/krutrim.js";
import type { ProviderAdapter, ProviderCapabilities } from "../providers/types.js";
import type {
  CapabilityProbeResult,
  ModelCapabilityResolution,
} from "../capabilities/evidence.js";
import type { SecretReader } from "../secrets/types.js";
import {
  writeOpenCodeLaunchCredential,
} from "../opencode/launch-credential.js";
import type {
  BridgeEvidenceResolution,
  BridgeProbeResult,
} from "./evidence.js";
import { deriveBridgeBearer } from "./server.js";
import {
  probeAndStoreKrutrimBridgeCapabilities,
  resolveKrutrimBridgeForModel,
} from "./krutrim.js";
import {
  adoptLegacyBridgeRuntime,
  bridgeBaseUrl,
  bridgeRuntimeFileFor,
  bridgeIsHealthy,
  readBridgeRuntime,
  startBridgeRuntime,
  stopBridgeRuntime,
  type BridgeRuntimeOwner,
} from "./runtime.js";

export type CodexConnectionMode = "native" | "bridge";

export interface AutomaticCodexEnableResult extends EnableResult {
  mode: CodexConnectionMode;
}

export interface AutomaticOpenCodeEnableResult extends EnableResult {
  mode: "bridge";
}

export interface AutomaticCodexRouteDecision {
  mode?: CodexConnectionMode;
  native: ModelCapabilityResolution;
  bridge?: BridgeEvidenceResolution;
  provider?: ProviderAdapter;
}

export type AutomaticQualificationStage = "native" | "bridge";

export interface AutomaticCodexQualificationResult {
  decision: AutomaticCodexRouteDecision;
  usedCachedEvidence: boolean;
  nativeProbe?: CapabilityProbeResult;
  bridgeProbe?: BridgeProbeResult;
}

export interface AutomaticBridgeQualificationResult {
  resolution: BridgeEvidenceResolution;
  usedCachedEvidence: boolean;
  bridgeProbe?: BridgeProbeResult;
}

export interface AutomaticCodexEnableOptions {
  codexHarnessOptions?: ConstructorParameters<typeof CodexHarness>[3];
}

export interface AutomaticCodexQualificationOptions {
  now?: () => Date;
  onStage?: (stage: AutomaticQualificationStage) => void;
  retryDelay?: (completedAttempt: number) => Promise<void>;
  decideRoute?: typeof decideCodexRoute;
  nativeProbe?: (
    paths: RuntimePaths,
    model: string,
    apiKey: string,
  ) => Promise<CapabilityProbeResult>;
  bridgeProbe?: (
    paths: RuntimePaths,
    model: string,
    apiKey: string,
  ) => Promise<BridgeProbeResult>;
}

export interface AutomaticBridgeQualificationOptions {
  now?: () => Date;
  onStage?: (stage: "bridge") => void;
  retryDelay?: (completedAttempt: number) => Promise<void>;
  resolveBridge?: typeof resolveKrutrimBridgeForModel;
  bridgeProbe?: (
    paths: RuntimePaths,
    model: string,
    apiKey: string,
  ) => Promise<BridgeProbeResult>;
}

export function shouldRetryBridgeQualification(report: BridgeProbeResult): boolean {
  return (
    report.outcome !== "streaming-compatible" &&
    report.checks.authentication.status === "pass"
  );
}

const MAX_BRIDGE_QUALIFICATION_ATTEMPTS = 3;

async function defaultBridgeRetryDelay(completedAttempt: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, completedAttempt * 500);
  });
}

export async function runBridgeQualificationAttempts<T>(
  operation: () => Promise<T>,
  reportOf: (result: T) => BridgeProbeResult,
  retryDelay: (completedAttempt: number) => Promise<void> = defaultBridgeRetryDelay,
): Promise<T> {
  let result = await operation();
  for (
    let completedAttempt = 1;
    completedAttempt < MAX_BRIDGE_QUALIFICATION_ATTEMPTS &&
      shouldRetryBridgeQualification(reportOf(result));
    completedAttempt += 1
  ) {
    await retryDelay(completedAttempt);
    result = await operation();
  }
  return result;
}

function nativeHelper(cliEntrypoint: string, paths: RuntimePaths): CredentialHelperConfig {
  return {
    command: process.execPath,
    args: [cliEntrypoint, "_credential", "read", "--app-home", paths.appHome],
  };
}

export function bridgeHelper(
  cliEntrypoint: string,
  paths: RuntimePaths,
  instanceId: string,
): CredentialHelperConfig {
  return {
    command: process.execPath,
    args: [
      cliEntrypoint,
      "_credential",
      "bridge",
      "--instance",
      instanceId,
      "--app-home",
      paths.appHome,
    ],
  };
}

export function bridgeCapabilities(): ProviderCapabilities {
  const supported = (detail: string) => ({
    support: "supported" as const,
    evidence: "probed" as const,
    detail,
  });
  return {
    ...krutrimProvider.capabilities,
    responsesApi: supported("The local bridge emits the canonical Responses stream."),
    streaming: supported("The local bridge translates streamed Chat function arguments."),
    toolCalling: supported(
      "Model-bound Chat tool calling, continuation, and a full Codex canary were probed.",
    ),
  };
}

function localBridgeProvider(baseUrl: string): ProviderAdapter {
  const capabilities = bridgeCapabilities();
  return {
    ...krutrimProvider,
    displayName: "KrutrimConnect local bridge",
    baseUrl,
    capabilities,
    capabilitiesFor() {
      return capabilities;
    },
  };
}

export async function decideCodexRoute(
  paths: RuntimePaths,
  model: string,
  apiKey: string,
  now = new Date(),
): Promise<AutomaticCodexRouteDecision> {
  const native = await resolveKrutrimProviderForModel(paths, model, apiKey, now);
  if (native.resolution.status === "valid") {
    return { mode: "native", native: native.resolution, provider: native.provider };
  }
  const bridge = await resolveKrutrimBridgeForModel(paths, model, apiKey, now);
  return {
    ...(bridge.usable ? { mode: "bridge" as const } : {}),
    native: native.resolution,
    bridge,
  };
}

function currentAuthenticatedNativeFailure(
  decision: AutomaticCodexRouteDecision,
): boolean {
  return (
    (decision.native.status === "partial" || decision.native.status === "failed") &&
    decision.native.evidence?.checks.authentication.status === "pass"
  );
}

export async function qualifyCodexRoute(
  paths: RuntimePaths,
  model: string,
  apiKey: string,
  options: AutomaticCodexQualificationOptions = {},
): Promise<AutomaticCodexQualificationResult> {
  const now = options.now ?? (() => new Date());
  const decideRoute = options.decideRoute ?? decideCodexRoute;
  const nativeProbe = options.nativeProbe ?? (async (runtimePaths, exactModel, credential) =>
    (await probeAndStoreKrutrimCapabilities(runtimePaths, {
      model: exactModel,
      apiKey: credential,
    })).report);
  const bridgeProbe = options.bridgeProbe ?? (async (runtimePaths, exactModel, credential) =>
    (await probeAndStoreKrutrimBridgeCapabilities(runtimePaths, {
      model: exactModel,
      apiKey: credential,
    })).report);

  let decision = await decideRoute(paths, model, apiKey, now());
  if (decision.mode !== undefined) {
    return { decision, usedCachedEvidence: true };
  }

  let nativeReport: CapabilityProbeResult | undefined;
  let authenticationPassed = currentAuthenticatedNativeFailure(decision);
  if (!authenticationPassed) {
    options.onStage?.("native");
    nativeReport = await nativeProbe(paths, model, apiKey);
    authenticationPassed = nativeReport.checks.authentication.status === "pass";
    decision = await decideRoute(paths, model, apiKey, now());
    if (decision.mode !== undefined) {
      return {
        decision,
        usedCachedEvidence: false,
        nativeProbe: nativeReport,
      };
    }
  }

  let bridgeReport: BridgeProbeResult | undefined;
  if (authenticationPassed) {
    options.onStage?.("bridge");
    bridgeReport = await runBridgeQualificationAttempts(
      async () => await bridgeProbe(paths, model, apiKey),
      (report) => report,
      options.retryDelay,
    );
    decision = await decideRoute(paths, model, apiKey, now());
  }
  return {
    decision,
    usedCachedEvidence: false,
    ...(nativeReport === undefined ? {} : { nativeProbe: nativeReport }),
    ...(bridgeReport === undefined ? {} : { bridgeProbe: bridgeReport }),
  };
}

export async function qualifyBridgeRoute(
  paths: RuntimePaths,
  model: string,
  apiKey: string,
  options: AutomaticBridgeQualificationOptions = {},
): Promise<AutomaticBridgeQualificationResult> {
  const now = options.now ?? (() => new Date());
  const resolveBridge = options.resolveBridge ?? resolveKrutrimBridgeForModel;
  const bridgeProbe = options.bridgeProbe ?? (async (runtimePaths, exactModel, credential) =>
    (await probeAndStoreKrutrimBridgeCapabilities(runtimePaths, {
      model: exactModel,
      apiKey: credential,
    })).report);
  let resolution = await resolveBridge(paths, model, apiKey, now());
  if (resolution.usable) {
    return { resolution, usedCachedEvidence: true };
  }
  options.onStage?.("bridge");
  const report = await runBridgeQualificationAttempts(
    async () => await bridgeProbe(paths, model, apiKey),
    (probeReport) => probeReport,
    options.retryDelay,
  );
  resolution = await resolveBridge(paths, model, apiKey, now());
  return {
    resolution,
    usedCachedEvidence: false,
    bridgeProbe: report,
  };
}

async function maybeAdoptLegacyRuntime(
  paths: RuntimePaths,
  owner: BridgeRuntimeOwner,
  otherOwner: BridgeRuntimeOwner,
  readOtherStatus: () => Promise<HarnessStatus>,
): Promise<void> {
  const owned = await readBridgeRuntime(bridgeRuntimeFileFor(paths, owner));
  if (owned !== null) {
    return;
  }
  const legacy = await readBridgeRuntime(paths.bridgeRuntimeFile);
  if (legacy === null || !(await bridgeIsHealthy(legacy))) {
    return;
  }
  const otherStatus = await readOtherStatus();
  let otherCanReleaseLegacy =
    otherStatus.state === "disconnected" || otherStatus.connectionMode === "native";
  if (!otherCanReleaseLegacy && otherStatus.connectionMode === "bridge") {
    const otherRuntime = await readBridgeRuntime(
      bridgeRuntimeFileFor(paths, otherOwner),
    );
    otherCanReleaseLegacy =
      otherRuntime !== null &&
      otherRuntime.model === otherStatus.model &&
      await bridgeIsHealthy(otherRuntime);
  }
  if (otherCanReleaseLegacy) {
    await adoptLegacyBridgeRuntime(paths, owner);
  }
}

export async function enableCodexAutomatically(
  paths: RuntimePaths,
  cliEntrypoint: string,
  secrets: SecretReader,
  model: string,
  now = new Date(),
  options: AutomaticCodexEnableOptions = {},
): Promise<AutomaticCodexEnableResult> {
  return await withKrutrimCapabilityLock(paths, async () => {
    await recoverReusedBridgeActivation(paths, "codex");
    const apiKey = await secrets.read();
    if (apiKey === null) {
      throw new CapabilityError("No Krutrim API key is stored. Run krutrimconnect login first.");
    }
    const route = await decideCodexRoute(paths, model, apiKey, now);
    if (route.mode === "native" && route.provider !== undefined) {
      const harness = new CodexHarness(paths, secrets, nativeHelper(cliEntrypoint, paths), {
        ...options.codexHarnessOptions,
        connectionMode: "native",
      });
      const result = await harness.enable(route.provider, model);
      return { ...result, mode: "native" };
    }

    if (route.mode !== "bridge" || route.bridge === undefined) {
      throw new CapabilityError(
        `Codex activation is blocked for '${model}'. Native Responses: ${route.native.detail} ` +
          `Local bridge: ${route.bridge?.detail ?? "No bridge evidence was resolved."} ` +
          "Automatic qualification did not establish a usable route. No config was changed.",
      );
    }

    await maybeAdoptLegacyRuntime(
      paths,
      "codex",
      "opencode",
      async () => await new OpenCodeHarness(paths).status(),
    );
    const runtimeFile = bridgeRuntimeFileFor(paths, "codex");
    const started = await startBridgeRuntime(paths, cliEntrypoint, "codex", model);
    const helper = bridgeHelper(cliEntrypoint, paths, started.record.instanceId);
    const result = await activateBridge(paths, "codex", started, async (signal) => {
      const cancellableSecrets: SecretReader = { read: async () => {
        signal.throwIfAborted();
        let interrupt!: () => void;
        const interrupted = new Promise<never>((_resolve, reject) => {
          interrupt = () => reject(signal.reason);
          signal.addEventListener("abort", interrupt, { once: true });
        });
        try {
          // Race only the read, not harness.enable: its continuation must unwind
          // normally before rollback or lock release. Late credentials cannot
          // resume a cancelled enable or write any config/state/catalogue.
          return await Promise.race([secrets.read(), interrupted]);
        } finally { signal.removeEventListener("abort", interrupt); }
      } };
      const harness = new CodexHarness(paths, cancellableSecrets, helper, {
        ...options.codexHarnessOptions,
        connectionMode: "bridge",
      });
      return await harness.enable(localBridgeProvider(bridgeBaseUrl(started.record)), model);
    });
    if (started.previous !== undefined) {
      await stopBridgeRuntime(runtimeFile, started.previous);
    }
    return { ...result, mode: "bridge" };
  });
}

export async function enableOpenCodeAutomatically(
  paths: RuntimePaths,
  cliEntrypoint: string,
  secrets: SecretReader,
  model: string,
  now = new Date(),
): Promise<AutomaticOpenCodeEnableResult> {
  return await withKrutrimCapabilityLock(paths, async () => {
    await recoverReusedBridgeActivation(paths, "opencode");
    const apiKey = await secrets.read();
    if (apiKey === null) {
      throw new CapabilityError("No Krutrim API key is stored. Run krutrimconnect login first.");
    }
    const bridge = await resolveKrutrimBridgeForModel(paths, model, apiKey, now);
    if (!bridge.usable) {
      throw new CapabilityError(
        `OpenCode activation is blocked for '${model}'. ${bridge.detail} ` +
          "Automatic qualification did not establish a usable route. No configuration was changed.",
      );
    }
    await maybeAdoptLegacyRuntime(
      paths,
      "opencode",
      "codex",
      async () => await new CodexHarness(
        paths,
        secrets,
        nativeHelper(cliEntrypoint, paths),
      ).status(),
    );
    const runtimeFile = bridgeRuntimeFileFor(paths, "opencode");
    const started = await startBridgeRuntime(paths, cliEntrypoint, "opencode", model);
    const harness = new OpenCodeHarness(paths);
    const result = await activateBridge(paths, "opencode", started, async () => {
      await writeOpenCodeLaunchCredential(
        paths.openCodeBridgeCredentialFile,
        deriveBridgeBearer(apiKey, started.record.instanceId),
      );
      return await harness.enable(
        model,
        bridgeBaseUrl(started.record),
        { credentialFile: paths.openCodeBridgeCredentialFile },
      );
    });
    if (started.previous !== undefined) {
      await stopBridgeRuntime(runtimeFile, started.previous);
    }
    return { ...result, mode: "bridge" };
  });
}

export async function bridgeCredential(
  secrets: SecretReader,
  instanceId: string,
): Promise<string> {
  const apiKey = await secrets.read();
  if (apiKey === null) {
    throw new CapabilityError("No Krutrim credential is stored.");
  }
  return deriveBridgeBearer(apiKey, instanceId);
}
