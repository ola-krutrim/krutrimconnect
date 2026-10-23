import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, cp, mkdtemp, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readInstalledPackageMetadata, upgradeKrutrimConnect } from "../src/upgrade.js";
import { removeGlobalPackageWithNpm, uninstallKrutrimConnect } from "../src/uninstall.js";
import { installRelease, removeReleaseInstall } from "../src/release-install.js";

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "kc-release-")));
  roots.push(root);
  const installDir = join(root, "custom-install");
  const binDir = join(root, "custom-bin");
  const packageDir = join(installDir, "releases", "1.0.0");
  await mkdir(join(packageDir, "bin"), { recursive: true });
  for (const dir of ["dist", "node_modules", "schemas", "catalog"]) await mkdir(join(packageDir, dir));
  await writeFile(join(packageDir, "dist", "cli.js"), "// fixture CLI\n");
  await mkdir(binDir);
  await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "krutrimconnect", version: "1.0.0" }));
  await writeFile(join(packageDir, "release.json"), JSON.stringify({ schemaVersion: 1, distribution: "github-release", repository: "ola-krutrim/krutrimconnect", version: "1.0.0", platform: process.platform, arch: process.arch, nodeVersion: "22.14.0" }));
  await writeFile(join(packageDir, "install.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(packageDir, "bin", "node"), "runtime");
  await writeFile(join(packageDir, "bin", "krutrimconnect"), "#!/bin/sh\nprintf '1.0.0\\n'\n", { mode: 0o755 });
  await writeFile(join(installDir, "install.json"), JSON.stringify({ schemaVersion: 1, distribution: "github-release", repository: "ola-krutrim/krutrimconnect", installDir, binDir }));
  await symlink("releases/1.0.0", join(installDir, "current"));
  await symlink(join(installDir, "current", "bin", "krutrimconnect"), join(binDir, "krutrimconnect"));
  return { root, installDir, binDir, packageDir, packageUrl: pathToFileURL(join(packageDir, "package.json")) };
}
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe.runIf(process.platform === "darwin" || process.platform === "linux")("GitHub release installation", () => {
  it("refuses package removal while the installer owns the installation lock", async () => {
    const f = await fixture();
    const metadata = await readInstalledPackageMetadata(f.packageUrl);
    await mkdir(join(f.installDir, ".install-lock"));
    await writeFile(join(f.installDir, ".install-lock", "owner"), "installer");
    await expect(removeReleaseInstall(metadata.release!)).rejects.toThrow(/busy/u);
    expect(await readFile(join(f.installDir, ".install-lock", "owner"), "utf8")).toBe("installer");
    expect(await readlink(join(f.installDir, "current"))).toBe("releases/1.0.0");
  });
  it.each(["marker", "launcher", "old tree"])("revalidates %s ownership before any package deletion", async (kind) => {
    const f = await fixture();
    const metadata = await readInstalledPackageMetadata(f.packageUrl);
    if (kind === "marker") await writeFile(join(f.installDir, "install.json"), JSON.stringify({ schemaVersion: 1, distribution: "github-release", repository: "attacker/repo", installDir: f.root, binDir: f.binDir }));
    if (kind === "launcher") {
      await rm(join(f.binDir, "krutrimconnect"));
      await writeFile(join(f.binDir, "krutrimconnect"), "unrelated executable");
    }
    if (kind === "old tree") await symlink(f.root, join(f.installDir, "releases", "0.9.0"));
    await expect(removeReleaseInstall(metadata.release!)).rejects.toThrow(/release installation/u);
    expect(await readFile(join(f.packageDir, "bin", "node"), "utf8")).toBe("runtime");
    expect(await readlink(join(f.installDir, "current"))).toBe("releases/1.0.0");
    if (kind === "launcher") expect(await readFile(join(f.binDir, "krutrimconnect"), "utf8")).toBe("unrelated executable");
  });
  it("verifies the installed executable, not just the release manifest", async () => {
    const f = await fixture();
    await writeFile(join(f.packageDir, "bin", "krutrimconnect"), "#!/bin/sh\ntest \"$1\" = --version || exit 1\nprintf '0.9.0\\n'\n");
    const metadata = await readInstalledPackageMetadata(f.packageUrl);
    await expect(installRelease(metadata.release!, "1.0.0")).rejects.toThrow(/verify/u);
  });
  it("keeps files outside managed trees when dependencies contain symlinks", async () => {
    const f = await fixture();
    const external = join(f.root, "credentials");
    await writeFile(external, "keep");
    await symlink(external, join(f.packageDir, "dependency-link"));
    const metadata = await readInstalledPackageMetadata(f.packageUrl);
    await removeReleaseInstall(metadata.release!);
    expect(await readFile(external, "utf8")).toBe("keep");
  });
  it("refuses a downgrade when an older running process sees a newer current release", async () => {
    const f = await fixture();
    const newer = join(f.installDir, "releases", "2.0.0");
    await cp(f.packageDir, newer, { recursive: true });
    for (const file of ["package.json", "release.json"]) {
      const value = JSON.parse(await readFile(join(newer, file), "utf8"));
      await writeFile(join(newer, file), JSON.stringify({ ...value, version: "2.0.0" }));
    }
    await rm(join(f.installDir, "current"));
    await symlink("releases/2.0.0", join(f.installDir, "current"));
    await writeFile(join(f.packageDir, "install.sh"), `#!/bin/sh\ntouch '${f.root}/ran-installer'\n`);
    const metadata = await readInstalledPackageMetadata(f.packageUrl);
    await expect(installRelease(metadata.release!, "1.1.0")).rejects.toThrow(/downgrade/u);
    await expect(readFile(join(f.root, "ran-installer"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("removes only managed release files after harnesses, bridges, and credentials, without npm", async () => {
    const f = await fixture();
    const older = join(f.installDir, "releases", "0.9.0");
    await cp(f.packageDir, older, { recursive: true });
    for (const file of ["package.json", "release.json"]) {
      const value = JSON.parse(await readFile(join(older, file), "utf8"));
      await writeFile(join(older, file), JSON.stringify({ ...value, version: "0.9.0" }));
    }
    await writeFile(join(f.installDir, "user-config"), "keep");
    await writeFile(join(f.binDir, "other-command"), "keep");
    const order: string[] = [];
    const harness = (name: string) => ({ status: async () => ({ state: "connected" }), disable: async () => { order.push(name); return { changed: true, configPath: name }; } });
    const result = await uninstallKrutrimConnect({
      metadata: await readInstalledPackageMetadata(f.packageUrl), codex: harness("codex"), opencode: harness("opencode"),
      stopBridges: async () => { order.push("bridges"); return true; },
      removeCredential: async () => { order.push("credentials"); return { changed: true, removedBackends: [], missingBackends: [], removedBackendRecord: true }; },
      removeGlobalPackage: async (target) => { order.push("package"); expect(target.channel).toBe("github-release"); await removeGlobalPackageWithNpm(target); },
    });
    expect(order).toEqual(["codex", "opencode", "bridges", "credentials", "package"]);
    expect(result.packageRemoved).toBe(true);
    for (const path of [f.packageDir, older, join(f.installDir, "install.json"), join(f.installDir, "current"), join(f.binDir, "krutrimconnect")]) {
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(await readFile(join(f.installDir, "user-config"), "utf8")).toBe("keep");
    expect(await readFile(join(f.binDir, "other-command"), "utf8")).toBe("keep");
  });
  it("runs the pinned local installer with exact roots and verifies current without npm, retaining old trees", async () => {
    const f = await fixture();
    const assets = join(f.root, "assets");
    await cp(f.packageDir, assets, { recursive: true });
    for (const file of ["release.json", "package.json"]) {
      const value = JSON.parse(await readFile(join(assets, file), "utf8"));
      await writeFile(join(assets, file), JSON.stringify({ ...value, version: "1.1.0" }));
    }
    await writeFile(join(assets, "bin", "krutrimconnect"), "#!/bin/sh\nprintf '1.1.0\\n'\n", { mode: 0o755 });
    await writeFile(join(f.packageDir, "install.sh"), `#!/bin/sh
set -eu
test "$KRUTRIM_CONNECT_VERSION" = 1.1.0
test "$KRUTRIM_CONNECT_GITHUB_AUTH" = 0
test -L "$KRUTRIM_CONNECT_BIN_DIR/krutrimconnect"
cp -R "$KRUTRIM_CONNECT_ASSET_DIR" "$KRUTRIM_CONNECT_INSTALL_DIR/releases/$KRUTRIM_CONNECT_VERSION"
ln -s "releases/$KRUTRIM_CONNECT_VERSION" "$KRUTRIM_CONNECT_INSTALL_DIR/next"
rm "$KRUTRIM_CONNECT_INSTALL_DIR/current"
mv -f "$KRUTRIM_CONNECT_INSTALL_DIR/next" "$KRUTRIM_CONNECT_INSTALL_DIR/current"
`);
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("KRUTRIM_CONNECT_GITHUB_AUTH", "0");
    vi.stubEnv("KRUTRIM_CONNECT_INSTALL_DIR", "/wrong-root");
    vi.stubEnv("KRUTRIM_CONNECT_BIN_DIR", "/wrong-bin");
    vi.stubEnv("KRUTRIM_CONNECT_VERSION", "9.0.0");
    vi.stubEnv("KRUTRIM_CONNECT_ASSET_DIR", assets);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tag_name: "v1.1.0", prerelease: false, draft: false }))));
    const result = await upgradeKrutrimConnect({ metadata: await readInstalledPackageMetadata(f.packageUrl) });
    expect(result.status).toBe("upgraded");
    expect(await readlink(join(f.installDir, "current"))).toBe("releases/1.1.0");
    expect(await readFile(join(f.packageDir, "bin", "node"), "utf8")).toBe("runtime");
  });
  it.each([
    ["1.0.0", false, "current"], ["1.1.0", true, "available"],
    ["0.9.0", false, "newer"], ["1.1.0", false, "upgraded"],
  ] as const)("routes release %s (check %s) without npm", async (available, checkOnly, status) => {
    const f = await fixture();
    const npm = { viewVersion: vi.fn(async () => "9.0.0"), install: vi.fn() };
    const releaseExecutor = { viewVersion: vi.fn(async () => available), install: vi.fn() };
    const result = await upgradeKrutrimConnect({ metadata: await readInstalledPackageMetadata(f.packageUrl), checkOnly, executor: npm, releaseExecutor });
    expect(result.status).toBe(status);
    expect(result.target).toMatchObject({ channel: "github-release", release: { installDir: f.installDir } });
    expect(npm.viewVersion).not.toHaveBeenCalled();
    expect(npm.install).not.toHaveBeenCalled();
    expect(releaseExecutor.install).toHaveBeenCalledTimes(status === "upgraded" ? 1 : 0);
  });
  it.each(["malformed marker", "unknown repo", "wrong root", "wrong version", "missing release", "symlink root", "other launcher", "unsafe installer", "missing dist", "escaping dist"])("refuses %s rather than falling back to npm", async (kind) => {
    const f = await fixture();
    const markerPath = join(f.installDir, "install.json");
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (kind === "malformed marker") await writeFile(markerPath, "{");
    if (kind === "unknown repo") {
      const release = JSON.parse(await readFile(join(f.packageDir, "release.json"), "utf8"));
      await writeFile(join(f.packageDir, "release.json"), JSON.stringify({ ...release, repository: "attacker/repo" }));
    }
    if (kind === "missing dist" || kind === "escaping dist") {
      await rm(join(f.packageDir, "dist"), { recursive: true });
      if (kind === "escaping dist") await symlink(f.root, join(f.packageDir, "dist"));
    }
    if (kind === "wrong root") await writeFile(markerPath, JSON.stringify({ ...marker, installDir: f.root }));
    if (kind === "wrong version") await writeFile(join(f.packageDir, "package.json"), JSON.stringify({ name: "krutrimconnect", version: "9.0.0" }));
    if (kind === "missing release") await rm(join(f.packageDir, "release.json"));
    if (kind === "symlink root") {
      await rename(f.installDir, f.installDir + "-real");
      await symlink(f.installDir + "-real", f.installDir);
    }
    if (kind === "other launcher") {
      await rm(join(f.binDir, "krutrimconnect"));
      await writeFile(join(f.binDir, "krutrimconnect"), "unrelated executable");
    }
    if (kind === "unsafe installer") await chmod(join(f.packageDir, "install.sh"), 0o777);
    await expect(readInstalledPackageMetadata(f.packageUrl)).rejects.toThrow(/release installation/u);
  });
  it("detects a managed release at a non-default root from the installed package path", async () => {
    const f = await fixture();
    expect(await readInstalledPackageMetadata(f.packageUrl)).toMatchObject({
      name: "krutrimconnect", version: "1.0.0",
      release: { distribution: "github-release", repository: "ola-krutrim/krutrimconnect", installDir: f.installDir, binDir: f.binDir, packageDir: f.packageDir, version: "1.0.0" },
    });
  });
});
