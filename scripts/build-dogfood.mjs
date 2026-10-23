import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { assertPackedManifest } from "./package-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageMetadata = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "silent" },
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      command + " failed with exit " + String(result.status) + ".\n" +
      result.stdout + result.stderr,
    );
  }
  return result.stdout;
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("npm_execpath is unavailable; run this builder through npm run pack:dogfood.");
  }
  return run(process.execPath, [npmCli, ...args]);
}

if (packageMetadata.name !== "krutrimconnect") {
  throw new Error("Dogfood builds are restricted to the krutrimconnect package.");
}
if (
  typeof packageMetadata.version !== "string" ||
  !/^\d+\.\d+\.\d+-next\.\d+$/u.test(packageMetadata.version)
) {
  throw new Error("Dogfood package versions must use the exact form X.Y.Z-next.N.");
}

const trackedStatus = run("git", ["status", "--porcelain", "--untracked-files=no"]).trim();
if (trackedStatus.length > 0) {
  throw new Error("Refusing to build a dogfood package from uncommitted tracked changes.");
}

const commit = run("git", ["rev-parse", "HEAD"]).trim();
const branch = run("git", ["branch", "--show-current"]).trim();
const expectedFilename = `${packageMetadata.name}-${packageMetadata.version}.tgz`;
const tarballPath = path.join(repositoryRoot, expectedFilename);
const checksumPath = `${tarballPath}.sha256`;
const manifestPath = path.join(
  repositoryRoot,
  `${packageMetadata.name}-${packageMetadata.version}.manifest.json`,
);

for (const output of [tarballPath, checksumPath, manifestPath]) {
  if (existsSync(output)) {
    throw new Error(`Refusing to overwrite existing dogfood artifact: ${output}`);
  }
}

const packOutput = runNpm([
  "pack",
  "--json",
  "--silent",
  "--pack-destination",
  repositoryRoot,
]);
const jsonStart = packOutput.indexOf("[");
if (jsonStart < 0) {
  throw new Error("npm pack did not return a JSON manifest.");
}
const [packed] = JSON.parse(packOutput.slice(jsonStart));
assertPackedManifest(packed);
if (packed.filename !== expectedFilename) {
  throw new Error(
    `Unexpected tarball filename: expected ${expectedFilename}, got ${String(packed.filename)}.`,
  );
}

const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
const manifest = {
  schemaVersion: 1,
  channel: "private-dogfood",
  package: packageMetadata.name,
  version: packageMetadata.version,
  commit,
  branch,
  createdAt: new Date().toISOString(),
  filename: expectedFilename,
  sha256,
  npmShasum: packed.shasum,
  npmIntegrity: packed.integrity,
  packedBytes: packed.size,
  unpackedBytes: packed.unpackedSize,
  entryCount: packed.entryCount,
  nodeVersion: process.version,
};

writeFileSync(checksumPath, `${sha256}  ${expectedFilename}\n`, { mode: 0o644 });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });

process.stdout.write(
  `Built private dogfood package ${packageMetadata.name}@${packageMetadata.version}.\n` +
  `Tarball: ${tarballPath}\n` +
  `SHA-256: ${checksumPath}\n` +
  `Manifest: ${manifestPath}\n`,
);
