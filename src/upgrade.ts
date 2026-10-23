import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigurationError } from "./errors.js";
import { detectReleaseInstall, installRelease, latestReleaseVersion, type ReleaseInstallContext } from "./release-install.js";

export const PUBLIC_PACKAGE_NAME = "krutrimconnect";
export const TESTING_PACKAGE_NAME = "@ola-silicon/krutrimconnect";
export const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";
export const TESTING_NPM_REGISTRY = "https://npm.pkg.github.com/";

const MAX_NPM_OUTPUT_BYTES = 256 * 1024;
const RELEASE_VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/u;
const SAFE_WINDOWS_NPM_ARGUMENT = /^[A-Za-z0-9_@+=:,./\\-]+$/u;

export interface InstalledPackageMetadata {
  name: string;
  version: string;
  release?: ReleaseInstallContext;
}

export interface NpmUpgradeTarget {
  channel: "public" | "testing";
  packageName: string;
  registry: string;
  tag: "latest" | "internal";
}

export interface ReleaseUpgradeTarget {
  channel: "github-release";
  packageName: "krutrimconnect";
  release: ReleaseInstallContext;
}

export type UpgradeTarget = NpmUpgradeTarget | ReleaseUpgradeTarget;

export interface UpgradeNpmExecutor {
  viewVersion(target: UpgradeTarget): Promise<string>;
  install(target: UpgradeTarget, version: string): Promise<void>;
}

export interface UpgradeOptions {
  checkOnly?: boolean;
  metadata?: InstalledPackageMetadata;
  executor?: UpgradeNpmExecutor;
  releaseExecutor?: UpgradeNpmExecutor;
  onInstalling?: (
    currentVersion: string,
    availableVersion: string,
    target: UpgradeTarget,
  ) => void;
}

export interface UpgradeResult {
  status: "current" | "available" | "upgraded" | "newer";
  currentVersion: string;
  availableVersion: string;
  target: UpgradeTarget;
}

interface ParsedReleaseVersion {
  major: number;
  minor: number;
  patch: number;
  next: number | undefined;
}

interface NpmInvocation {
  command: string;
  args: string[];
}

interface ProcessResult {
  exitCode: number | null;
  stdout: string;
}

function parseReleaseVersion(version: string): ParsedReleaseVersion {
  const match = RELEASE_VERSION_PATTERN.exec(version);
  if (match === null) {
    throw new ConfigurationError(
      "KrutrimConnect upgrades require an X.Y.Z or X.Y.Z-next.N package version.",
    );
  }
  const values = match.slice(1, 4).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) {
    throw new ConfigurationError("KrutrimConnect package version numbers are unsafe.");
  }
  const [major, minor, patch] = values;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new ConfigurationError("KrutrimConnect package version is incomplete.");
  }
  const next = match[4] === undefined ? undefined : Number(match[4]);
  if (next !== undefined && !Number.isSafeInteger(next)) {
    throw new ConfigurationError("KrutrimConnect prerelease number is unsafe.");
  }
  return { major, minor, patch, next };
}

export function compareReleaseVersions(left: string, right: string): number {
  const a = parseReleaseVersion(left);
  const b = parseReleaseVersion(right);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) {
      return a[key] < b[key] ? -1 : 1;
    }
  }
  if (a.next === b.next) {
    return 0;
  }
  if (a.next === undefined) {
    return 1;
  }
  if (b.next === undefined) {
    return -1;
  }
  return a.next < b.next ? -1 : 1;
}

export function resolveUpgradeTarget(packageName: string): NpmUpgradeTarget {
  if (packageName === PUBLIC_PACKAGE_NAME) {
    return {
      channel: "public",
      packageName: PUBLIC_PACKAGE_NAME,
      registry: PUBLIC_NPM_REGISTRY,
      tag: "latest",
    };
  }
  if (packageName === TESTING_PACKAGE_NAME) {
    return {
      channel: "testing",
      packageName: TESTING_PACKAGE_NAME,
      registry: TESTING_NPM_REGISTRY,
      tag: "internal",
    };
  }
  throw new ConfigurationError(
    "This KrutrimConnect build has an unsupported package identity and cannot self-upgrade safely.",
  );
}

export function npmViewArguments(target: UpgradeTarget): string[] {
  if (target.channel === "github-release") throw new ConfigurationError("Release installations do not use npm.");
  return [
    "view",
    "--registry",
    target.registry,
    target.packageName + "@" + target.tag,
    "version",
  ];
}

export function npmInstallArguments(target: UpgradeTarget, version: string): string[] {
  if (target.channel === "github-release") throw new ConfigurationError("Release installations do not use npm.");
  parseReleaseVersion(version);
  const args = [
    "install",
    "--global",
    "--no-audit",
    "--no-fund",
  ];
  if (target.channel === "public") {
    args.push("--registry", target.registry);
  }
  args.push("--", target.packageName + "@" + version);
  return args;
}

export function npmListArguments(target: UpgradeTarget): string[] {
  if (target.channel === "github-release") throw new ConfigurationError("Release installations do not use npm.");
  return ["list", "--global", "--depth=0", "--json", target.packageName];
}

export function installedVersionFromNpmList(
  source: string,
  target: UpgradeTarget,
): string {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ConfigurationError("npm returned invalid installed-package metadata.", {
      cause: error,
    });
  }
  const dependencies = value !== null && typeof value === "object"
    ? (value as { dependencies?: unknown }).dependencies
    : undefined;
  const installed = dependencies !== null && typeof dependencies === "object"
    ? (dependencies as Record<string, unknown>)[target.packageName]
    : undefined;
  const version = installed !== null && typeof installed === "object"
    ? (installed as { version?: unknown }).version
    : undefined;
  if (typeof version !== "string") {
    throw new ConfigurationError("npm did not report the upgraded KrutrimConnect package.");
  }
  parseReleaseVersion(version);
  return version;
}

export function npmInvocation(
  args: string[],
  platform: NodeJS.Platform = process.platform,
  commandProcessor = process.env.ComSpec,
): NpmInvocation {
  if (platform !== "win32") {
    return { command: "npm", args };
  }
  for (const argument of args) {
    if (!SAFE_WINDOWS_NPM_ARGUMENT.test(argument)) {
      throw new ConfigurationError("Refusing to pass an unsafe argument to npm on Windows.");
    }
  }
  return {
    command: commandProcessor?.trim() || "cmd.exe",
    args: ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")],
  };
}

async function runNpmProcess(
  args: string[],
  output: "capture" | "inherit",
): Promise<ProcessResult> {
  const invocation = npmInvocation(args);
  return await new Promise((resolve, reject) => {
    const captured: Buffer[] = [];
    let capturedBytes = 0;
    let outputExceeded = false;
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      env: {
        ...process.env,
        npm_config_loglevel: output === "capture"
          ? "silent"
          : process.env.npm_config_loglevel ?? "notice",
      },
      shell: false,
      stdio: output === "capture"
        ? ["ignore", "pipe", "ignore"]
        : ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (capturedBytes <= MAX_NPM_OUTPUT_BYTES) {
        captured.push(chunk);
      } else {
        outputExceeded = true;
        child.kill();
      }
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new ConfigurationError(
        "Could not start npm. Install a supported Node.js distribution that includes npm.",
        { cause: error },
      ));
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      if (outputExceeded) {
        reject(new ConfigurationError("npm produced unexpectedly large output during the upgrade check."));
        return;
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(captured).toString("utf8"),
      });
    });
  });
}

export const systemNpmExecutor: UpgradeNpmExecutor = {
  async viewVersion(target) {
    const result = await runNpmProcess(npmViewArguments(target), "capture");
    if (result.exitCode !== 0) {
      throw new ConfigurationError(
        "Could not check for KrutrimConnect updates. Confirm this installation can access its package registry.",
      );
    }
    const version = result.stdout.trim();
    parseReleaseVersion(version);
    return version;
  },

  async install(target, version) {
    const result = await runNpmProcess(npmInstallArguments(target, version), "inherit");
    if (result.exitCode !== 0) {
      throw new ConfigurationError(
        "npm could not upgrade KrutrimConnect. No sudo retry was attempted.",
      );
    }
    const verification = await runNpmProcess(npmListArguments(target), "capture");
    if (verification.exitCode !== 0) {
      throw new ConfigurationError("npm completed but the upgraded package could not be verified.");
    }
    const installedVersion = installedVersionFromNpmList(verification.stdout, target);
    if (installedVersion !== version) {
      throw new ConfigurationError(
        "Installed KrutrimConnect version mismatch: expected " + version +
          ", found " + installedVersion + ".",
      );
    }
  },
};

export const systemReleaseExecutor: UpgradeNpmExecutor = {
  async viewVersion() { return await latestReleaseVersion(); },
  async install(target, version) {
    if (target.channel !== "github-release") throw new ConfigurationError("Not a release installation.");
    await installRelease(target.release, version);
  },
};

export async function readInstalledPackageMetadata(
  packageUrl = new URL("../package.json", import.meta.url),
): Promise<InstalledPackageMetadata> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(packageUrl, "utf8")) as unknown;
  } catch (error) {
    throw new ConfigurationError("Could not read the installed KrutrimConnect package metadata.", {
      cause: error,
    });
  }
  if (
    value === null ||
    typeof value !== "object" ||
    typeof (value as { name?: unknown }).name !== "string" ||
    typeof (value as { version?: unknown }).version !== "string"
  ) {
    throw new ConfigurationError("Installed KrutrimConnect package metadata is invalid.");
  }
  const metadata = value as { name: string; version: string };
  parseReleaseVersion(metadata.version);
  const release = await detectReleaseInstall(packageUrl);
  return { name: metadata.name, version: metadata.version, ...(release === undefined ? {} : { release }) };
}

export async function resolveInstalledUpgradeTarget(metadata: InstalledPackageMetadata): Promise<UpgradeTarget> {
  const npm = resolveUpgradeTarget(metadata.name);
  if (metadata.release === undefined) return npm;
  const release = await detectReleaseInstall(pathToFileURL(join(metadata.release.packageDir, "package.json")));
  if (release === undefined || metadata.name !== PUBLIC_PACKAGE_NAME || release.version !== metadata.version ||
      Object.keys(release).some((key) => release[key as keyof ReleaseInstallContext] !== metadata.release?.[key as keyof ReleaseInstallContext])) {
    throw new ConfigurationError("Invalid KrutrimConnect release installation context.");
  }
  return { channel: "github-release", packageName: PUBLIC_PACKAGE_NAME, release };
}

export async function upgradeKrutrimConnect(
  options: UpgradeOptions = {},
): Promise<UpgradeResult> {
  const metadata = options.metadata ?? await readInstalledPackageMetadata();
  const target = await resolveInstalledUpgradeTarget(metadata);
  parseReleaseVersion(metadata.version);
  const executor = target.channel === "github-release" ? options.releaseExecutor ?? systemReleaseExecutor : options.executor ?? systemNpmExecutor;
  const availableVersion = await executor.viewVersion(target);
  const comparison = compareReleaseVersions(availableVersion, metadata.version);

  if (comparison === 0) {
    return {
      status: "current",
      currentVersion: metadata.version,
      availableVersion,
      target,
    };
  }
  if (comparison < 0) {
    return {
      status: "newer",
      currentVersion: metadata.version,
      availableVersion,
      target,
    };
  }
  if (options.checkOnly === true) {
    return {
      status: "available",
      currentVersion: metadata.version,
      availableVersion,
      target,
    };
  }

  options.onInstalling?.(metadata.version, availableVersion, target);
  await executor.install(target, availableVersion);
  return {
    status: "upgraded",
    currentVersion: metadata.version,
    availableVersion,
    target,
  };
}
