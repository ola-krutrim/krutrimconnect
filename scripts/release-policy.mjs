const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/u;

export function parseReleaseVersion(version) {
  if (typeof version !== "string") {
    throw new Error("Release version must be a string.");
  }
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error("Release versions must use X.Y.Z or X.Y.Z-next.N.");
  }
  const [, major, minor, patch, next] = match;
  return {
    version,
    baseVersion: `${major}.${minor}.${patch}`,
    prerelease: next === undefined ? null : `next.${next}`,
  };
}

export function assertChannelVersion(channel, version) {
  if (channel !== "next" && channel !== "latest") {
    throw new Error("Release channel must be next or latest.");
  }
  const parsed = parseReleaseVersion(version);
  if (channel === "next" && parsed.prerelease === null) {
    throw new Error("The next channel requires an X.Y.Z-next.N prerelease version.");
  }
  if (channel === "latest" && parsed.prerelease !== null) {
    throw new Error("The latest channel refuses prerelease versions.");
  }
  return parsed;
}

export function expectedConfirmation(packageName, version, channel) {
  return `publish ${packageName}@${version} as ${channel}`;
}

export function assertRegistryAllowsRelease({ packageName, version, channel, metadata }) {
  const parsed = assertChannelVersion(channel, version);
  const versions = metadata?.versions ?? {};
  const distTags = metadata?.["dist-tags"] ?? {};

  if (Object.prototype.hasOwnProperty.call(versions, version)) {
    throw new Error(`${packageName}@${version} is already present in the npm registry.`);
  }

  const currentLatest = distTags.latest;
  if (currentLatest !== undefined) {
    const latestVersion = parseReleaseVersion(currentLatest);
    if (latestVersion.prerelease !== null) {
      throw new Error(`Registry latest points to prerelease ${currentLatest}; refusing release.`);
    }
  }

  if (channel === "latest") {
    const currentNext = distTags.next;
    if (typeof currentNext !== "string") {
      throw new Error("Stable latest requires an existing public next dist-tag.");
    }
    const nextVersion = parseReleaseVersion(currentNext);
    if (
      nextVersion.prerelease === null ||
      nextVersion.baseVersion !== parsed.baseVersion
    ) {
      throw new Error(
        `Stable ${version} requires next to point to a prerelease of ${parsed.baseVersion}.`,
      );
    }
  }
}

export function assertDogfoodReport(report, manifest) {
  if (!report || typeof report !== "object") {
    throw new Error("Dogfood report must be a JSON object.");
  }
  const exactValues = {
    schemaVersion: 1,
    package: manifest.package,
    version: manifest.version,
    artifactSha256: manifest.sha256,
    outcome: "passed",
    activation: "passed",
    toolContinuation: "passed",
    disconnect: "passed",
    configRestoration: "passed",
  };
  for (const [field, expected] of Object.entries(exactValues)) {
    if (report[field] !== expected) {
      throw new Error(`Dogfood report field ${field} must equal ${String(expected)}.`);
    }
  }
  for (const field of ["testedAt", "tester", "os", "nodeVersion", "npmVersion", "model", "route"]) {
    if (typeof report[field] !== "string" || report[field].trim().length === 0) {
      throw new Error(`Dogfood report field ${field} must be a non-empty string.`);
    }
  }
  if (report.route !== "native" && report.route !== "bridge") {
    throw new Error("Dogfood report route must be native or bridge.");
  }
  if (!Number.isFinite(Date.parse(report.testedAt))) {
    throw new Error("Dogfood report testedAt must be an ISO-compatible timestamp.");
  }
}
