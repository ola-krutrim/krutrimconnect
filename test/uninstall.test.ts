import { describe, expect, it, vi } from "vitest";

import {
  npmUninstallArguments,
  uninstallKrutrimConnect,
  type UninstallDependencies,
} from "../src/uninstall.js";
import { resolveUpgradeTarget } from "../src/upgrade.js";

function harness(state: "connected" | "disconnected", changed: boolean) {
  return {
    status: vi.fn(async () => ({ state })),
    disable: vi.fn(async () => ({ changed, configPath: "/tmp/config" })),
  };
}

function dependenciesWith(overrides: Partial<UninstallDependencies> = {}): UninstallDependencies {
  return {
    metadata: { name: "krutrimconnect", version: "0.1.6" },
    codex: harness("connected", true),
    opencode: harness("connected", true),
    removeCredential: vi.fn(async () => ({
      changed: true,
      removedBackends: ["keychain"],
      missingBackends: [],
      removedBackendRecord: true,
    })),
    stopBridges: vi.fn(async () => true),
    removeGlobalPackage: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("KrutrimConnect uninstall", () => {
  it("validates a release context before disabling harnesses or touching credentials", async () => {
    const deps = dependenciesWith({ metadata: {
      name: "krutrimconnect", version: "1.0.0",
      release: { distribution: "github-release", repository: "ola-krutrim/krutrimconnect", installDir: "/", binDir: "/usr/bin", packageDir: "/not-a-managed-release", version: "1.0.0" },
    } });
    await expect(uninstallKrutrimConnect(deps)).rejects.toThrow(/release installation/u);
    expect(deps.codex.disable).not.toHaveBeenCalled();
    expect(deps.stopBridges).not.toHaveBeenCalled();
    expect(deps.removeCredential).not.toHaveBeenCalled();
    expect(deps.removeGlobalPackage).not.toHaveBeenCalled();
  });
  it("constructs a fixed npm global uninstall invocation for the public channel", () => {
    const target = resolveUpgradeTarget("krutrimconnect");
    expect(npmUninstallArguments(target)).toEqual([
      "uninstall",
      "--global",
      "--",
      "krutrimconnect",
    ]);
  });

  it("disconnects both harnesses, removes credentials, then removes the package in order", async () => {
    const order: string[] = [];
    const deps = dependenciesWith({
      codex: {
        status: vi.fn(async () => ({ state: "connected" as const })),
        disable: vi.fn(async () => {
          order.push("codex-off");
          return { changed: true, configPath: "/tmp/codex" };
        }),
      },
      opencode: {
        status: vi.fn(async () => ({ state: "connected" as const })),
        disable: vi.fn(async () => {
          order.push("opencode-off");
          return { changed: true, configPath: "/tmp/opencode" };
        }),
      },
      stopBridges: vi.fn(async () => {
        order.push("bridges");
        return true;
      }),
      removeCredential: vi.fn(async () => {
        order.push("credentials");
        return {
          changed: true,
          removedBackends: ["keychain"],
          missingBackends: [],
          removedBackendRecord: true,
        };
      }),
      removeGlobalPackage: vi.fn(async () => {
        order.push("package");
      }),
    });

    const result = await uninstallKrutrimConnect(deps);

    expect(order).toEqual(["codex-off", "opencode-off", "bridges", "credentials", "package"]);
    expect(result.status).toBe("uninstalled");
    expect(result.harnesses).toEqual([
      { harness: "codex", restored: true },
      { harness: "opencode", restored: true },
    ]);
    expect(result.credentialRemoved).toBe(true);
    expect(result.packageRemoved).toBe(true);
    expect(result.target.packageName).toBe("krutrimconnect");
  });

  it("still removes the package when everything is already disconnected", async () => {
    const deps = dependenciesWith({
      codex: harness("disconnected", false),
      opencode: harness("disconnected", false),
      removeCredential: vi.fn(async () => ({
        changed: false,
        removedBackends: [],
        missingBackends: ["keychain"],
        removedBackendRecord: false,
      })),
    });

    const result = await uninstallKrutrimConnect(deps);

    expect(result.status).toBe("uninstalled");
    expect(result.harnesses).toEqual([
      { harness: "codex", restored: false },
      { harness: "opencode", restored: false },
    ]);
    expect(result.credentialRemoved).toBe(false);
    expect(result.packageRemoved).toBe(true);
  });

  it("skips package removal when keepPackage is set", async () => {
    const removeGlobalPackage = vi.fn(async () => undefined);
    const deps = dependenciesWith({ removeGlobalPackage });

    const result = await uninstallKrutrimConnect(deps, { keepPackage: true });

    expect(removeGlobalPackage).not.toHaveBeenCalled();
    expect(result.packageRemoved).toBe(false);
    expect(result.status).toBe("deactivated");
  });

  it("forwards the force option to both harness restores for logout --disconnect", async () => {
    const codex = harness("connected", true);
    const opencode = harness("connected", true);
    const deps = dependenciesWith({ codex, opencode });

    await uninstallKrutrimConnect(deps, { keepPackage: true, force: true });

    expect(codex.disable).toHaveBeenCalledWith({ force: true });
    expect(opencode.disable).toHaveBeenCalledWith({ force: true });
  });

  it("refuses to uninstall a build with an unsupported package identity", async () => {
    const deps = dependenciesWith({
      metadata: { name: "@attacker/krutrimconnect", version: "0.1.6" },
    });

    await expect(uninstallKrutrimConnect(deps)).rejects.toThrow(
      /unsupported package identity/u,
    );
    expect(deps.codex.disable).not.toHaveBeenCalled();
  });

  it("aborts before touching credentials when a harness restore fails", async () => {
    const removeCredential = vi.fn();
    const deps = dependenciesWith({
      opencode: {
        status: vi.fn(async () => ({ state: "connected" as const })),
        disable: vi.fn(async () => {
          throw new Error("drifted config");
        }),
      },
      removeCredential: removeCredential as unknown as UninstallDependencies["removeCredential"],
    });

    await expect(uninstallKrutrimConnect(deps)).rejects.toThrow(/drifted config/u);
    expect(removeCredential).not.toHaveBeenCalled();
  });
});
