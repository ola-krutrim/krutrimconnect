export interface ParsedReleaseVersion {
  version: string;
  baseVersion: string;
  prerelease: string | null;
}

export interface RegistryMetadata {
  versions?: Record<string, unknown>;
  "dist-tags"?: Record<string, string>;
}

export interface DogfoodManifestBinding {
  package: string;
  version: string;
  sha256: string;
}

export function parseReleaseVersion(version: string): ParsedReleaseVersion;
export function assertChannelVersion(
  channel: "next" | "latest",
  version: string,
): ParsedReleaseVersion;
export function expectedConfirmation(
  packageName: string,
  version: string,
  channel: "next" | "latest",
): string;
export function assertRegistryAllowsRelease(input: {
  packageName: string;
  version: string;
  channel: "next" | "latest";
  metadata: RegistryMetadata;
}): void;
export function assertDogfoodReport(
  report: unknown,
  manifest: DogfoodManifestBinding,
): void;
