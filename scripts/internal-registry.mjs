import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertInternalPublishContext,
  INTERNAL_PACKAGE_NAME,
  INTERNAL_REGISTRY,
  INTERNAL_TAG,
  prepareInternalPackageJson,
} from "./internal-registry-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packagePath = path.join(repositoryRoot, "package.json");

function readPackageJson() {
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function assertEnvironment(packageJson) {
  assertInternalPublishContext({
    packageJson,
    confirmation: process.env.INTERNAL_PUBLISH_CONFIRMATION,
    actions: process.env.GITHUB_ACTIONS,
    eventName: process.env.GITHUB_EVENT_NAME,
    repository: process.env.GITHUB_REPOSITORY,
    repositoryPrivate: process.env.INTERNAL_REPOSITORY_PRIVATE,
    ref: process.env.GITHUB_REF,
  });
}

function main() {
  const command = process.argv[2];
  const packageJson = readPackageJson();
  assertEnvironment(packageJson);

  if (command === "guard") {
    process.stdout.write(
      `Approved ${INTERNAL_PACKAGE_NAME}@${packageJson.version} -> ${INTERNAL_REGISTRY} (${INTERNAL_TAG}).\n`,
    );
    return;
  }
  if (command === "prepare") {
    const prepared = prepareInternalPackageJson(packageJson);
    writeFileSync(packagePath, `${JSON.stringify(prepared, null, 2)}\n`, { mode: 0o644 });
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `version=${prepared.version}\n`, "utf8");
    }
    process.stdout.write(`Prepared ${prepared.name}@${prepared.version} for the internal registry.\n`);
    return;
  }
  throw new Error("Usage: node scripts/internal-registry.mjs <guard|prepare>");
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}
