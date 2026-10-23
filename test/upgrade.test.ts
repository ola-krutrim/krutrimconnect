import { afterEach, describe, expect, it, vi } from "vitest";
import * as releases from "../src/release-install.js";

import {
  PUBLIC_NPM_REGISTRY,
  TESTING_NPM_REGISTRY,
  compareReleaseVersions,
  installedVersionFromNpmList,
  npmInstallArguments,
  npmInvocation,
  npmListArguments,
  npmViewArguments,
  resolveUpgradeTarget,
  upgradeKrutrimConnect,
  type UpgradeNpmExecutor,
  type UpgradeTarget,
} from "../src/upgrade.js";

function executorWith(version: string): {
  executor: UpgradeNpmExecutor;
  install: ReturnType<typeof vi.fn>;
} {
  const install = vi.fn(async (_target: UpgradeTarget, _version: string) => undefined);
  return {
    executor: {
      viewVersion: async () => version,
      install,
    },
    install,
  };
}

describe("KrutrimConnect upgrade", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("checks the fixed latest GitHub endpoint with a timeout and no redirects", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.2.3", prerelease: false, draft: false })));
    vi.stubGlobal("fetch", fetcher);
    expect(await releases.latestReleaseVersion({ env: {} })).toBe("1.2.3");
    expect(fetcher).toHaveBeenCalledWith("https://api.github.com/repos/ola-krutrim/krutrimconnect/releases/latest", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
  });
  it.each([
    { tag_name: "v1.2.3-next.1", prerelease: true, draft: false },
    { tag_name: "v1.2.3", prerelease: false, draft: true },
    { tag_name: "https://attacker.invalid", prerelease: false, draft: false },
    { tag_name: "v1.2.3", prerelease: false, draft: false, padding: "x".repeat(262145) },
  ])("rejects unsafe latest release metadata %#", async (value) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(value))));
    await expect(releases.latestReleaseVersion({ env: {} })).rejects.toThrow(/release/u);
  });
  it("refuses unsuccessful GitHub responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.2.3" }), { status: 403 })));
    await expect(releases.latestReleaseVersion({ env: {} })).rejects.toThrow(/release/u);
  });
  it("uses authenticated gh metadata only when explicitly opted in", async () => {
    const run = vi.fn(async () => "v1.2.3\n");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await releases.latestReleaseVersion({ env: { KRUTRIM_CONNECT_GITHUB_AUTH: "1" }, run })).toBe("1.2.3");
    expect(run).toHaveBeenCalledWith("gh", ["release", "view", "--repo", "ola-krutrim/krutrimconnect", "--json", "tagName", "--jq", ".tagName"], expect.objectContaining({ KRUTRIM_CONNECT_GITHUB_AUTH: "1" }));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("compares stable and testing release versions without allowing a downgrade", () => {
    expect(compareReleaseVersions("0.1.5", "0.1.4")).toBe(1);
    expect(compareReleaseVersions("0.1.5-next.2", "0.1.5-next.1")).toBe(1);
    expect(compareReleaseVersions("0.1.5", "0.1.5-next.9")).toBe(1);
    expect(compareReleaseVersions("0.1.5-next.1", "0.1.5")).toBe(-1);
    expect(compareReleaseVersions("1.0.0", "1.0.0")).toBe(0);
    expect(() => compareReleaseVersions("latest", "1.0.0")).toThrow(/X\.Y\.Z/u);
  });

  it("binds known package identities to fixed registries and tags", () => {
    expect(resolveUpgradeTarget("krutrimconnect")).toEqual({
      channel: "public",
      packageName: "krutrimconnect",
      registry: PUBLIC_NPM_REGISTRY,
      tag: "latest",
    });
    expect(resolveUpgradeTarget("@ola-silicon/krutrimconnect")).toEqual({
      channel: "testing",
      packageName: "@ola-silicon/krutrimconnect",
      registry: TESTING_NPM_REGISTRY,
      tag: "internal",
    });
    expect(() => resolveUpgradeTarget("@attacker/krutrimconnect")).toThrow(
      /unsupported package identity/u,
    );
  });

  it("constructs fixed npm view and exact-version install arguments", () => {
    const target = resolveUpgradeTarget("krutrimconnect");
    expect(npmViewArguments(target)).toEqual([
      "view",
      "--registry",
      PUBLIC_NPM_REGISTRY,
      "krutrimconnect@latest",
      "version",
    ]);
    expect(npmInstallArguments(target, "0.1.5")).toEqual([
      "install",
      "--global",
      "--no-audit",
      "--no-fund",
      "--registry",
      PUBLIC_NPM_REGISTRY,
      "--",
      "krutrimconnect@0.1.5",
    ]);
    expect(npmListArguments(target)).toEqual([
      "list",
      "--global",
      "--depth=0",
      "--json",
      "krutrimconnect",
    ]);
    expect(npmInstallArguments(resolveUpgradeTarget("@ola-silicon/krutrimconnect"), "0.1.5")).toEqual([
      "install",
      "--global",
      "--no-audit",
      "--no-fund",
      "--",
      "@ola-silicon/krutrimconnect@0.1.5",
    ]);
    expect(() => npmInstallArguments(target, "https://example.invalid/package.tgz")).toThrow(
      /X\.Y\.Z/u,
    );
  });

  it("verifies the exact installed version from bounded npm metadata", () => {
    const target = resolveUpgradeTarget("krutrimconnect");
    expect(installedVersionFromNpmList(JSON.stringify({
      dependencies: {
        krutrimconnect: { version: "0.1.5" },
      },
    }), target)).toBe("0.1.5");
    expect(() => installedVersionFromNpmList("not-json", target)).toThrow(
      /invalid installed-package metadata/u,
    );
    expect(() => installedVersionFromNpmList(JSON.stringify({ dependencies: {} }), target)).toThrow(
      /did not report/u,
    );
  });

  it("reports an installed public release as current without reinstalling", async () => {
    const fake = executorWith("0.1.4");
    const result = await upgradeKrutrimConnect({
      metadata: { name: "krutrimconnect", version: "0.1.4" },
      executor: fake.executor,
    });
    expect(result).toMatchObject({
      status: "current",
      currentVersion: "0.1.4",
      availableVersion: "0.1.4",
      target: { channel: "public", tag: "latest" },
    });
    expect(fake.install).not.toHaveBeenCalled();
  });

  it("checks for an available release without modifying the installation", async () => {
    const fake = executorWith("0.1.5");
    const result = await upgradeKrutrimConnect({
      checkOnly: true,
      metadata: { name: "krutrimconnect", version: "0.1.4" },
      executor: fake.executor,
    });
    expect(result.status).toBe("available");
    expect(fake.install).not.toHaveBeenCalled();
  });

  it("installs the exact newer release from the existing channel", async () => {
    const fake = executorWith("0.1.5-next.3");
    const onInstalling = vi.fn();
    const result = await upgradeKrutrimConnect({
      metadata: {
        name: "@ola-silicon/krutrimconnect",
        version: "0.1.5-next.2",
      },
      executor: fake.executor,
      onInstalling,
    });
    expect(result.status).toBe("upgraded");
    expect(onInstalling).toHaveBeenCalledWith(
      "0.1.5-next.2",
      "0.1.5-next.3",
      expect.objectContaining({
        channel: "testing",
        registry: TESTING_NPM_REGISTRY,
        tag: "internal",
      }),
    );
    expect(fake.install).toHaveBeenCalledWith(
      expect.objectContaining({ packageName: "@ola-silicon/krutrimconnect" }),
      "0.1.5-next.3",
    );
  });

  it("keeps an installed version that is newer than its channel tag", async () => {
    const fake = executorWith("0.1.4");
    const result = await upgradeKrutrimConnect({
      metadata: { name: "krutrimconnect", version: "0.1.5" },
      executor: fake.executor,
    });
    expect(result.status).toBe("newer");
    expect(fake.install).not.toHaveBeenCalled();
  });

  it("uses shell-free npm execution and a bounded Windows command processor invocation", () => {
    expect(npmInvocation(["view", "krutrimconnect@latest"], "darwin")).toEqual({
      command: "npm",
      args: ["view", "krutrimconnect@latest"],
    });
    expect(
      npmInvocation(
        ["view", "--registry", PUBLIC_NPM_REGISTRY, "krutrimconnect@latest", "version"],
        "win32",
        "C:\\Windows\\System32\\cmd.exe",
      ),
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "npm.cmd view --registry https://registry.npmjs.org/ krutrimconnect@latest version",
      ],
    });
    expect(() => npmInvocation(["view", "bad&argument"], "win32")).toThrow(
      /unsafe argument/u,
    );
  });
});
