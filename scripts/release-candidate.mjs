import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertPackedManifest } from "./package-policy.mjs";
import {
  assertChannelVersion,
  assertDogfoodReport,
  assertRegistryAllowsRelease,
  expectedConfirmation,
} from "./release-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_NAME = "krutrimconnect";
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

function usage() {
  return [
    "Usage:",
    "  node scripts/release-candidate.mjs --artifact <file.tgz> --channel <next|latest>",
    "  node scripts/release-candidate.mjs --artifact <file.tgz> --channel <next|latest> \\",
    "    --dogfood-report <report.json> --execute --confirm '<exact confirmation>'",
    "",
    "The command is a registry dry-run unless --execute is supplied.",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { execute: false, registry: DEFAULT_REGISTRY };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      options.execute = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (["--artifact", "--channel", "--confirm", "--dogfood-report", "--registry"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      const key = argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
      options[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${String(argument)}.\n${usage()}`);
  }
  if (!options.artifact || !options.channel) {
    throw new Error(`--artifact and --channel are required.\n${usage()}`);
  }
  let registry;
  try {
    registry = new URL(options.registry).href;
  } catch {
    throw new Error("--registry must be a valid URL.");
  }
  if (registry !== DEFAULT_REGISTRY) {
    throw new Error(`Releases are restricted to ${DEFAULT_REGISTRY}.`);
  }
  options.registry = registry;
  return options;
}

function run(command, args, { quiet = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: quiet ? "silent" : "notice" },
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with exit ${String(result.status)}.\n${result.stdout}${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function runNpm(args, options) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    return run(process.execPath, [npmCli, ...args], options);
  }
  if (process.platform === "win32") {
    throw new Error(
      "Direct Windows execution cannot locate npm safely; invoke this script through npm exec.",
    );
  }
  return run("npm", args, options);
}

function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} JSON at ${filePath}: ${String(error)}`);
  }
  return value;
}

function parsePublishJson(stdout) {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    throw new Error("npm publish --dry-run did not return JSON metadata.");
  }
  const parsed = JSON.parse(stdout.slice(jsonStart));
  const packed = parsed[PACKAGE_NAME];
  if (!packed) {
    throw new Error(`npm publish --dry-run omitted ${PACKAGE_NAME}.`);
  }
  return packed;
}

async function readRegistryMetadata(registry, packageName) {
  const url = new URL(encodeURIComponent(packageName), registry);
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.npm.install-v1+json" },
    redirect: "error",
  });
  if (response.status === 404) {
    return { versions: {}, "dist-tags": {} };
  }
  if (!response.ok) {
    throw new Error(`npm registry metadata request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function verifyArtifact(options) {
  const artifactPath = path.resolve(repositoryRoot, options.artifact);
  if (!existsSync(artifactPath) || path.extname(artifactPath) !== ".tgz") {
    throw new Error(`Artifact does not exist or is not a .tgz file: ${artifactPath}`);
  }
  const stem = artifactPath.slice(0, -".tgz".length);
  const manifestPath = `${stem}.manifest.json`;
  const checksumPath = `${artifactPath}.sha256`;
  if (!existsSync(manifestPath) || !existsSync(checksumPath)) {
    throw new Error("The artifact requires adjacent .manifest.json and .tgz.sha256 files.");
  }
  const manifest = readJson(manifestPath, "release manifest");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.channel !== "private-dogfood" ||
    manifest.package !== PACKAGE_NAME ||
    manifest.filename !== path.basename(artifactPath)
  ) {
    throw new Error("Release manifest does not describe this private dogfood artifact.");
  }
  assertChannelVersion(options.channel, manifest.version);
  const sha256 = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
  if (sha256 !== manifest.sha256) {
    throw new Error("Artifact SHA-256 does not match the release manifest.");
  }
  const checksum = readFileSync(checksumPath, "utf8").trim();
  if (checksum !== `${sha256}  ${path.basename(artifactPath)}`) {
    throw new Error("Adjacent SHA-256 file does not exactly match the artifact.");
  }
  return { artifactPath, manifest };
}

async function verifyPublished(registry, manifest, channel) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const metadata = await readRegistryMetadata(registry, PACKAGE_NAME);
    const published = metadata.versions?.[manifest.version];
    if (published && metadata["dist-tags"]?.[channel] === manifest.version) {
      if (
        published.dist?.shasum !== manifest.npmShasum ||
        published.dist?.integrity !== manifest.npmIntegrity
      ) {
        throw new Error("Published registry integrity does not match the approved manifest.");
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Published version or dist-tag was not observable in the registry.");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { artifactPath, manifest } = verifyArtifact(options);
  const dryRun = runNpm([
    "publish",
    artifactPath,
    "--dry-run",
    "--json",
    "--tag",
    options.channel,
    "--access",
    "public",
    "--provenance=false",
    "--registry",
    options.registry,
  ]);
  const packed = parsePublishJson(dryRun.stdout);
  assertPackedManifest(packed);
  if (
    packed.name !== PACKAGE_NAME ||
    packed.version !== manifest.version ||
    packed.filename !== manifest.filename ||
    packed.shasum !== manifest.npmShasum ||
    packed.integrity !== manifest.npmIntegrity ||
    packed.size !== manifest.packedBytes ||
    packed.unpackedSize !== manifest.unpackedBytes ||
    packed.entryCount !== manifest.entryCount
  ) {
    throw new Error("npm dry-run package metadata differs from the approved manifest.");
  }

  const registryMetadata = await readRegistryMetadata(options.registry, PACKAGE_NAME);
  assertRegistryAllowsRelease({
    packageName: PACKAGE_NAME,
    version: manifest.version,
    channel: options.channel,
    metadata: registryMetadata,
  });

  const confirmation = expectedConfirmation(PACKAGE_NAME, manifest.version, options.channel);
  let dogfoodReport;
  if (options.dogfoodReport) {
    dogfoodReport = readJson(path.resolve(repositoryRoot, options.dogfoodReport), "dogfood report");
    assertDogfoodReport(dogfoodReport, manifest);
  }
  if (!options.execute) {
    const reportTemplate = {
      schemaVersion: 1,
      package: manifest.package,
      version: manifest.version,
      artifactSha256: manifest.sha256,
      outcome: "passed",
      testedAt: "<ISO-8601 timestamp>",
      tester: "<internal tester>",
      os: "<operating system and version>",
      nodeVersion: "<node --version>",
      npmVersion: "<npm --version>",
      model: "<exact model id>",
      route: "<native or bridge>",
      activation: "passed",
      toolContinuation: "passed",
      disconnect: "passed",
      configRestoration: "passed",
    };
    process.stdout.write(
      `Dry-run passed for ${PACKAGE_NAME}@${manifest.version} -> ${options.channel}.\n` +
      `Artifact SHA-256: ${manifest.sha256}\n` +
      (dogfoodReport
        ? "Dogfood report validation: passed.\n"
        : `Dogfood report template:\n${JSON.stringify(reportTemplate, null, 2)}\n`) +
      `Exact publication confirmation:\n${confirmation}\n`,
    );
    return;
  }

  if (!dogfoodReport) {
    throw new Error("--execute requires --dogfood-report.");
  }
  if (options.confirm !== confirmation) {
    throw new Error(`--confirm must exactly equal: ${confirmation}`);
  }

  const publisher = runNpm(["whoami", "--registry", options.registry], { quiet: true }).stdout.trim();
  if (publisher.length === 0) {
    throw new Error("npm whoami did not return an authenticated publisher.");
  }
  process.stdout.write(`Authenticated npm publisher: ${publisher}\n`);
  runNpm([
    "publish",
    artifactPath,
    "--json",
    "--tag",
    options.channel,
    "--access",
    "public",
    "--provenance=false",
    "--registry",
    options.registry,
  ]);
  await verifyPublished(options.registry, manifest, options.channel);
  process.stdout.write(
    `Published and verified ${PACKAGE_NAME}@${manifest.version} on ${options.channel}.\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
