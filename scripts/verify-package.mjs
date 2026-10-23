import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertPackedManifest } from "./package-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

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
    throw new Error("npm_execpath is unavailable; run this verifier through npm run verify:package.");
  }
  return run(process.execPath, [npmCli, ...args]);
}

const packageMetadata = JSON.parse(
  readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
const binaryEntries = Object.entries(packageMetadata.bin ?? {});
if (
  binaryEntries.length !== 1 ||
  binaryEntries[0][0] !== "krutrimconnect" ||
  binaryEntries[0][1] !== "dist/cli.js"
) {
  throw new Error("The package must expose only the krutrimconnect executable from dist/cli.js.");
}
const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "krutrimconnect-package-"));

try {
  const packOutput = runNpm([
    "pack",
    "--json",
    "--silent",
    "--pack-destination",
    temporaryRoot,
  ]);
  const jsonStart = packOutput.indexOf("[");
  if (jsonStart < 0) {
    throw new Error("npm pack did not return a JSON manifest.");
  }
  const [packed] = JSON.parse(packOutput.slice(jsonStart));
  assertPackedManifest(packed);

  const tarball = path.join(temporaryRoot, packed.filename);
  const prefix = path.join(temporaryRoot, "prefix");
  runNpm([
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    tarball,
  ]);

  const cli = process.platform === "win32"
    ? path.join(prefix, "krutrimconnect.cmd")
    : path.join(prefix, "bin", "krutrimconnect");
  statSync(cli);
  if (process.platform !== "win32" && (statSync(cli).mode & 0o111) === 0) {
    throw new Error("The installed krutrimconnect executable is not executable.");
  }

  const runCli = (args) => process.platform === "win32"
    ? run(process.execPath, [
        path.join(prefix, "node_modules", packageMetadata.name, "dist", "cli.js"),
        ...args,
      ])
    : run(cli, args);

  const installedVersion = runCli(["--version"]).trim();
  if (installedVersion !== packageMetadata.version) {
    throw new Error(
      "Installed version mismatch: expected " + packageMetadata.version +
      ", got " + installedVersion + ".",
    );
  }
  const loginHelp = runCli(["login", "--help"]);
  if (
    !loginHelp.includes("--from-env") ||
    !loginHelp.includes("--stdin") ||
    !loginHelp.includes("--skip-validation")
  ) {
    throw new Error("The installed package is missing explicit credential input options.");
  }
  const upgradeHelp = runCli(["upgrade", "--help"]);
  if (!upgradeHelp.includes("--check")) {
    throw new Error("The installed package is missing the guarded upgrade command.");
  }
  const authHelp = runCli(["auth", "--help"]);
  if (!authHelp.includes("status")) {
    throw new Error("The installed package is missing auth status.");
  }
  const logoutHelp = runCli(["logout", "--help"]);
  if (!logoutHelp.includes("--json")) {
    throw new Error("The installed package is missing machine-readable logout output.");
  }

  const models = runCli(["models", "list", "--offline"]);
  if (!models.includes("MODEL") || !models.includes("gpt-oss-20b")) {
    throw new Error("The installed package failed the offline model-catalogue smoke test.");
  }

  process.stdout.write(
    "Verified " + packageMetadata.name + "@" + packageMetadata.version +
    " (" + String(packed.entryCount) + " files, " + String(packed.size) + " packed bytes).\n",
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
