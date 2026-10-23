import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, readlinkSync, existsSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packRelease } from "./build-release.mjs";
import { releaseIdentity } from "./release-artifact-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const version = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version;
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--assets" || !path.isAbsolute(args[1]))) {
  throw new Error("Usage: node scripts/verify-release.mjs [--assets ABSOLUTE_DIRECTORY]");
}
const assets = args[1] ?? path.join(repositoryRoot, "release");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "krutrimconnect-verify-release-")));
const installDir = path.join(root, "install");
const binDir = path.join(root, "bin");
const home = path.join(root, "home");
mkdirSync(home);
const env = {
  PATH: "/usr/bin:/bin", HOME: home, CI: "1", NO_COLOR: "1", TERM: "dumb",
  KRUTRIM_CONNECT_HOME: path.join(root, "app"),
  KRUTRIM_CONNECT_INSTALL_DIR: installDir, KRUTRIM_CONNECT_BIN_DIR: binDir,
  KRUTRIM_CONNECT_VERSION: version, KRUTRIM_CONNECT_ASSET_DIR: assets,
};
const run = (command, commandArgs, extra = {}) => execFileSync(command, commandArgs, {
  cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 120_000,
  maxBuffer: 4 * 1024 * 1024,
});

try {
  const installed = run("/bin/sh", [path.join(repositoryRoot, "install.sh")]);
  assert.ok(installed.includes(`v${version}`));
  const cli = path.join(binDir, "krutrimconnect");
  assert.equal(run(cli, ["--version"]).trim(), version);
  assert.ok(run(cli, ["--help"]).includes("upgrade"));
  assert.ok(run(cli, ["models", "list", "--offline"]).includes("gpt-oss-20b"));
  const packageDir = realpathSync(path.join(installDir, "current"));
  const node = path.join(packageDir, "bin/node");
  run(node, ["--input-type=module", "-e", `
    const root = ${JSON.stringify(packageDir)};
    const { createRequire } = await import('node:module');
    const require = createRequire(root + '/package.json');
    require('@napi-rs/keyring');
    await import('file://' + root + '/dist/fs/native-lock.js');
  `]);
  const marker = JSON.parse(readFileSync(path.join(installDir, "install.json"), "utf8"));
  assert.equal(marker.installDir, installDir);
  assert.equal(marker.binDir, binDir);

  // Create a test-only next-version archive from the real payload. No repo version
  // changes or publication: only the remote discovery response is injected.
  const next = version.includes("-next.")
    ? version.replace(/-next\.\d+$/u, "")
    : version.replace(/\.(\d+)$/u, (_, n) => `.${Number(n) + 1}`);
  const fixture = path.join(root, "next-fixture");
  cpSync(packageDir, fixture, { recursive: true });
  rmSync(path.join(fixture, ".archive-sha256"));
  for (const file of ["package.json", "release.json"]) {
    const value = JSON.parse(readFileSync(path.join(fixture, file), "utf8"));
    writeFileSync(path.join(fixture, file), JSON.stringify({ ...value, version: next }) + "\n");
  }
  const fixtureAssets = path.join(root, "fixture-assets");
  const metadata = JSON.parse(readFileSync(path.join(fixture, "release.json"), "utf8"));
  const identity = releaseIdentity(next, { platform: metadata.platform, arch: metadata.arch, nodeVersion: metadata.nodeVersion, glibcVersion: metadata.libc === "musl" ? undefined : "fixture", libc: metadata.libc });
  packRelease(fixture, fixtureAssets, identity);
  run(node, ["--input-type=module", "-e", `
    const { pathToFileURL } = await import('node:url');
    const api = await import(pathToFileURL(${JSON.stringify(path.join(packageDir, "dist/upgrade.js"))}));
    const result = await api.upgradeKrutrimConnect({
      releaseExecutor: { viewVersion: async () => ${JSON.stringify(next)}, install: api.systemReleaseExecutor.install },
    });
    if (result.status !== 'upgraded') throw Error('Upgrade was not performed');
  `], { KRUTRIM_CONNECT_ASSET_DIR: fixtureAssets });
  assert.equal(readlinkSync(path.join(installDir, "current")), `releases/${next}`);
  assert.equal(run(cli, ["--version"]).trim(), next);
  assert.equal(run(path.join(packageDir, "bin/krutrimconnect"), ["--version"]).trim(), version);

  // Exercise real package removal with injected disconnected harness/credential
  // backends. Never call the user's OS keychain, even with an isolated HOME.
  const active = realpathSync(path.join(installDir, "current"));
  writeFileSync(path.join(binDir, "keep-unrelated"), "keep");
  run(path.join(active, "bin/node"), ["--input-type=module", "-e", `
    const { pathToFileURL } = await import('node:url');
    const base = ${JSON.stringify(active)};
    const { readInstalledPackageMetadata } = await import(pathToFileURL(base + '/dist/upgrade.js'));
    const { uninstallKrutrimConnect, removeGlobalPackageWithNpm } = await import(pathToFileURL(base + '/dist/uninstall.js'));
    const order = [];
    const harness = name => ({status: async () => ({state:'disconnected'}), disable: async () => {
      order.push(name); return {changed:false,configPath:'fixture'};
    }});
    const result = await uninstallKrutrimConnect({
      metadata: await readInstalledPackageMetadata(), codex:harness('codex'), opencode:harness('opencode'),
      stopBridges: async () => {order.push('bridges');return false;},
      removeCredential: async () => {order.push('credentials');return {changed:false,removedBackends:[],missingBackends:[],removedBackendRecord:false};},
      removeGlobalPackage: async target => {order.push('package');await removeGlobalPackageWithNpm(target);},
    });
    if (!result.packageRemoved || order.join(',') !== 'codex,opencode,bridges,credentials,package') throw Error('Incorrect release teardown');
  `]);
  assert.equal(existsSync(cli), false);
  assert.equal(existsSync(installDir), false);
  assert.equal(readFileSync(path.join(binDir, "keep-unrelated"), "utf8"), "keep");
  console.log(`Verified release ${version} on ${process.platform}/${process.arch}: install, version/help, offline catalogue, native modules, real installer upgrade (test-only ${next}), retained old runtime, and owned uninstall. No system Node/npm on PATH; no live credentials or inference used.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
