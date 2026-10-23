export type {
  CapabilityEvidence,
  CapabilityFlag,
  CapabilityName,
  CapabilityRequirement,
  CapabilitySupport,
  ProviderAdapter,
  ProviderCapabilities,
  ResolvedModel,
} from "./providers/types.js";
export { KRUTRIM_BASE_URL, krutrimProvider } from "./providers/krutrim.js";
export {
  KRUTRIM_CATALOG,
  KRUTRIM_CATALOG_OBSERVED,
  KRUTRIM_CATALOG_SOURCE,
  KRUTRIM_MODALITIES,
  findKrutrimModel,
  isKrutrimModality,
  listKrutrimModels,
} from "./catalog/krutrim.js";
export type {
  KrutrimCatalogModel,
  KrutrimCatalogSnapshot,
  KrutrimModality,
  ListKrutrimModelsOptions,
} from "./catalog/krutrim.js";
export { runKrutrimChatCompletion } from "./inference/chat-completions.js";
export type {
  ChatCompletionUsage,
  KrutrimChatCompletion,
  KrutrimChatOptions,
} from "./inference/chat-completions.js";
export {
  BRIDGE_EVIDENCE_SCHEMA_VERSION,
  BRIDGE_EVIDENCE_TTL_MS,
  CHAT_BRIDGE_FEASIBILITY_CONTRACT,
  bridgeEvidencePath,
  readBridgeEvidence,
  resolveBridgeEvidence,
  sealBridgeProbeResult,
  writeBridgeEvidence,
} from "./bridge/evidence.js";
export type {
  BridgeProbeCheck,
  BridgeProbeCheckStatus,
  BridgeProbeOutcome,
  BridgeProbeResult,
  BridgeEvidenceResolution,
  BridgeEvidenceStatus,
  StoredBridgeEvidence,
} from "./bridge/evidence.js";
export {
  probeAndStoreKrutrimBridgeCapabilities,
  resolveKrutrimBridgeForModel,
} from "./bridge/krutrim.js";
export type {
  StoredKrutrimBridgeProbe,
  StoredKrutrimBridgeProbeOptions,
} from "./bridge/krutrim.js";
export {
  bridgeCapabilities,
  decideCodexRoute,
  enableCodexAutomatically,
  enableOpenCodeAutomatically,
  qualifyBridgeRoute,
  qualifyCodexRoute,
} from "./bridge/connection.js";
export type {
  AutomaticBridgeQualificationOptions,
  AutomaticBridgeQualificationResult,
  AutomaticCodexEnableResult,
  AutomaticCodexEnableOptions,
  AutomaticCodexQualificationOptions,
  AutomaticCodexQualificationResult,
  AutomaticCodexRouteDecision,
  AutomaticOpenCodeEnableResult,
  AutomaticQualificationStage,
  CodexConnectionMode,
} from "./bridge/connection.js";
export type {
  CodingToolHarness,
  ConnectionState,
  DisableResult,
  EnableResult,
  HarnessStatus,
} from "./harnesses/types.js";
export { CodexHarness } from "./harnesses/codex.js";
export { OpenCodeHarness } from "./harnesses/opencode.js";
export {
  OPENCODE_BRIDGE_TOKEN_ENV,
  OPENCODE_PROVIDER_ID,
  OPENCODE_SCHEMA_URL,
  configuredOpenCodeModel,
  hasOpenCodeProvider,
  mappingMatchesOpenCode,
  mergeOpenCodeMapping,
  rebaseOpenCodeRollbackSource,
} from "./config/opencode-json.js";
export type { OpenCodeManagedMapping } from "./config/opencode-json.js";
export {
  CAPABILITY_EVIDENCE_SCHEMA_VERSION,
  CAPABILITY_EVIDENCE_TTL_MS,
  CODEX_RESPONSES_TOOL_CONTRACT,
  bindModelCapabilities,
  capabilityEvidencePath,
  readCapabilityEvidence,
  resolveModelCapabilities,
  sealCapabilityProbeResult,
  writeCapabilityEvidence,
} from "./capabilities/evidence.js";
export type {
  CapabilityEvidenceStatus,
  CapabilityProbeCheck,
  CapabilityProbeResult,
  ModelCapabilityResolution,
  ProbeCheckStatus,
  ProbeOutcome,
  StoredCapabilityEvidence,
} from "./capabilities/evidence.js";
export {
  probeAndStoreKrutrimCapabilities,
  resolveKrutrimProviderForModel,
  withKrutrimCapabilityLock,
  withResolvedKrutrimProviderForModel,
} from "./capabilities/krutrim.js";
export type {
  ResolvedKrutrimProvider,
  StoredKrutrimProbeOptions,
  StoredKrutrimProbe,
} from "./capabilities/krutrim.js";
export {
  PUBLIC_NPM_REGISTRY,
  PUBLIC_PACKAGE_NAME,
  TESTING_NPM_REGISTRY,
  TESTING_PACKAGE_NAME,
  compareReleaseVersions,
  installedVersionFromNpmList,
  npmInstallArguments,
  npmInvocation,
  npmListArguments,
  npmViewArguments,
  readInstalledPackageMetadata,
  resolveUpgradeTarget,
  systemNpmExecutor,
  upgradeKrutrimConnect,
} from "./upgrade.js";
export type {
  InstalledPackageMetadata,
  UpgradeNpmExecutor,
  UpgradeOptions,
  UpgradeResult,
  UpgradeTarget,
} from "./upgrade.js";
export { removeKrutrimCredential, storeKrutrimCredential } from "./credentials.js";
export type {
  CredentialRemover,
  CredentialStoreOptions,
  CredentialValidator,
  CredentialWriter,
} from "./credentials.js";
export {
  KRUTRIM_CREDENTIAL_VALIDATION_METHOD,
  KRUTRIM_MODELS_URL,
  MAX_STDIN_API_KEY_BYTES,
  fetchKrutrimModelCatalogue,
  readApiKeyInput,
  selectApiKeyInputSource,
  validateKrutrimApiKey,
} from "./auth.js";
export type {
  ApiKeyInputSelection,
  ApiKeyInputSource,
  CredentialValidation,
  CredentialValidationDescription,
  KrutrimCredentialValidationOptions,
  PassedCredentialValidation,
  SkippedCredentialValidation,
} from "./auth.js";
export { runKrutrimCodexProbe } from "./probes/krutrim-responses.js";
export type { KrutrimProbeOptions } from "./probes/krutrim-responses.js";
export { runKrutrimChatBridgeProbe } from "./probes/krutrim-chat-tools.js";
export type { KrutrimChatBridgeProbeOptions } from "./probes/krutrim-chat-tools.js";
export {
  runCodexBridgeCanary,
  runCodexCanaryProcess,
} from "./probes/codex-bridge-canary.js";
export type {
  CodexBridgeCanaryOptions,
  CodexCanaryProcessRequest,
  CodexCanaryProcessResult,
  CodexCanaryProcessRunner,
} from "./probes/codex-bridge-canary.js";
export { runCodexNativeCanary } from "./probes/codex-native-canary.js";
export type {
  CodexNativeCanaryOptions,
  CodexNativeCanaryResult,
} from "./probes/codex-native-canary.js";
export { rebaseCodexRollbackSource } from "./config/codex-toml.js";
export {
  buildCodexModelCatalog,
  fetchKrutrimModelMetadata,
  loadInstalledCodexCatalogTemplate,
  managedCodexModelCatalogIsIntact,
  prepareCodexModelCatalog,
  removeManagedCodexModelCatalog,
  serializeCodexModelCatalog,
} from "./codex/model-catalog.js";
export type {
  CodexCatalogTemplateLoader,
  CodexConnectionCatalogMode,
  KrutrimLiveModelMetadata,
  KrutrimModelMetadataResolver,
  PrepareCodexModelCatalogOptions,
  PreparedCodexModelCatalog,
} from "./codex/model-catalog.js";
export { assertModelDoesNotExposeCredential } from "./security/model.js";
