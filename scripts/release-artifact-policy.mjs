import { parseReleaseVersion } from "./release-policy.mjs";

function assertCanonicalVersion(version) {
  parseReleaseVersion(version);
  const components = version.replace("-next.", ".").split(".");
  if (version.trim() !== version || components.some((part) =>
    !/^(?:0|[1-9]\d*)$/u.test(part) || !Number.isSafeInteger(Number(part)))) {
    throw new Error("Release version must use canonical safe-integer components.");
  }
}

export function assertDraftReleaseRequest({ version, packageVersion, confirmation, repository, ref, eventName }) {
  assertCanonicalVersion(version);
  if (eventName !== "workflow_dispatch" || repository !== "ola-krutrim/krutrimconnect") {
    throw new Error("Draft releases require a manual dispatch in ola-krutrim/krutrimconnect.");
  }
  if (packageVersion !== version || ref !== `refs/tags/v${version}`) {
    throw new Error("Dispatch from the existing vVERSION tag matching package.json version.");
  }
  if (confirmation !== `release v${version}`) {
    throw new Error(`Confirmation must exactly equal release v${version}.`);
  }
  return { version, tag: `v${version}`, prerelease: version.includes("-next.") };
}

export function releaseIdentity(version, host = {
  platform: process.platform,
  arch: process.arch,
  nodeVersion: process.versions.node,
  glibcVersion: process.platform === "linux"
    ? process.report.getReport().header.glibcVersionRuntime : undefined,
}) {
  assertCanonicalVersion(version);
  if (!["darwin", "linux"].includes(host.platform) || !["arm64", "x64"].includes(host.arch)) {
    throw new Error("Unsupported release host; use native darwin/linux arm64/x64.");
  }
  if (host.platform === "linux" && !host.glibcVersion) {
    throw new Error("Linux release hosts must use glibc, not musl.");
  }
  return {
    filename: `krutrimconnect-${version}-${host.platform}-${host.arch}.tar.gz`,
    metadata: {
      schemaVersion: 1,
      distribution: "github-release",
      repository: "ola-krutrim/krutrimconnect",
      version,
      platform: host.platform,
      arch: host.arch,
      nodeVersion: host.nodeVersion,
    },
  };
}
