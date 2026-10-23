import {
  npmInvocation,
  readInstalledPackageMetadata,
  resolveInstalledUpgradeTarget,
  type InstalledPackageMetadata,
  type UpgradeTarget,
} from "./upgrade.js";
import { ConfigurationError } from "./errors.js";
import { spawn } from "node:child_process";
import { removeReleaseInstall } from "./release-install.js";

export interface UninstallHarness {
  status(): Promise<{ state: string }>;
  disable(options?: { force?: boolean }): Promise<{ changed: boolean; configPath: string }>;
}

export interface UninstallCredentialResult {
  changed: boolean;
  removedBackends: readonly string[];
  missingBackends: readonly string[];
  removedBackendRecord: boolean;
}

export interface UninstallDependencies {
  metadata: InstalledPackageMetadata;
  codex: UninstallHarness;
  opencode: UninstallHarness;
  removeCredential: () => Promise<UninstallCredentialResult>;
  stopBridges: () => Promise<boolean>;
  removeGlobalPackage: (target: UpgradeTarget) => Promise<void>;
}

export interface UninstallOptions {
  keepPackage?: boolean;
  force?: boolean;
}

export interface UninstallHarnessResult {
  harness: "codex" | "opencode";
  restored: boolean;
}

export interface UninstallResult {
  status: "uninstalled" | "deactivated";
  target: UpgradeTarget;
  harnesses: readonly UninstallHarnessResult[];
  bridgesStopped: boolean;
  credentialRemoved: boolean;
  removedBackends: readonly string[];
  packageRemoved: boolean;
}

export function npmUninstallArguments(target: UpgradeTarget): string[] {
  if (target.channel === "github-release") throw new ConfigurationError("Release installations do not use npm.");
  return ["uninstall", "--global", "--", target.packageName];
}

export async function removeGlobalPackageWithNpm(target: UpgradeTarget): Promise<void> {
  if (target.channel === "github-release") {
    await removeReleaseInstall(target.release);
    return;
  }
  const invocation = npmInvocation(npmUninstallArguments(target));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", (error) => {
      reject(
        new ConfigurationError(
          "Could not start npm. Install a supported Node.js distribution that includes npm.",
          { cause: error },
        ),
      );
    });
    child.once("close", resolve);
  });
  if (exitCode !== 0) {
    throw new ConfigurationError(
      "npm could not remove the KrutrimConnect package. No sudo retry was attempted.",
    );
  }
}

export async function uninstallKrutrimConnect(
  dependencies: UninstallDependencies,
  options: UninstallOptions = {},
): Promise<UninstallResult> {
  const target = await resolveInstalledUpgradeTarget(dependencies.metadata);

  const harnesses: UninstallHarnessResult[] = [];
  for (const harness of ["codex", "opencode"] as const) {
    const result = await dependencies[harness].disable({ force: options.force === true });
    harnesses.push({ harness, restored: result.changed });
  }

  const bridgesStopped = await dependencies.stopBridges();
  const credential = await dependencies.removeCredential();

  let packageRemoved = false;
  if (options.keepPackage !== true) {
    await dependencies.removeGlobalPackage(target);
    packageRemoved = true;
  }

  return {
    status: packageRemoved ? "uninstalled" : "deactivated",
    target,
    harnesses,
    bridgesStopped,
    credentialRemoved: credential.changed,
    removedBackends: credential.removedBackends,
    packageRemoved,
  };
}

export async function installedUninstallMetadata(): Promise<InstalledPackageMetadata> {
  return await readInstalledPackageMetadata();
}
