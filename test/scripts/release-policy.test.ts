import { describe, expect, it } from "vitest";

import {
  assertChannelVersion,
  assertDogfoodReport,
  assertRegistryAllowsRelease,
  expectedConfirmation,
  parseReleaseVersion,
} from "../../scripts/release-policy.mjs";

const manifest = {
  package: "krutrimconnect",
  version: "0.1.0-next.0",
  sha256: "a".repeat(64),
};

function passingDogfoodReport(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    package: manifest.package,
    version: manifest.version,
    artifactSha256: manifest.sha256,
    outcome: "passed",
    testedAt: "2026-08-20T08:00:00.000Z",
    tester: "internal-release-tester",
    os: "macOS 15",
    nodeVersion: "20.17.0",
    npmVersion: "11.17.0",
    model: "gpt-oss-20b",
    route: "bridge",
    activation: "passed",
    toolContinuation: "passed",
    disconnect: "passed",
    configRestoration: "passed",
  };
}

describe("release policy", () => {
  it("parses only stable and numbered next versions", () => {
    expect(parseReleaseVersion("0.1.0-next.3")).toEqual({
      version: "0.1.0-next.3",
      baseVersion: "0.1.0",
      prerelease: "next.3",
    });
    expect(parseReleaseVersion("0.1.0").prerelease).toBeNull();
    expect(() => parseReleaseVersion("0.1.0-beta.1")).toThrow(/X\.Y\.Z/u);
  });

  it("prevents prereleases on latest and stable versions on next", () => {
    expect(() => assertChannelVersion("latest", "0.1.0-next.0")).toThrow(/refuses/u);
    expect(() => assertChannelVersion("next", "0.1.0")).toThrow(/requires/u);
  });

  it("rejects a version that already exists", () => {
    expect(() => assertRegistryAllowsRelease({
      packageName: "krutrimconnect",
      version: "0.1.0-next.0",
      channel: "next",
      metadata: { versions: { "0.1.0-next.0": {} }, "dist-tags": {} },
    })).toThrow(/already present/u);
  });

  it("requires a same-base public next before stable latest", () => {
    expect(() => assertRegistryAllowsRelease({
      packageName: "krutrimconnect",
      version: "0.1.0",
      channel: "latest",
      metadata: { versions: {}, "dist-tags": { next: "0.2.0-next.0" } },
    })).toThrow(/requires next/u);
    expect(() => assertRegistryAllowsRelease({
      packageName: "krutrimconnect",
      version: "0.1.0",
      channel: "latest",
      metadata: { versions: {}, "dist-tags": { next: "0.1.0-next.0" } },
    })).not.toThrow();
  });

  it("never accepts a prerelease already assigned to latest", () => {
    expect(() => assertRegistryAllowsRelease({
      packageName: "krutrimconnect",
      version: "0.2.0-next.0",
      channel: "next",
      metadata: { versions: {}, "dist-tags": { latest: "0.1.0-next.0" } },
    })).toThrow(/latest points to prerelease/u);
  });

  it("validates complete dogfood evidence bound to the artifact", () => {
    expect(() => assertDogfoodReport(passingDogfoodReport(), manifest)).not.toThrow();
    const failed = { ...passingDogfoodReport(), configRestoration: "failed" };
    expect(() => assertDogfoodReport(failed, manifest)).toThrow(/configRestoration/u);
  });

  it("produces one exact publication confirmation", () => {
    expect(expectedConfirmation("krutrimconnect", "0.1.0-next.0", "next"))
      .toBe("publish krutrimconnect@0.1.0-next.0 as next");
  });
});
