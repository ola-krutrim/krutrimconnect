import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectReleaseInstall } from "../src/release-install.js";

const installer = fileURLToPath(new URL("../install.sh", import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function snapshot(root: string): Promise<unknown[]> {
  const info = await lstat(root);
  const state: unknown[] = [root, info.ino, info.uid, info.mode];
  if (info.isSymbolicLink()) state.push(await readlink(root));
  else if (info.isDirectory()) {
    for (const name of (await readdir(root)).sort()) state.push(await snapshot(path.join(root, name)));
  } else state.push(await readFile(root));
  return state;
}

async function fixture(version = "0.1.0") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "krutrim-release-install-")));
  roots.push(root);
  const assets = path.join(root, "assets");
  const stage = path.join(root, "stage");
  const bin = path.join(root, "bin");
  const install = path.join(root, "install");
  const home = path.join(root, "home");
  for (const dir of [assets, bin, home, ...["bin", "dist", "node_modules", "schemas", "catalog"].map((name) => path.join(stage, name))]) await mkdir(dir, { recursive: true });
  // Lightweight test runtime delegates to the real Node; actual artifact smoke tests use a copied runtime.
  await writeFile(path.join(stage, "bin/node"), `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, { mode: 0o755 });
  await writeFile(path.join(stage, "bin/krutrimconnect"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  await writeFile(path.join(stage, "dist/cli.js"), "// fixture CLI\n");
  await writeFile(path.join(stage, "package.json"), JSON.stringify({ name: "krutrimconnect", version }));
  await writeFile(path.join(stage, "release.json"), JSON.stringify({ schemaVersion: 1, distribution: "github-release", repository: "ola-krutrim/krutrimconnect", version, platform: process.platform, arch: process.arch, nodeVersion: process.versions.node }));
  await writeFile(path.join(stage, "install.sh"), await readFile(installer));
  const musl = process.platform === "linux" && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime;
  const name = `krutrimconnect-${version}-${process.platform}-${process.arch}${musl ? "-musl" : ""}.tar.gz`;
  const archive = path.join(assets, name);
  async function pack() {
    const tar = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { encoding: "utf8" });
    expect(tar.status, tar.stderr).toBe(0);
    await writeFile(`${archive}.sha256`, `${createHash("sha256").update(await readFile(archive)).digest("hex")}  ${name}\n`);
  }
  await pack();
  const env = { PATH: "/usr/bin:/bin", HOME: home, CI: "1", TERM: "dumb", KRUTRIM_CONNECT_VERSION: version, KRUTRIM_CONNECT_ASSET_DIR: assets, KRUTRIM_CONNECT_INSTALL_DIR: install, KRUTRIM_CONNECT_BIN_DIR: bin };
  function run(extra: NodeJS.ProcessEnv = {}, mask?: string) {
    const args = mask === undefined ? [installer] : ["-c", 'umask "$1"; exec /bin/sh "$2"', "installer-test", mask, installer];
    return spawnSync("/bin/sh", args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 15_000 });
  }
  return { root, stage, assets, archive, bin, install, home, env, run, pack };
}

describe.runIf(process.platform === "darwin" || process.platform === "linux")("GitHub release installer", () => {
  it("creates lifecycle-compatible managed directories under umask 0002", async () => {
    const f = await fixture();
    await rm(f.bin, { recursive: true });
    const result = f.run({}, "0002");
    expect(result.status, result.stderr).toBe(0);
    const packageDir = path.join(f.install, "releases/0.1.0");
    for (const name of [f.install, f.bin, path.join(f.install, "releases"), packageDir, path.join(f.install, "install.json"), ...["dist", "node_modules", "schemas", "catalog", "bin"].map((name) => path.join(packageDir, name))]) {
      const info = await lstat(name);
      expect(info.uid, name).toBe(process.getuid!());
      expect(info.mode & 0o022, name).toBe(0);
    }
    await expect(detectReleaseInstall(pathToFileURL(path.join(packageDir, "package.json")))).resolves.toMatchObject({
      installDir: f.install, binDir: f.bin, version: "0.1.0",
    });
  });

  it.each(["install", "bin"] as const)("refuses an unsafe existing %s directory on first install without changing it", async (target) => {
    const f = await fixture();
    await mkdir(f.install, { mode: 0o700 });
    await writeFile(path.join(f.bin, "other-tool"), "keep this tool\n");
    await chmod(f[target], 0o775);
    const before = [await snapshot(f.install), await snapshot(f.bin)];
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsafe");
    expect(result.stdout).not.toContain("Installed successfully");
    expect([await snapshot(f.install), await snapshot(f.bin)]).toEqual(before);
  });

  it.each([
    ["install", 0o775], ["bin", 0o775], ["releases", 0o775], ["install.json", 0o664],
    ["install", 0o757], ["bin", 0o757], ["releases", 0o757], ["install.json", 0o646],
  ] as const)("refuses writable existing %s (mode %i) without changing the installation", async (target, mode) => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    await writeFile(path.join(f.bin, "other-tool"), "keep this tool\n");
    await chmod(target === "install" ? f.install : target === "bin" ? f.bin : path.join(f.install, target), mode);
    const before = [await snapshot(f.install), await snapshot(f.bin)];
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsafe");
    expect(result.stdout).not.toContain("Installed successfully");
    expect([await snapshot(f.install), await snapshot(f.bin)]).toEqual(before);
  });

  it.each(["install", "bin", "releases", "current", "install.json", "launcher"])("refuses an existing %s owned by another uid without changing it", async (target) => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    const foreignPath = target === "install" ? f.install : target === "bin" ? f.bin : target === "launcher" ? path.join(f.bin, "krutrimconnect") : path.join(f.install, target);
    // Simulate foreign ownership only at lstat: unprivileged tests cannot chown to another uid.
    const preload = path.join(f.root, "foreign-owner.mjs");
    await writeFile(preload, `import fs from 'node:fs';\nconst lstat = fs.lstatSync;\nfs.lstatSync = (name, ...args) => { const info = lstat(name, ...args); if (name === process.env.FOREIGN_OWNER_PATH) info.uid = process.getuid() + 1; return info; };\n`);
    const before = [await snapshot(f.install), await snapshot(f.bin)];
    const result = f.run({ NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, FOREIGN_OWNER_PATH: foreignPath });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Unsafe");
    expect(result.stdout).not.toContain("Installed successfully");
    expect([await snapshot(f.install), await snapshot(f.bin)]).toEqual(before);
  });

  it.each([
    ["writable", "."], ["foreign", "."],
    ["symlink", "bin"], ["symlink", "bin/krutrimconnect"], ["symlink", "bin/node"],
    ["foreign", "bin/node"], ["writable", "bin/krutrimconnect"], ["writable", "dist/cli.js"],
    ["symlink", "release.json"], ["symlink", "package.json"], ["symlink", ".archive-sha256"],
    ["writable", ".archive-sha256"], ["writable", "install.sh"],
    ["missing", "dist"], ["missing", "node_modules"], ["missing", "schemas"], ["missing", "catalog"],
    ["identity", "release.json"], ["identity", "package.json"], ["oversized", "release.json"],
  ])("rejects %s reused release path %s before invoking existing code", async (mutation, target) => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    const release = path.join(f.install, "releases/0.1.0");
    const invoked = path.join(f.root, "existing-invoked");
    await writeFile(path.join(release, "bin/krutrimconnect"), `#!/bin/sh\nprintf invoked > '${invoked}'\nprintf '%s\\n' 0.1.0\n`);
    const targetPath = path.join(release, target);
    const extra: NodeJS.ProcessEnv = {};
    if (mutation === "writable") await chmod(targetPath, 0o777);
    else if (mutation === "symlink") {
      const moved = path.join(f.root, "moved-target");
      await rename(targetPath, moved);
      await symlink(moved, targetPath);
    } else if (mutation === "missing") await rm(targetPath, { recursive: true });
    else if (mutation === "foreign") {
      // Same lstat-only simulation as root ownership tests; no privileged chown.
      const preload = path.join(f.root, "foreign-owner.mjs");
      await writeFile(preload, `import fs from 'node:fs';\nconst lstat = fs.lstatSync;\nfs.lstatSync = (name, ...args) => { const info = lstat(name, ...args); if (name === process.env.FOREIGN_OWNER_PATH) info.uid = process.getuid() + 1; return info; };\n`);
      extra.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
      extra.FOREIGN_OWNER_PATH = targetPath;
    } else {
      const metadata = JSON.parse(await readFile(targetPath, "utf8"));
      await writeFile(targetPath, JSON.stringify(mutation === "identity" ? { ...metadata, version: "0.1.1" } : { ...metadata, padding: "x".repeat(16 * 1024) }));
    }
    const before = [await snapshot(f.install), await snapshot(f.bin)];
    const result = f.run(extra);
    await expect(lstat(invoked)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Installed successfully");
    expect([await snapshot(f.install), await snapshot(f.bin)]).toEqual(before);
  });

  it("can explicitly add PATH once while preserving the rest of the shell profile", async () => {
    const f = await fixture();
    const profile = path.join(f.home, ".zshrc");
    await writeFile(profile, "# existing settings\n");
    const result = f.run({ SHELL: "/bin/zsh", KRUTRIM_CONNECT_MODIFY_PATH: "1" });
    expect(result.status, result.stderr).toBe(0);
    const content = await readFile(profile, "utf8");
    expect(content).toContain("# existing settings\n");
    expect(content).toContain(`export PATH='${f.bin}':"$PATH"`);
    const again = f.run({ SHELL: "/bin/zsh", KRUTRIM_CONNECT_MODIFY_PATH: "1" });
    expect(again.status, again.stderr).toBe(0);
    expect(await readFile(profile, "utf8")).toBe(content);
  });

  it.each(["https://example.invalid/a.tgz", "0.1.0-beta.1", "../0.1.0", "0.1.0;touch nope", "0.1.0\n../escape", "01.1.0"])("rejects unsupported version %s before downloading", async (version) => {
    const f = await fixture();
    const result = f.run({ KRUTRIM_CONNECT_VERSION: version });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exact release version");
  });

  it("refuses corrupted archives without printing success or changing the active version", async () => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    await writeFile(f.archive, "corrupt archive");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum verification failed");
    expect(result.stdout).not.toContain("Installed successfully");
    expect(await readlink(path.join(f.install, "current"))).toBe("releases/0.1.0");
  });

  it("rejects foreign release metadata before activating files", async () => {
    const f = await fixture();
    const metadata = JSON.parse(await readFile(path.join(f.stage, "release.json"), "utf8"));
    await writeFile(path.join(f.stage, "release.json"), JSON.stringify({ ...metadata, repository: "attacker/other" }));
    await f.pack();
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("metadata");
    await expect(readlink(path.join(f.install, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([false, true])("can retry a failed first activation without changing existing files (existing root: %s)", async (existingRoot) => {
    const f = await fixture();
    if (existingRoot) await mkdir(f.install, { mode: 0o700 });
    const rootBefore = existingRoot ? await lstat(f.install) : null;
    const unrelated = path.join(f.bin, "other-tool");
    await writeFile(unrelated, "keep this tool\n");
    const transient = path.join(f.root, "fail-activation");
    await writeFile(transient, "fail only the activated launcher\n");
    await writeFile(path.join(f.stage, "bin/krutrimconnect"), `#!/bin/sh\nif [ "$0" = '${f.bin}/krutrimconnect' ] && [ -f '${transient}' ]; then printf '%s\\n' broken; else printf '%s\\n' 0.1.0; fi\n`, { mode: 0o755 });
    await f.pack();
    const archive = await readFile(f.archive);

    const failed = f.run();
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain("Activated release verification failed");
    expect(failed.stdout).not.toContain("Installed successfully");
    await expect(readlink(path.join(f.install, "current"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readlink(path.join(f.bin, "krutrimconnect"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(f.install, "install.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(f.install, "releases"))).rejects.toMatchObject({ code: "ENOENT" });
    if (rootBefore) expect(await lstat(f.install)).toMatchObject({ ino: rootBefore.ino, mode: rootBefore.mode });
    expect(await readFile(unrelated, "utf8")).toBe("keep this tool\n");

    await rm(transient);
    const retry = f.run();
    expect(retry.status, retry.stderr).toBe(0);
    expect(await readFile(f.archive)).toEqual(archive);
    expect(await readlink(path.join(f.install, "current"))).toBe("releases/0.1.0");
    expect(await readFile(unrelated, "utf8")).toBe("keep this tool\n");
  });

  it("rolls back the active link when post-activation verification fails", async () => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    const previousRelease = path.join(f.install, "releases/0.1.0");
    const releaseBefore = await snapshot(previousRelease);
    const markerBefore = await readFile(path.join(f.install, "install.json"));
    await writeFile(path.join(f.bin, "other-tool"), "keep this tool\n");
    const binBefore = await snapshot(f.bin);
    const next = await fixture("0.1.1");
    await writeFile(path.join(next.stage, "bin/krutrimconnect"), `#!/bin/sh\ncase "$0" in '${f.bin}/krutrimconnect') printf '%s\\n' broken ;; *) printf '%s\\n' 0.1.1 ;; esac\n`, { mode: 0o755 });
    await next.pack();
    const result = next.run({ KRUTRIM_CONNECT_INSTALL_DIR: f.install, KRUTRIM_CONNECT_BIN_DIR: f.bin });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Activated release verification failed");
    expect(await readlink(path.join(f.install, "current"))).toBe("releases/0.1.0");
    expect(await snapshot(previousRelease)).toEqual(releaseBefore);
    expect(await readFile(path.join(f.install, "install.json"))).toEqual(markerBefore);
    expect(await snapshot(f.bin)).toEqual(binBefore);
    expect(spawnSync(path.join(f.bin, "krutrimconnect"), ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("0.1.0");
  });

  it("retains old version paths during upgrade and refuses downgrades", async () => {
    const f = await fixture();
    expect(f.run().status).toBe(0);
    const next = await fixture("0.1.1");
    const upgraded = next.run({ KRUTRIM_CONNECT_INSTALL_DIR: f.install, KRUTRIM_CONNECT_BIN_DIR: f.bin });
    expect(upgraded.status, upgraded.stderr).toBe(0);
    expect(await readlink(path.join(f.install, "current"))).toBe("releases/0.1.1");
    expect(await readFile(path.join(f.install, "releases/0.1.0/package.json"), "utf8")).toContain("0.1.0");
    const downgrade = f.run();
    expect(downgrade.status).not.toBe(0);
    expect(downgrade.stderr).toContain("downgrade");
    expect(await readlink(path.join(f.install, "current"))).toBe("releases/0.1.1");
  });

  it("does not overwrite an unrelated launcher or adopt an unmanaged directory", async () => {
    const f = await fixture();
    const launcher = path.join(f.bin, "krutrimconnect");
    await writeFile(launcher, "unrelated");
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(await readFile(launcher, "utf8")).toBe("unrelated");
    await rm(launcher);
    await mkdir(f.install, { recursive: true });
    await writeFile(path.join(f.install, "keep.txt"), "unrelated");
    expect(f.run().status).not.toBe(0);
    expect(await readFile(path.join(f.install, "keep.txt"), "utf8")).toBe("unrelated");
  });

  it("rejects links in an archive before extraction", async () => {
    const f = await fixture();
    const { symlink } = await import("node:fs/promises");
    await symlink(f.home, path.join(f.stage, "escape"));
    await f.pack();
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("archive");
  });

  it("rejects a checksum file naming anything other than the requested archive", async () => {
    const f = await fixture();
    await writeFile(`${f.archive}.sha256`, `${createHash("sha256").update("").digest("hex")}  /dev/null\n`);
    const result = f.run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum");
  });

  it.each(["public", "authenticated"])("downloads an exact artifact using %s GitHub access, without npm", async (mode) => {
    const f = await fixture();
    const mockBin = path.join(f.root, "mock-bin");
    await mkdir(mockBin);
    await writeFile(path.join(mockBin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOWNLOAD_LOG"\noutput=''\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in --output) output="$2"; shift ;; esac\n  url="$1"\n  shift\ndone\nif [ "$output" = /dev/null ]; then printf '%s' 'https://github.com/ola-krutrim/krutrimconnect/releases/tag/v0.1.0'; else cp "$FIXTURE_ASSETS/\${url##*/}" "$output"; fi\n`, { mode: 0o755 });
    await writeFile(path.join(mockBin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$DOWNLOAD_LOG"\nif [ "$2" = view ]; then printf '%s\\n' v0.1.0; exit; fi\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = --dir ]; then target="$2"; shift; fi\n  shift\ndone\ncp "$FIXTURE_ASSETS/"* "$target/"\n`, { mode: 0o755 });
    const log = path.join(f.root, "download.log");
    const result = f.run({ PATH: `${mockBin}:/usr/bin:/bin`, DOWNLOAD_LOG: log, FIXTURE_ASSETS: f.assets, KRUTRIM_CONNECT_ASSET_DIR: "", KRUTRIM_CONNECT_VERSION: "latest", KRUTRIM_CONNECT_GITHUB_AUTH: mode === "authenticated" ? "1" : "0" });
    expect(result.status, result.stderr).toBe(0);
    const calls = await readFile(log, "utf8");
    expect(calls).toContain(mode === "public" ? "https://github.com/ola-krutrim/krutrimconnect/releases/download/v0.1.0/" : "release download v0.1.0");
    expect(calls).not.toContain("npm");
  });

  it("rejects a prerelease returned as latest before downloading artifacts", async () => {
    const f = await fixture();
    const mockBin = path.join(f.root, "mock-bin");
    await mkdir(mockBin);
    await writeFile(path.join(mockBin, "gh"), "#!/bin/sh\nprintf '%s\\n' v0.1.0-next.0\n", { mode: 0o755 });
    const result = f.run({ PATH: `${mockBin}:/usr/bin:/bin`, KRUTRIM_CONNECT_ASSET_DIR: "", KRUTRIM_CONNECT_VERSION: "latest", KRUTRIM_CONNECT_GITHUB_AUTH: "1" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stable release");
  });

  it.each(["/bin/sh", "/bin/bash"])("installs via %s with no system Node or npm and leaves shell profiles alone", async (shell) => {
    const f = await fixture();
    const result = spawnSync(shell, [installer], { env: f.env, encoding: "utf8", timeout: 15_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(await readlink(path.join(f.install, "current"))).toBe("releases/0.1.0");
    expect(await readlink(path.join(f.bin, "krutrimconnect"))).toBe(path.join(f.install, "current/bin/krutrimconnect"));
    expect(JSON.parse(await readFile(path.join(f.install, "install.json"), "utf8"))).toMatchObject({ distribution: "github-release", installDir: f.install, binDir: f.bin });
    expect(result.stdout).toContain("KrutrimConnect  v0.1.0");
    expect(result.stdout).toContain("PATH");
    await expect(readFile(path.join(f.home, ".zshrc"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
