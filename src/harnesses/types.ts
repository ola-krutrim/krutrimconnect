import type { CapabilityRequirement, ProviderAdapter } from "../providers/types.js";

export type ConnectionState = "connected" | "disconnected" | "drifted" | "unmanaged";

export interface HarnessStatus {
  harness: string;
  state: ConnectionState;
  model?: string;
  configPath: string;
  configSource: string;
  detail: string;
  connectionMode?: "native" | "bridge";
  modelCatalogPath?: string;
  modelContextWindow?: number;
}

export interface EnableResult {
  changed: boolean;
  configPath: string;
  model: string;
  snapshotPath?: string;
  modelCatalogPath?: string;
  modelContextWindow?: number;
}

export interface DisableResult {
  changed: boolean;
  configPath: string;
  restoredSnapshotPath?: string;
  rescueSnapshotPath?: string;
  preservedCatalogPath?: string;
}

export interface CodingToolHarness {
  readonly id: string;
  readonly displayName: string;
  readonly requiredCapabilities: readonly CapabilityRequirement[];
  status(): Promise<HarnessStatus>;
  enable(provider: ProviderAdapter, model: string): Promise<EnableResult>;
  disable(options?: { force?: boolean }): Promise<DisableResult>;
}
