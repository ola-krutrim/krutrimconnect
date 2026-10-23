import { describe, expect, it } from "vitest";

// Dynamic path keeps the standalone JS tooling independent of TypeScript declarations.
const policyPath = new URL("../../scripts/release-artifact-policy.mjs", import.meta.url).href;

describe("GitHub release artifact policy", () => {
  it("requires an exact manual confirmation bound to the repository, tag, and package version", async () => {
    const { assertDraftReleaseRequest } = await import(policyPath);
    const request = {
      version: "1.2.3", packageVersion: "1.2.3", confirmation: "release v1.2.3",
      repository: "ola-krutrim/krutrimconnect", ref: "refs/tags/v1.2.3", eventName: "workflow_dispatch",
    };
    expect(assertDraftReleaseRequest(request)).toEqual({ version: "1.2.3", tag: "v1.2.3", prerelease: false });
    for (const change of [
      { confirmation: "release v1.2.3 " }, { confirmation: "publish 1.2.3" },
      { packageVersion: "1.2.4" }, { repository: "fork/Krutrim_Connect" },
      { ref: "refs/heads/main" }, { ref: "refs/tags/v1.2.4" }, { eventName: "push" },
      { version: "01.2.3" },
    ]) expect(() => assertDraftReleaseRequest({ ...request, ...change })).toThrow();
    expect(assertDraftReleaseRequest({ ...request, version: "1.2.3-next.1", packageVersion: "1.2.3-next.1",
      confirmation: "release v1.2.3-next.1", ref: "refs/tags/v1.2.3-next.1" }).prerelease).toBe(true);
  });

  it("binds artifact identity to supported native hosts and exact release versions", async () => {
    const { releaseIdentity } = await import(policyPath);
    expect(releaseIdentity("1.2.3-next.4", {
      platform: "darwin", arch: "arm64", nodeVersion: "22.18.0",
    })).toEqual({
      filename: "krutrimconnect-1.2.3-next.4-darwin-arm64.tar.gz",
      metadata: {
        schemaVersion: 1, distribution: "github-release",
        repository: "ola-krutrim/krutrimconnect", version: "1.2.3-next.4",
        platform: "darwin", arch: "arm64", nodeVersion: "22.18.0",
      },
    });
    for (const version of ["v1.2.3", "1.2.3-beta.1", "1.2.3\n", "../1.2.3", "01.2.3", "1.02.3", "1.2.3-next.01", "9007199254740992.2.3"]) {
      expect(() => releaseIdentity(version)).toThrow(/version/iu);
    }
    for (const host of [
      { platform: "win32", arch: "x64" },
      { platform: "darwin", arch: "ia32" },
      { platform: "linux", arch: "x64" },
    ]) {
      expect(() => releaseIdentity("1.2.3", host)).toThrow(/host|glibc/iu);
    }
    expect(releaseIdentity("1.2.3", {
      platform: "linux", arch: "x64", glibcVersion: "2.35", nodeVersion: "22.18.0",
    }).filename).toBe("krutrimconnect-1.2.3-linux-x64.tar.gz");
  });
});
