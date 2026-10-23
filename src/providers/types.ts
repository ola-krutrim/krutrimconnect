export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export type CapabilityEvidence = "documented" | "probed" | "unknown";

export interface CapabilityFlag {
  support: CapabilitySupport;
  evidence: CapabilityEvidence;
  detail: string;
}

export interface ProviderCapabilities {
  responsesApi: CapabilityFlag;
  streaming: CapabilityFlag;
  toolCalling: CapabilityFlag;
  structuredOutput: CapabilityFlag;
  modelListing: CapabilityFlag;
}

export interface ResolvedModel {
  id: string;
  source: "explicit" | "catalog";
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly authentication: {
    readonly scheme: "bearer";
    readonly source: "credential-helper";
  };
  readonly capabilities: ProviderCapabilities;
  resolveModel(requestedModel: string): ResolvedModel;
  capabilitiesFor(model: ResolvedModel): ProviderCapabilities;
}

export type CapabilityName = keyof ProviderCapabilities;

export interface CapabilityRequirement {
  name: CapabilityName;
  reason: string;
}
