import { readFileSync } from "node:fs";

interface PackageMetadata {
  version?: unknown;
}

export function readPackageVersion(packageUrl = new URL("../package.json", import.meta.url)): string {
  const metadata = JSON.parse(readFileSync(packageUrl, "utf8")) as PackageMetadata;
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(metadata.version)) {
    throw new Error("package.json contains an invalid version.");
  }
  return metadata.version;
}

export const KRUTRIM_CONNECT_VERSION = readPackageVersion();
