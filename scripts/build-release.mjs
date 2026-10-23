import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, chmodSync, realpathSync, mkdtempSync, rmSync, statSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import os from "node:os";
import path from "node:path";
import { releaseIdentity } from "./release-artifact-policy.mjs";

const ASSET_DIRECTORIES = ["schemas", "catalog", "licenses"];
const ASSET_FILES = ["LICENSE", "NOTICE", "README.md", "SECURITY.md", "install.sh", "docs/legal/PRIVACY_POLICY.md", "docs/legal/TERMS_AND_CONDITIONS.md", "docs/legal/LICENSE_SCOPE.md", "docs/legal/RELEASE_REVIEW.md"];

// Resolve both launcher symlinks and the installer's `current` directory symlink.
const LAUNCHER = `#!/bin/sh
set -eu
launcher=$0
case "$launcher" in */*) ;; *) launcher=$(command -v "$launcher") ;; esac
links=0
while [ -L "$launcher" ]; do
  links=$((links + 1))
  [ "$links" -le 40 ] || { printf '%s\\n' 'Launcher symlink loop' >&2; exit 1; }
  directory=$(CDPATH= cd -P -- "$(dirname -- "$launcher")" && pwd)
  target=$(readlink "$launcher")
  case "$target" in
    /*) launcher=$target ;;
    *) launcher=$directory/$target ;;
  esac
done
directory=$(CDPATH= cd -P -- "$(dirname -- "$launcher")" && pwd)
exec "$directory/node" "$directory/../dist/cli.js" "$@"
`;

export function loadNodeLicense(download = execFileSync) {
  // Node's dist directory has no standalone LICENSE. Fetch the exact upstream
  // source tag, using curl's system CA store (also works behind managed TLS).
  const url = `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`;
  let license;
  try {
    license = download("curl", [
      "--disable", "--fail", "--silent", "--show-error", "--location",
      "--proto", "=https", "--proto-redir", "=https", "--max-time", "60",
      "--retry", "2", url,
    ], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }).toString();
  } catch (error) {
    throw new Error(`Cannot acquire Node license for v${process.versions.node}: ${error.message}`);
  }
  if (!license.startsWith("Node.js is licensed for use as follows:") ||
      !license.includes("Copyright Node.js contributors") ||
      !license.includes("Permission is hereby granted")) {
    throw new Error("Upstream Node license response is invalid; refusing an unlicensed artifact.");
  }
  return license;
}

export function assertPortableRuntime({ platform = process.platform, inspect = execFileSync } = {}) {
  const failure = "Node has non-system dependencies; use an official standalone Node runtime.";
  const command = platform === "darwin" ? "otool" : "ldd";
  const args = platform === "darwin" ? ["-L", process.execPath] : [process.execPath];
  let output;
  try {
    output = inspect(command, args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, stdio: "pipe" }).toString();
  } catch (error) {
    throw new Error(`${failure} Cannot inspect runtime: ${error.message}`);
  }
  const lines = output.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (platform === "darwin") {
    const libraries = lines.slice(1).map((line) => line.split(" (")[0]);
    if (!libraries.length || libraries.some((library) =>
      !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"))) {
      throw new Error(failure);
    }
  } else if (platform === "linux") {
    const baseline = /^(?:lib(?:c|m|dl|rt|pthread)\.so\.\d+|libstdc\+\+\.so\.6|libgcc_s\.so\.1|libatomic\.so\.1|ld-linux-(?:x86-64|aarch64)\.so\.[12])$/u;
    if (!lines.length) throw new Error(failure);
    for (const line of lines) {
      if (/^linux-vdso\.so\.1\s/u.test(line)) continue;
      const [left, right] = line.split(" => ");
      const library = left.split(/\s/u)[0];
      const resolved = (right ?? left).split(/\s/u)[0];
      if (!baseline.test(path.basename(library)) || !/^\/(?:usr\/)?lib(?:64)?\//u.test(resolved)) {
        throw new Error(failure);
      }
    }
  } else {
    throw new Error(failure);
  }
}

export function stageRuntime(stage, license, validateRuntime = assertPortableRuntime) {
  validateRuntime();
  mkdirSync(path.join(stage, "bin"), { recursive: true });
  copyFileSync(process.execPath, path.join(stage, "bin/node"));
  chmodSync(path.join(stage, "bin/node"), 0o755);
  writeFileSync(path.join(stage, "bin/krutrimconnect"), LAUNCHER, { mode: 0o755 });
  mkdirSync(path.join(stage, "licenses"), { recursive: true });
  writeFileSync(path.join(stage, "licenses/Node-LICENSE"), license);
  writeFileSync(path.join(stage, "THIRD_PARTY_NOTICES"),
    `Bundled Node.js ${process.versions.node}: see licenses/Node-LICENSE.\n` +
    "Production dependency licenses are retained in node_modules alongside each package.\n");
}

function assertRegular(source, directory = false) {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link input: ${source}`);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Expected a regular ${directory ? "directory" : "file"}: ${source}`);
  }
}

function copyFile(source, destination) {
  assertRegular(source);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(source, destination);
}

function copyDirectory(source, destination) {
  assertRegular(source, true);
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else {
      assertRegular(from);
      // dist is generated/untracked; only compiled JS, declarations and maps belong here.
      if (/\.(?:js|d\.ts)(?:\.map)?$/u.test(entry.name)) copyFile(from, to);
    }
  }
}

function isolatedEnvironment(workspace) {
  const home = path.join(workspace, "home");
  mkdirSync(home, { recursive: true });
  return {
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    KRUTRIM_CONNECT_HOME: path.join(home, "krutrim-connect"),
    TMPDIR: workspace,
    CI: "1",
    NO_COLOR: "1",
  };
}

export function installProduction(stage, workspace) {
  const candidates = [
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
    path.join(path.dirname(process.execPath), "npm"),
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "npm")),
  ];
  const npmCli = candidates.filter(existsSync).map((file) => realpathSync(file))
    .find((file) => file.endsWith("/npm-cli.js"));
  if (!npmCli) throw new Error("Cannot locate npm-cli.js; install npm on the build host.");
  const userConfig = path.join(workspace, "npm-userconfig");
  const globalConfig = path.join(workspace, "npm-globalconfig");
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  execFileSync(process.execPath, [npmCli, "ci", "--omit=dev", "--include=optional",
    "--ignore-scripts=false", "--no-audit", "--no-fund",
    "--userconfig", userConfig, "--globalconfig", globalConfig,
    "--cache", path.join(workspace, "npm-cache"),
  ], { cwd: stage, env: isolatedEnvironment(workspace), encoding: "utf8", timeout: 600_000,
    stdio: "pipe", maxBuffer: 16 * 1024 * 1024 });
}

export function smokeRelease(stage, workspace, identity) {
  const env = { ...isolatedEnvironment(workspace), PATH: "/usr/bin:/bin" };
  const run = (command, args) => {
    try {
      return execFileSync(command, args, { cwd: stage, env, encoding: "utf8",
        stdio: "pipe", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      throw new Error(`Release smoke failed. Use an official standalone Node distribution.\n${error.message}`);
    }
  };
  const cli = path.join(stage, "bin/krutrimconnect");
  if (run(cli, ["--version"]).trim() !== identity.metadata.version) {
    throw new Error("Bundled CLI version does not match release metadata.");
  }
  const models = run(cli, ["models", "list", "--offline"]);
  if (!models.includes("MODEL") || !models.includes("gpt-oss-20b")) {
    throw new Error("Bundled offline model catalogue smoke failed.");
  }
  run(path.join(stage, "bin/node"), ["--input-type=module", "-e",
    'await import("@napi-rs/keyring"); await import("fs-native-extensions");',
  ]);
}

function materialize(source, destination, boundary = realpathSync(source), ancestors = new Set()) {
  const resolved = realpathSync(source);
  if (resolved !== boundary && !resolved.startsWith(`${boundary}${path.sep}`)) {
    throw new Error(`Release link points outside staging: ${source}`);
  }
  const stat = statSync(source);
  if (stat.isDirectory()) {
    if (ancestors.has(resolved)) throw new Error(`Release symbolic link cycle: ${source}`);
    const next = new Set([...ancestors, resolved]);
    mkdirSync(destination, { recursive: true, mode: 0o755 });
    for (const name of readdirSync(source).sort()) {
      // npm's command shortcuts are not used by the bundled CLI.
      if (name === ".bin") continue;
      materialize(path.join(source, name), path.join(destination, name), boundary, next);
    }
  } else if (stat.isFile()) {
    copyFileSync(source, destination); // Distinct copies also eliminate hardlinks.
    chmodSync(destination, (stat.mode & 0o111) ? 0o755 : 0o644);
  } else {
    throw new Error(`Release contains a special file: ${source}`);
  }
}

export function packRelease(stage, output, identity, verify = () => {}) {
  if (!path.isAbsolute(output)) throw new Error("Release output must be an absolute directory.");
  const archive = path.join(output, identity.filename);
  const checksum = `${archive}.sha256`;
  if (existsSync(archive) || existsSync(checksum)) throw new Error("Refusing to overwrite release artifacts.");
  const workspace = mkdtempSync(path.join(os.tmpdir(), "krutrimconnect-pack-"));
  let createdArchive = false;
  try {
    const flat = path.join(workspace, "root");
    materialize(stage, flat);
    verify(flat, workspace, identity);
    const tarball = path.join(workspace, "artifact.tar.gz");
    const bsdTar = execFileSync("tar", ["--version"], { encoding: "utf8" }).includes("bsdtar");
    const ownership = bsdTar
      ? ["--uid=0", "--gid=0", "--uname=root", "--gname=root"]
      : ["--owner=0", "--group=0", "--numeric-owner"];
    execFileSync("tar", ["--format=ustar", ...ownership, "-czf", tarball, "-C", flat, "."], {
      env: { ...isolatedEnvironment(workspace), COPYFILE_DISABLE: "1" },
      encoding: "utf8", timeout: 120_000,
    });
    const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    mkdirSync(output, { recursive: true });
    copyFileSync(tarball, archive, constants.COPYFILE_EXCL);
    createdArchive = true;
    writeFileSync(checksum, `${digest}  ${identity.filename}\n`, { flag: "wx", mode: 0o644 });
    return { archive, checksum };
  } catch (error) {
    if (createdArchive) rmSync(archive, { force: true });
    throw error;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function buildRelease({ repositoryRoot, output = path.join(repositoryRoot, "release") }, {
  loadLicense = loadNodeLicense, install = installProduction,
  runtime = stageRuntime, verify = smokeRelease,
} = {}) {
  if (!path.isAbsolute(output)) throw new Error("Release output must be an absolute directory.");
  const workspace = mkdtempSync(path.join(os.tmpdir(), "krutrimconnect-release-"));
  try {
    const stage = path.join(workspace, "stage");
    const identity = prepareRelease(repositoryRoot, stage);
    if ([identity.filename, `${identity.filename}.sha256`].some((file) => existsSync(path.join(output, file)))) {
      throw new Error("Refusing to overwrite release artifacts.");
    }
    const license = loadLicense();
    install(stage, workspace);
    runtime(stage, license);
    writeFileSync(path.join(stage, "release.json"), `${JSON.stringify(identity.metadata, null, 2)}\n`);
    rmSync(path.join(stage, "package-lock.json"));
    return packRelease(stage, output, identity, verify);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function prepareRelease(repositoryRoot, stage) {
  for (const file of ["package.json", "package-lock.json"]) assertRegular(path.join(repositoryRoot, file));
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const identity = releaseIdentity(manifest.version);
  if (manifest.name !== "krutrimconnect") throw new Error("Expected the krutrimconnect package.");
  const lock = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
  if (lock.lockfileVersion < 2 || !lock.packages?.[""] ||
      lock.version !== manifest.version || lock.packages[""].version !== manifest.version ||
      lock.name !== manifest.name || lock.packages[""].name !== manifest.name) {
    throw new Error("Release package-lock.json identity must match package.json.");
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (!isDeepStrictEqual(manifest[field] ?? {}, lock.packages[""][field] ?? {})) {
      throw new Error(`Release lock ${field} must match package.json.`);
    }
  }
  if (!existsSync(path.join(repositoryRoot, "dist/cli.js"))) {
    throw new Error("Missing dist/cli.js; run npm run build first.");
  }
  const tracked = execFileSync("git", ["ls-files", "-z"], {
    cwd: repositoryRoot, encoding: "utf8",
  }).split("\0");
  for (const file of ASSET_FILES) {
    if (!tracked.includes(file)) throw new Error(`Required tracked release input: ${file}`);
  }
  for (const dir of ASSET_DIRECTORIES) {
    assertRegular(path.join(repositoryRoot, dir), true);
    if (!tracked.some((file) => file.startsWith(`${dir}/`))) {
      throw new Error(`Required tracked release directory: ${dir}`);
    }
  }
  mkdirSync(stage, { recursive: true });
  delete manifest.scripts;
  delete lock.packages[""].scripts;
  delete lock.packages[""].hasInstallScript;
  writeFileSync(path.join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(stage, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  copyDirectory(path.join(repositoryRoot, "dist"), path.join(stage, "dist"));
  for (const file of tracked) {
    if (ASSET_FILES.includes(file) || ASSET_DIRECTORIES.some((dir) => file.startsWith(`${dir}/`))) {
      for (let dir = path.dirname(file); dir !== "."; dir = path.dirname(dir)) {
        assertRegular(path.join(repositoryRoot, dir), true);
      }
      copyFile(path.join(repositoryRoot, file), path.join(stage, file));
    }
  }
  return identity;
}

export function parseBuildArguments(args, repositoryRoot) {
  if (args.length === 0) return { repositoryRoot, output: path.join(repositoryRoot, "release") };
  if (args.length !== 2 || args[0] !== "--output") {
    throw new Error("Usage: node scripts/build-release.mjs [--output ABSOLUTE_DIRECTORY]. Cross-builds are not supported.");
  }
  if (!path.isAbsolute(args[1])) throw new Error("Release output must be an absolute directory.");
  return { repositoryRoot, output: args[1] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseBuildArguments(process.argv.slice(2), fileURLToPath(new URL("..", import.meta.url)));
    const result = buildRelease(options);
    process.stdout.write(`Built ${result.archive}\nSHA-256: ${result.checksum}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
