import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigurationError } from "./errors.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectWindowsRelease, upgradeWindowsRelease, removeWindowsRelease } from "./windows-release.js";

export const RELEASE_REPOSITORY = "ola-krutrim/krutrimconnect";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/u;

export interface ReleaseInstallContext {
  distribution: "github-release";
  repository: typeof RELEASE_REPOSITORY;
  installDir: string;
  binDir: string;
  packageDir: string;
  version: string;
}

type ReleaseProcessRunner = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
const runReleaseProcess: ReleaseProcessRunner = async (command, args, env) => {
  const { stdout } = await promisify(execFile)(command, args, { env, shell: false, timeout: command === "sh" ? 300_000 : 10_000, maxBuffer: 256 * 1024, encoding: "utf8" });
  return stdout;
};

function stableTag(tag: unknown): string {
  if (typeof tag !== "string" || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag)) {
    throw new ConfigurationError("GitHub returned an invalid stable release version.");
  }
  return tag.replace(/^v/u, "");
}

export async function latestReleaseVersion(options: { env?: NodeJS.ProcessEnv; run?: ReleaseProcessRunner } = {}): Promise<string> {
  const env = options.env ?? process.env;
  try {
    if (env.KRUTRIM_CONNECT_GITHUB_AUTH === "1") {
      return stableTag((await (options.run ?? runReleaseProcess)("gh", ["release", "view", "--repo", RELEASE_REPOSITORY, "--json", "tagName", "--jq", ".tagName"], env)).trim());
    }
    const response = await fetch(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`, {
      redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok || response.body === null) throw new Error("Release check failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 256 * 1024) throw new Error("Release metadata is too large");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    if (value.prerelease !== false || value.draft !== false) throw new Error("Not a stable release");
    return stableTag(value.tag_name);
  } catch (error) {
    throw new ConfigurationError("Could not check the latest KrutrimConnect release. Confirm GitHub access; authenticated installations can use KRUTRIM_CONNECT_GITHUB_AUTH=1 with gh.", { cause: error });
  }
}

function unsafe(): never {
  throw new ConfigurationError("Unsafe or invalid KrutrimConnect release installation; refusing to modify it.");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function owned(path: string, kind: "directory" | "file" | "symlink"): Promise<void> {
  const stat = await lstat(path);
  if (process.getuid === undefined || stat.uid !== process.getuid()) unsafe();
  if (kind === "symlink") { if (!stat.isSymbolicLink()) unsafe(); return; }
  if ((stat.mode & 0o022) !== 0 || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) unsafe();
}

async function directory(path: unknown): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path === dirname(path)) unsafe();
  await owned(path, "directory");
  if (await realpath(path) !== path) unsafe();
  return path;
}

async function json(path: string): Promise<Record<string, unknown>> {
  await owned(path, "file");
  if ((await lstat(path)).size > 16 * 1024) unsafe();
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) unsafe();
  return value as Record<string, unknown>;
}

function identity(value: Record<string, unknown>): void {
  if (value.schemaVersion !== 1 || value.distribution !== "github-release" || value.repository !== RELEASE_REPOSITORY) unsafe();
}

async function releaseTree(packageDir: string): Promise<string> {
  await directory(packageDir);
  const release = await json(join(packageDir, "release.json"));
  identity(release);
  if (typeof release.version !== "string" || !VERSION.test(release.version) || basename(packageDir) !== release.version ||
      !["darwin", "linux"].includes(String(release.platform)) || !["arm64", "x64"].includes(String(release.arch)) ||
      typeof release.nodeVersion !== "string" || !VERSION.test(release.nodeVersion)) unsafe();
  const pkg = await json(join(packageDir, "package.json"));
  if (pkg.name !== "krutrimconnect" || pkg.version !== release.version) unsafe();
  for (const dir of ["dist", "node_modules", "schemas", "catalog"]) await directory(join(packageDir, dir));
  await owned(join(packageDir, "dist", "cli.js"), "file");
  await owned(join(packageDir, "install.sh"), "file");
  await directory(join(packageDir, "bin"));
  await owned(join(packageDir, "bin", "node"), "file");
  await owned(join(packageDir, "bin", "krutrimconnect"), "file");
  return release.version;
}

export async function removeReleaseInstall(context: ReleaseInstallContext): Promise<void> {
  if (process.platform === "win32") return removeWindowsRelease(context);
  const validated = await detectReleaseInstall(pathToFileURL(join(context.packageDir, "package.json")));
  if (validated === undefined || Object.keys(validated).some((key) => validated[key as keyof ReleaseInstallContext] !== context[key as keyof ReleaseInstallContext])) unsafe();
  const lock = join(validated.installDir, ".install-lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { throw new ConfigurationError("KrutrimConnect release installation is busy or cannot be locked.", { cause: error }); }
  try {
    const current = await detectReleaseInstall(pathToFileURL(join(context.packageDir, "package.json")));
    if (current === undefined || Object.keys(current).some((key) => current[key as keyof ReleaseInstallContext] !== validated[key as keyof ReleaseInstallContext])) unsafe();
    const releasesDir = join(validated.installDir, "releases");
    const trees = (await readdir(releasesDir)).map((name) => join(releasesDir, name));
    for (const tree of trees) await releaseTree(tree);
    await unlink(join(validated.binDir, "krutrimconnect"));
    await unlink(join(validated.installDir, "current"));
    for (const tree of trees) await rm(tree, { recursive: true });
    await rmdir(releasesDir);
    await unlink(join(validated.installDir, "install.json"));
  } finally { await rmdir(lock); }
  if ((await readdir(validated.installDir)).length === 0) await rmdir(validated.installDir);
}

export async function installRelease(context: ReleaseInstallContext, version: string): Promise<void> {
  if (process.platform === "win32") return upgradeWindowsRelease(context, version);
  stableTag(version);
  const validated = await detectReleaseInstall(pathToFileURL(join(context.packageDir, "package.json")));
  if (validated === undefined || Object.keys(validated).some((key) => validated[key as keyof ReleaseInstallContext] !== context[key as keyof ReleaseInstallContext])) unsafe();
  const { compareReleaseVersions } = await import("./upgrade.js");
  const activeVersion = await releaseTree(await realpath(join(validated.installDir, "current")));
  if (compareReleaseVersions(version, activeVersion) < 0) {
    throw new ConfigurationError("Refusing to downgrade the current KrutrimConnect release installation.");
  }
  const env = { ...process.env, KRUTRIM_CONNECT_VERSION: version, KRUTRIM_CONNECT_INSTALL_DIR: validated.installDir, KRUTRIM_CONNECT_BIN_DIR: validated.binDir };
  try {
    await runReleaseProcess("sh", [join(validated.packageDir, "install.sh")], env);
    const activeDir = await realpath(join(validated.installDir, "current"));
    const installed = await detectReleaseInstall(pathToFileURL(join(activeDir, "package.json")));
    if (installed?.version !== version || installed.installDir !== validated.installDir) throw new Error("Installed release version mismatch");
    const output = await runReleaseProcess(join(validated.installDir, "current", "bin", "krutrimconnect"), ["--version"], env);
    if (output.trim() !== version) throw new Error("Installed executable version mismatch");
  } catch (error) {
    throw new ConfigurationError("Could not upgrade or verify the KrutrimConnect release installation.", { cause: error });
  }
}

export async function detectReleaseInstall(packageUrl: URL): Promise<ReleaseInstallContext | undefined> {
  if (process.platform === "win32") return detectWindowsRelease(packageUrl);
  const packageDir = dirname(fileURLToPath(packageUrl));
  const installDir = dirname(dirname(packageDir));
  try {
    if (!await exists(join(packageDir, "release.json"))) {
      if (basename(dirname(packageDir)) === "releases" || await exists(join(installDir, "install.json"))) unsafe();
      return undefined;
    }
    await directory(installDir);
    await directory(join(installDir, "releases"));
    const marker = await json(join(installDir, "install.json"));
    identity(marker);
    if (marker.installDir !== installDir || dirname(packageDir) !== join(installDir, "releases")) unsafe();
    const binDir = await directory(marker.binDir);
    const version = await releaseTree(packageDir);
    const current = join(installDir, "current");
    await owned(current, "symlink");
    const activeDir = resolve(installDir, await readlink(current));
    if (dirname(activeDir) !== join(installDir, "releases")) unsafe();
    if (activeDir !== packageDir) await releaseTree(activeDir);
    const launcher = join(binDir, "krutrimconnect");
    await owned(launcher, "symlink");
    if (resolve(binDir, await readlink(launcher)) !== join(current, "bin", "krutrimconnect")) unsafe();
    return { distribution: "github-release", repository: RELEASE_REPOSITORY, installDir, binDir, packageDir, version };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("Could not validate the KrutrimConnect release installation.", { cause: error });
  }
}
