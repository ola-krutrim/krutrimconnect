#!/usr/bin/env node
import { toolInvocation } from "./tool-invocation.js";

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { input as promptInput } from "@inquirer/prompts";
import { Command } from "commander";

import {
  readApiKeyInput,
  selectApiKeyInputSource,
  fetchKrutrimModelCatalogue,
  fetchKrutrimModelRegistry,
} from "./auth.js";
import {
  liveModelIdsFromEntries,
  mergeLiveKrutrimCatalog,
  readLiveCatalogCache,
  registryModelsFromEntries,
  writeLiveCatalogCache,
  type MergedKrutrimCatalog,
  type MergedKrutrimCatalogModel,
} from "./catalog/live.js";
import {
  fetchPublishedCatalog,
  readBundledCatalogFile,
} from "./catalog/published.js";
import {
  KRUTRIM_CATALOG,
  KRUTRIM_MODALITIES,
  findKrutrimModel,
  isKrutrimModality,
  listKrutrimModels,
  type KrutrimCatalogModel,
} from "./catalog/krutrim.js";
import {
  probeAndStoreKrutrimBridgeCapabilities,
  resolveKrutrimBridgeForModel,
} from "./bridge/krutrim.js";
import {
  bridgeCapabilities,
  bridgeCredential,
  decideCodexRoute,
  enableCodexAutomatically,
  enableOpenCodeAutomatically,
  qualifyBridgeRoute,
  qualifyCodexRoute,
  runBridgeQualificationAttempts,
} from "./bridge/connection.js";
import {
  bridgeIsHealthy,
  bridgeRuntimeFileFor,
  readBridgeRuntime,
  readBridgeRuntimeForOwner,
  serveBridgeRuntime,
  stopBridgeRuntime,
  type BridgeRuntimeOwner,
} from "./bridge/runtime.js";
import { deriveBridgeBearer } from "./bridge/server.js";
import {
  probeAndStoreKrutrimCapabilities,
  resolveKrutrimProviderForModel,
} from "./capabilities/krutrim.js";
import { removeKrutrimCredential, storeKrutrimCredential } from "./credentials.js";
import { runDoctor } from "./doctor.js";
import {
  CapabilityError,
  ConfigurationError,
  KrutrimConnectError,
  SecretStoreError,
} from "./errors.js";
import { CodexHarness } from "./harnesses/codex.js";
import { OpenCodeHarness } from "./harnesses/opencode.js";
import type { HarnessStatus } from "./harnesses/types.js";
import { OPENCODE_BRIDGE_TOKEN_ENV } from "./config/opencode-json.js";
import { openCodeLaunchCredentialMatches } from "./opencode/launch-credential.js";
import { runKrutrimChatCompletion } from "./inference/chat-completions.js";
import { promptForKrutrimApiKey } from "./login.js";
import { resolveRuntimePaths } from "./paths.js";
import { krutrimProvider } from "./providers/krutrim.js";
import { redactText, redactValue } from "./security/redact.js";
import { SecretManager } from "./secrets/manager.js";
import {
  removeGlobalPackageWithNpm,
  uninstallKrutrimConnect,
} from "./uninstall.js";
import { readInstalledPackageMetadata, upgradeKrutrimConnect } from "./upgrade.js";
import { KRUTRIM_CONNECT_VERSION } from "./version.js";

const paths = resolveRuntimePaths();
const cliEntrypoint = fileURLToPath(import.meta.url);
const helper = {
  command: process.execPath,
  args: [cliEntrypoint, "_credential", "read", "--app-home", paths.appHome],
};

async function dependencies(runtimePaths = paths): Promise<{
  secrets: SecretManager;
  codex: CodexHarness;
  opencode: OpenCodeHarness;
}> {
  const secrets = await SecretManager.create(runtimePaths);
  return {
    secrets,
    codex: new CodexHarness(runtimePaths, secrets, helper),
    opencode: new OpenCodeHarness(runtimePaths),
  };
}

async function storedApiKey(secrets: SecretManager): Promise<string> {
  const apiKey = await secrets.read();
  if (apiKey === null) {
    throw new SecretStoreError("No Krutrim API key is stored. Run krutrimconnect login first.");
  }
  return apiKey;
}

async function stopHarnessBridge(
  owner: BridgeRuntimeOwner,
  otherOwner: BridgeRuntimeOwner,
  otherStatus: HarnessStatus,
): Promise<boolean> {
  const stoppedOwned = await stopBridgeRuntime(bridgeRuntimeFileFor(paths, owner));
  const legacy = await readBridgeRuntime(paths.bridgeRuntimeFile);
  if (legacy === null) {
    return stoppedOwned;
  }

  let otherMayUseLegacy = true;
  if (otherStatus.state === "disconnected" || otherStatus.connectionMode === "native") {
    otherMayUseLegacy = false;
  } else if (otherStatus.connectionMode === "bridge" && otherStatus.model !== undefined) {
    const dedicated = await readBridgeRuntime(
      bridgeRuntimeFileFor(paths, otherOwner),
    );
    otherMayUseLegacy = !(
      dedicated !== null &&
      dedicated.model === otherStatus.model &&
      await bridgeIsHealthy(dedicated)
    );
  }

  const stoppedLegacy = otherMayUseLegacy
    ? false
    : await stopBridgeRuntime(paths.bridgeRuntimeFile, legacy);
  return stoppedOwned || stoppedLegacy;
}

async function runOpenCode(args: string[]): Promise<void> {
  const { secrets, opencode } = await dependencies();
  const status = await opencode.status();
  if (status.state !== "connected" || status.model === undefined) {
    throw new ConfigurationError("OpenCode is not connected. Run 'krutrimconnect opencode on --model <model>' first.");
  }
  const runtime = await readBridgeRuntimeForOwner(paths, "opencode");
  if (runtime === null || runtime.model !== status.model || !(await bridgeIsHealthy(runtime))) {
    throw new ConfigurationError("OpenCode's managed connection is unavailable or bound to a different model. Re-run 'krutrimconnect opencode on'.");
  }
  const executable = process.env.KRUTRIM_OPENCODE_BIN?.trim() || "opencode";
  if (executable.includes("\0")) {
    throw new ConfigurationError("KRUTRIM_OPENCODE_BIN must not contain a NUL byte.");
  }
  const token = await bridgeCredential(secrets, runtime.instanceId);
  const code = await new Promise<number | null>((resolve, reject) => {
    const invocation = toolInvocation(executable, args);
    const child = spawn(invocation.command, invocation.args, {
      env: { ...process.env, [OPENCODE_BRIDGE_TOKEN_ENV]: token },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode));
  });
  if (code !== 0) {
    process.exitCode = code ?? 1;
  }
}

const MAX_STDIN_PROMPT_BYTES = 256 * 1024;

async function readPrompt(): Promise<string> {
  if (process.stdin.isTTY) {
    return await promptInput({ message: "Prompt:" });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > MAX_STDIN_PROMPT_BYTES) {
      throw new ConfigurationError(`Prompt input exceeds ${MAX_STDIN_PROMPT_BYTES} bytes.`);
    }
    chunks.push(bytes);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch (error) {
    throw new ConfigurationError("Prompt input is not valid UTF-8.", { cause: error });
  }
}

function positiveInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new ConfigurationError("Expected a positive integer.");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ConfigurationError("Expected a positive integer.");
  }
  return parsed;
}

function temperatureValue(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
    throw new ConfigurationError("Temperature must be between 0 and 2.");
  }
  return parsed;
}

function formatModels(models: readonly KrutrimCatalogModel[]): string {
  if (models.length === 0) {
    return "No models matched the supplied filters.\n";
  }
  const headings = ["MODEL", "PUBLISHER", "MODALITY", "INPUT ₹/1M", "OUTPUT ₹/1M"];
  const rows = models.map((model) => [
    model.id,
    model.publisher,
    model.modality,
    String(model.pricing.input),
    String(model.pricing.output),
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [headings, ...rows]
    .map((row) => row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd())
    .join("\n") + "\n";
}

const program = new Command();
program
  .name("krutrimconnect")
  .description("Capability-aware Krutrim Cloud configuration for AI coding tools")
  .version(KRUTRIM_CONNECT_VERSION);

program
  .command("upgrade")
  .description("Install the latest KrutrimConnect release")
  .option("--check", "check for an available upgrade without installing it")
  .action(async (options: { check?: boolean }) => {
    process.stdout.write("Checking for KrutrimConnect updates...\n");
    const result = await upgradeKrutrimConnect({
      checkOnly: options.check === true,
      onInstalling: (currentVersion, availableVersion) => {
        process.stdout.write(
          `Upgrading KrutrimConnect ${currentVersion} -> ${availableVersion}...\n`,
        );
      },
    });
    if (result.status === "current") {
      process.stdout.write(
        `KrutrimConnect ${result.currentVersion} is already up to date.\n`,
      );
      return;
    }
    if (result.status === "newer") {
      process.stdout.write(
        `Installed KrutrimConnect ${result.currentVersion} is newer than available version ${result.availableVersion}; no files changed.\n`,
      );
      return;
    }
    if (result.status === "available") {
      process.stdout.write(
        `KrutrimConnect ${result.availableVersion} is available. Run 'krutrimconnect upgrade' to install it.\n`,
      );
      return;
    }
    process.stdout.write(
      `KrutrimConnect upgraded to ${result.availableVersion}. Restart active Codex or OpenCode sessions before using the new CLI.\n`,
    );
  });

program
  .command("uninstall")
  .description(
    "Disconnect Codex and OpenCode, remove local Krutrim credentials, then remove KrutrimConnect",
  )
  .option("--force", "snapshot externally changed harness configs before restoring baselines")
  .option("--keep-package", "deactivate and remove credentials but keep KrutrimConnect installed")
  .option("--json", "emit a machine-readable uninstall result")
  .action(async (options: { force?: boolean; keepPackage?: boolean; json?: boolean }) => {
    const { secrets, codex: codexHarness, opencode: openCodeHarness } = await dependencies();
    const result = await uninstallKrutrimConnect(
      {
        metadata: await readInstalledPackageMetadata(),
        codex: codexHarness,
        opencode: openCodeHarness,
        removeCredential: () => removeKrutrimCredential(paths, codexHarness, secrets),
        stopBridges: async () => {
          const codexStopped = await stopHarnessBridge(
            "codex",
            "opencode",
            await openCodeHarness.status(),
          );
          const openCodeStopped = await stopHarnessBridge(
            "opencode",
            "codex",
            await codexHarness.status(),
          );
          return codexStopped || openCodeStopped;
        },
        removeGlobalPackage: removeGlobalPackageWithNpm,
      },
      { force: options.force === true, keepPackage: options.keepPackage === true },
    );
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    for (const harness of result.harnesses) {
      process.stdout.write(
        harness.restored
          ? `${harness.harness}: configuration restored to the pre-connect baseline.\n`
          : `${harness.harness}: already disconnected; no files changed.\n`,
      );
    }
    process.stdout.write(
      result.credentialRemoved
        ? `Local Krutrim credential state removed (${result.removedBackends.join(", ") || "state only"}).\n`
        : "No local Krutrim credential was configured.\n",
    );
    process.stdout.write("Remote Krutrim key revocation was not performed.\n");
    process.stdout.write(
      result.packageRemoved
        ? "KrutrimConnect package removed.\n"
        : "KrutrimConnect package was kept installed (--keep-package).\n",
    );
  });

const models = program
  .command("models")
  .description("Browse Krutrim Cloud catalogue models (bundled snapshot or live)");

const liveCatalogCacheFile = path.join(paths.appHome, "catalog", "live.json");

async function liveKrutrimCatalog(refresh: boolean): Promise<{
  catalog: MergedKrutrimCatalog;
  origin: "network" | "cache" | "stale-cache" | "published" | "bundled";
} | null> {
  const now = new Date();
  if (!refresh) {
    const cached = await readLiveCatalogCache(liveCatalogCacheFile, now);
    if (cached !== null && !cached.stale) {
      return { catalog: cached.catalog, origin: "cache" };
    }
  }
  const { secrets } = await dependencies();
  const apiKey = await secrets.read();
  if (apiKey === null) {
    return await publishedKrutrimCatalog(refresh);
  }
  try {
    const [entries, registryEntries] = await Promise.all([
      fetchKrutrimModelCatalogue(apiKey),
      fetchKrutrimModelRegistry(apiKey).catch(() => [] as unknown[]),
    ]);
    const catalog = mergeLiveKrutrimCatalog(
      liveModelIdsFromEntries(entries),
      registryModelsFromEntries(registryEntries),
      now,
    );
    await writeLiveCatalogCache(liveCatalogCacheFile, catalog);
    return { catalog, origin: "network" };
  } catch (error) {
    const cached = await readLiveCatalogCache(liveCatalogCacheFile, now);
    if (cached !== null) {
      return { catalog: cached.catalog, origin: "stale-cache" };
    }
    const published = await publishedKrutrimCatalog(false);
    if (published !== null) {
      return published;
    }
    if (refresh) {
      throw error;
    }
    return null;
  }
}

const bundledCatalogFile = fileURLToPath(
  new URL("../catalog/krutrim-live.json", import.meta.url),
);

async function publishedKrutrimCatalog(refresh: boolean): Promise<{
  catalog: MergedKrutrimCatalog;
  origin: "published" | "bundled";
} | null> {
  const published = await fetchPublishedCatalog();
  if (published !== null) {
    return { catalog: published, origin: "published" };
  }
  if (refresh) {
    throw new ConfigurationError(
      "The published Krutrim catalogue could not be fetched. Check your network connection.",
    );
  }
  return await offlineKrutrimCatalog();
}

async function offlineKrutrimCatalog(): Promise<{
  catalog: MergedKrutrimCatalog;
  origin: "bundled";
} | null> {
  const bundled = await readBundledCatalogFile(bundledCatalogFile);
  if (bundled !== null) {
    return { catalog: bundled, origin: "bundled" };
  }
  return null;
}

function formatMergedModels(
  catalogModels: readonly MergedKrutrimCatalogModel[],
  showAvailability: boolean,
): string {
  if (catalogModels.length === 0) {
    return "No models matched the supplied filters.\n";
  }
  const headings = [
    "MODEL",
    ...(showAvailability ? ["AVAILABILITY"] : []),
    "PUBLISHER",
    "MODALITY",
    "CONTEXT",
    "INPUT ₹/1M",
    "OUTPUT ₹/1M",
  ];
  const rows = catalogModels.map((model) => [
    model.id,
    ...(showAvailability ? [model.availability] : []),
    model.publisher ?? "-",
    model.modality ?? "-",
    model.contextLength === undefined ? "-" : String(model.contextLength),
    model.pricing === undefined ? "-" : String(model.pricing.input),
    model.pricing === undefined ? "-" : String(model.pricing.output),
  ]);
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]?.length ?? 0)),
  );
  return [headings, ...rows]
    .map((row) => row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join("  ").trimEnd())
    .join("\n") + "\n";
}

models
  .command("list")
  .description("List Krutrim Cloud catalogue models, live when possible with snapshot fallback")
  .option("--offline", "skip the live check and read only the bundled snapshot")
  .option("--refresh", "bypass the cached live catalogue and refetch")
  .option("--all", "include unavailable and unlisted models, not just available ones")
  .option("--modality <modality>", `filter by modality (${KRUTRIM_MODALITIES.join(", ")})`)
  .option("--publisher <publisher>", "filter by model publisher")
  .option("--query <text>", "search model id, publisher, or modality")
  .option("--json", "emit machine-readable snapshot metadata and models")
  .action(
    async (options: {
      offline?: boolean;
      refresh?: boolean;
      all?: boolean;
      modality?: string;
      publisher?: string;
      query?: string;
      json?: boolean;
    }) => {
      if (options.refresh === true && options.offline === true) {
        throw new ConfigurationError("models list --refresh cannot be combined with --offline.");
      }
      if (options.modality !== undefined && !isKrutrimModality(options.modality)) {
        throw new ConfigurationError(
          `Unknown modality '${options.modality}'. Expected one of: ${KRUTRIM_MODALITIES.join(", ")}.`,
        );
      }
      const live = options.offline === true
        ? await offlineKrutrimCatalog()
        : await liveKrutrimCatalog(options.refresh === true);
      if (live !== null) {
        const { catalog, origin } = live;
        const folded = (value: string | undefined): string =>
          (value ?? "").toLocaleLowerCase("en-US");
        const query = options.query?.toLocaleLowerCase("en-US");
        const matches = catalog.models
          .filter((model) => options.all === true || model.availability === "available")
          .filter((model) => options.modality === undefined || model.modality === options.modality)
          .filter(
            (model) =>
              options.publisher === undefined ||
              folded(model.publisher).includes(options.publisher.toLocaleLowerCase("en-US")),
          )
          .filter(
            (model) =>
              query === undefined ||
              folded(model.id).includes(query) ||
              folded(model.publisher).includes(query) ||
              folded(model.modality).includes(query),
          );
        if (options.json) {
          process.stdout.write(`${JSON.stringify({
            provider: catalog.provider,
            live: catalog.live,
            fetched: catalog.fetched,
            origin,
            snapshotObserved: catalog.snapshotObserved,
            count: matches.length,
            models: matches,
          }, null, 2)}\n`);
          return;
        }
        if (origin === "stale-cache" || origin === "bundled") {
          process.stdout.write(
            "Note: showing the last known catalogue; availability may be out of date.\n",
          );
        }
        process.stdout.write(formatMergedModels(matches, options.all === true));
        return;
      }
      const matches = listKrutrimModels({
        ...(options.modality === undefined ? {} : { modality: options.modality }),
        ...(options.publisher === undefined ? {} : { publisher: options.publisher }),
        ...(options.query === undefined ? {} : { query: options.query }),
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          provider: KRUTRIM_CATALOG.provider,
          observed: KRUTRIM_CATALOG.observed,
          source: KRUTRIM_CATALOG.source,
          live: KRUTRIM_CATALOG.live,
          count: matches.length,
          models: matches,
        }, null, 2)}\n`);
        return;
      }
      process.stdout.write(
        `Krutrim production-console catalogue snapshot observed ${KRUTRIM_CATALOG.observed} ` +
          "(bundled, not live)\n",
      );
      process.stdout.write(formatModels(matches));
      process.stdout.write(`Source: ${KRUTRIM_CATALOG.source}\n`);
    },
  );

models
  .command("show")
  .description("Show one model from the bundled Krutrim Cloud catalogue snapshot")
  .argument("<model>", "console-observed model id")
  .option("--json", "emit machine-readable model metadata")
  .action((modelId: string, options: { json?: boolean }) => {
    const model = findKrutrimModel(modelId);
    if (model === undefined) {
      throw new ConfigurationError(
        `Model '${modelId}' is not in the production-console catalogue snapshot observed ` +
          `${KRUTRIM_CATALOG.observed}. ` +
          "Confirm the exact current model id in the Krutrim Cloud console.",
      );
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...model, catalogue: {
        observed: KRUTRIM_CATALOG.observed,
        source: KRUTRIM_CATALOG.source,
        live: false,
      } }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`Model: ${model.id}\n`);
    process.stdout.write(`Publisher: ${model.publisher}\n`);
    process.stdout.write(`Modality: ${model.modality}\n`);
    process.stdout.write(
      `Pricing: ₹${model.pricing.input} input, ₹${model.pricing.output} output / ${model.pricing.unit}\n`,
    );
    process.stdout.write(
      `Catalogue: production-console snapshot observed ${KRUTRIM_CATALOG.observed} (not live)\n`,
    );
    process.stdout.write(`Source: ${KRUTRIM_CATALOG.source}\n`);
  });

program
  .command("login")
  .description("Store a Krutrim model API key without displaying it")
  .option("--from-env", "read KRUTRIM_API_KEY explicitly")
  .option("--stdin", "read the API key from standard input")
  .option("--json", "emit a machine-readable storage result")
  .option(
    "--skip-validation",
    "store without the default online, non-inference credential validation",
  )
  .option(
    "--allow-file-fallback",
    "allow a plaintext credential file protected by directory mode 0700 and file mode 0600",
  )
  .action(
    async (options: {
      allowFileFallback?: boolean;
      fromEnv?: boolean;
      stdin?: boolean;
      json?: boolean;
      skipValidation?: boolean;
    }) => {
      const source = selectApiKeyInputSource({
        fromEnv: options.fromEnv === true,
        stdin: options.stdin === true,
        inputIsTTY: process.stdin.isTTY === true,
      });
      let apiKey: string;
      if (source === "environment") {
        const value = process.env.KRUTRIM_API_KEY;
        if (value === undefined) {
          throw new ConfigurationError(
            "KRUTRIM_API_KEY is not set. Set it or choose masked interactive login.",
          );
        }
        apiKey = value;
      } else if (source === "stdin") {
        apiKey = await readApiKeyInput(process.stdin);
      } else {
        if (process.env.KRUTRIM_API_KEY !== undefined) {
          process.stderr.write(
            "Notice: KRUTRIM_API_KEY is set but is not consumed implicitly; use login --from-env to select it.\n",
          );
        }
        apiKey = await promptForKrutrimApiKey();
      }

      const { secrets, codex } = await dependencies();
      const result = await storeKrutrimCredential(
        paths,
        codex,
        secrets,
        apiKey,
        options.allowFileFallback === true,
        {
          skipValidation: options.skipValidation === true,
        },
      );
      const response = {
        provider: "krutrim",
        state: "stored",
        credentialType: "model-api-key",
        backend: result.backend,
        usedFallback: result.usedFallback,
        validated: result.validation.status === "validated",
        validation: result.validation.status,
        ...(result.validation.status === "validated"
          ? {
              validationMethod: result.validation.method,
              validatedAt: result.validation.validatedAt,
            }
          : {}),
        removedStaleBackends: result.removedStaleBackends,
        cleanupFailures: result.cleanupFailures,
      };
      if (options.json) {
        process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      } else {
        process.stdout.write(
          result.validation.status === "validated"
            ? `API key validated and stored in ${result.backend}.\n`
            : `API key stored in ${result.backend}; online validation was explicitly skipped.\n`,
        );
      }
      if (result.usedFallback) {
        process.stderr.write(
          `Warning: using permission-restricted plaintext fallback at ${paths.fallbackSecretFile}.\n`,
        );
      }
      if (result.cleanupFailures.length > 0) {
        process.stderr.write(
          `Warning: could not remove stale credential copies from ${result.cleanupFailures.join(", ")}.\n`,
        );
        process.exitCode = 1;
      }
    },
  );

const auth = program
  .command("auth")
  .description("Inspect local Krutrim authentication state");

auth
  .command("status")
  .description("Show local credential state without exposing the API key")
  .option("--json", "emit machine-readable local authentication state")
  .action(async (options: { json?: boolean }) => {
    const { secrets } = await dependencies();
    const credential = await secrets.describe();
    const response = {
      provider: "krutrim",
      state: credential.present ? "stored" : "missing",
      credentialPresent: credential.present,
      credentialType: "model-api-key",
      backend: credential.backend,
      validated: credential.validation.status === "validated",
      validation: credential.validation.status,
      ...(credential.validation.status === "validated"
        ? {
            validationMethod: credential.validation.method,
            validatedAt: credential.validation.validatedAt,
          }
        : {}),
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `Authentication: ${credential.present ? "credential stored" : "not configured"}\n`,
    );
    process.stdout.write(`Credential type: Krutrim model API key\n`);
    process.stdout.write(`Backend: ${credential.backend}\n`);
    if (!credential.present) {
      process.stdout.write("Validation: not applicable; no credential is stored\n");
    } else if (credential.validation.status === "validated") {
      process.stdout.write(
        `Validation: passed at login (${credential.validation.validatedAt})\n`,
      );
    } else if (credential.validation.status === "skipped") {
      process.stdout.write("Validation: explicitly skipped at login\n");
    } else if (credential.validation.status === "invalid") {
      process.stdout.write(
        "Validation: stored evidence is invalid or does not match the credential\n",
      );
    } else {
      process.stdout.write("Validation: not performed for this legacy credential\n");
    }
  });

program
  .command("logout")
  .description("Remove every accessible local Krutrim credential copy")
  .option(
    "--disconnect",
    "disconnect Codex and OpenCode (restoring pre-connect configs) before removing credentials",
  )
  .option(
    "--force",
    "with --disconnect: snapshot externally changed harness configs before restoring baselines",
  )
  .option("--json", "emit a machine-readable removal result")
  .action(async (options: { disconnect?: boolean; force?: boolean; json?: boolean }) => {
    if (options.force === true && options.disconnect !== true) {
      throw new ConfigurationError("logout --force requires --disconnect.");
    }
    const { secrets, codex, opencode } = await dependencies();
    let harnesses: readonly { harness: string; restored: boolean }[] = [];
    let result: Awaited<ReturnType<typeof removeKrutrimCredential>>;
    if (options.disconnect === true) {
      let credentialResult: Awaited<ReturnType<typeof removeKrutrimCredential>> | undefined;
      const disconnectResult = await uninstallKrutrimConnect(
        {
          metadata: await readInstalledPackageMetadata(),
          codex,
          opencode,
          removeCredential: async () => {
            credentialResult = await removeKrutrimCredential(paths, codex, secrets);
            return credentialResult;
          },
          stopBridges: async () => {
            const codexStopped = await stopHarnessBridge(
              "codex",
              "opencode",
              await opencode.status(),
            );
            const openCodeStopped = await stopHarnessBridge(
              "opencode",
              "codex",
              await codex.status(),
            );
            return codexStopped || openCodeStopped;
          },
          removeGlobalPackage: removeGlobalPackageWithNpm,
        },
        { force: options.force === true, keepPackage: true },
      );
      harnesses = disconnectResult.harnesses;
      if (credentialResult === undefined) {
        throw new ConfigurationError("Credential removal did not run during logout --disconnect.");
      }
      result = credentialResult;
    } else {
      result = await removeKrutrimCredential(paths, codex, secrets);
    }
    const response = {
      provider: "krutrim",
      state: result.changed ? "removed" : "not-configured",
      changed: result.changed,
      disconnectedHarnesses: harnesses,
      removedBackends: result.removedBackends,
      missingBackends: result.missingBackends,
      removedBackendRecord: result.removedBackendRecord,
      remoteRevocation: "not-performed",
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return;
    }
    for (const harness of harnesses) {
      process.stdout.write(
        harness.restored
          ? `${harness.harness}: configuration restored to the pre-connect baseline.\n`
          : `${harness.harness}: already disconnected; no files changed.\n`,
      );
    }
    if (result.changed) {
      process.stdout.write("Local Krutrim credential state removed.\n");
      if (result.removedBackends.length > 0) {
        process.stdout.write(`Removed backends: ${result.removedBackends.join(", ")}\n`);
      }
    } else {
      process.stdout.write("No local Krutrim credential was configured.\n");
    }
    process.stdout.write("Remote Krutrim key revocation was not performed.\n");
  });

program
  .command("chat")
  .description("Run one guarded, potentially billable Krutrim Chat Completions request")
  .requiredOption("--model <model>", "exact Krutrim model id")
  .option(
    "--accept-inference-charges",
    "confirm that the request may consume billable input and output tokens",
  )
  .option("--max-tokens <count>", "optional maximum generated tokens", positiveInteger)
  .option("--temperature <value>", "sampling temperature from 0 to 2", temperatureValue)
  .option("--no-stream", "request a non-streaming JSON completion")
  .option("--json", "emit a machine-readable result; implies --no-stream")
  .action(
    async (options: {
      model: string;
      acceptInferenceCharges?: boolean;
      maxTokens?: number;
      temperature?: number;
      stream: boolean;
      json?: boolean;
    }) => {
      if (options.acceptInferenceCharges !== true) {
        throw new ConfigurationError(
          "Chat inference can incur charges. Re-run with --accept-inference-charges to proceed.",
        );
      }
      const { secrets } = await dependencies();
      const apiKey = await storedApiKey(secrets);
      const prompt = await readPrompt();
      const stream = options.json === true ? false : options.stream;
      let wroteDelta = false;
      let result: Awaited<ReturnType<typeof runKrutrimChatCompletion>>;
      try {
        result = await runKrutrimChatCompletion({
          model: options.model,
          prompt,
          apiKey,
          stream,
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(stream
            ? {
                onDelta: (delta: string) => {
                  wroteDelta = true;
                  process.stdout.write(delta);
                },
              }
            : {}),
        });
      } catch (error) {
        if (wroteDelta) {
          process.stdout.write("\n");
        }
        throw error;
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify(redactValue(result, [apiKey]), null, 2)}\n`);
      } else if (stream) {
        if (!result.text.endsWith("\n")) {
          process.stdout.write("\n");
        }
      } else {
        process.stdout.write(`${result.text}\n`);
      }
    },
  );

program
  .command("status")
  .description("Show Codex connection state without exposing credentials")
  .action(async () => {
    const { secrets, codex, opencode } = await dependencies();
    const credentialResult = await secrets.inspect().then(
      (credential) => ({ ok: true as const, credential }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const outputSecrets = credentialResult.ok && credentialResult.credential.secret !== null
      ? [credentialResult.credential.secret]
      : [];
    const safe = (value: string): string => redactText(value, outputSecrets);
    let status: Awaited<ReturnType<CodexHarness["status"]>>;
    try {
      status = await codex.status();
    } catch (error) {
      throw new ConfigurationError(
        safe(error instanceof Error ? error.message : String(error)),
      );
    }
    process.stdout.write(`Codex base config: ${status.state}\n`);
    process.stdout.write(
      `Model: ${status.model === undefined
        ? "not selected"
        : credentialResult.ok
          ? safe(status.model)
          : "[hidden: credential unavailable]"}\n`,
    );
    if (status.connectionMode !== undefined) {
      process.stdout.write(`Connection mode: ${status.connectionMode}\n`);
    }
    if (status.modelContextWindow !== undefined) {
      process.stdout.write(`Model context window: ${status.modelContextWindow} tokens\n`);
    }
    if (status.modelCatalogPath !== undefined) {
      process.stdout.write(`Managed model catalogue: ${safe(status.modelCatalogPath)}\n`);
    }
    process.stdout.write(`Configuration source: ${safe(status.configSource)} (${safe(status.configPath)})\n`);
    if (credentialResult.ok) {
      const { credential } = credentialResult;
      process.stdout.write(
        `Credential: ${credential.present ? `present in ${credential.backend}` : "missing"}\n`,
      );
    } else {
      process.stdout.write(
        `Credential: unavailable (${safe(credentialResult.error instanceof Error ? credentialResult.error.message : String(credentialResult.error))})\n`,
      );
      process.exitCode = 1;
    }
    if (status.model !== undefined) {
      try {
        if (!credentialResult.ok) {
          process.stdout.write("Capability evidence: unavailable while the credential backend cannot be read\n");
        } else if (credentialResult.credential.secret === null) {
          process.stdout.write("Capability evidence: unavailable without a stored credential\n");
        } else {
          if (status.connectionMode === "bridge") {
            const resolution = await resolveKrutrimBridgeForModel(
              paths,
              status.model,
              credentialResult.credential.secret,
            );
            process.stdout.write(`Bridge evidence: ${resolution.status} (${safe(resolution.detail)})\n`);
            const runtime = await readBridgeRuntimeForOwner(paths, "codex");
            process.stdout.write(
              `Local bridge: ${runtime !== null && await bridgeIsHealthy(runtime) ? "healthy" : "unavailable"}\n`,
            );
          } else {
            const { resolution } = await resolveKrutrimProviderForModel(
              paths,
              status.model,
              credentialResult.credential.secret,
            );
            process.stdout.write(`Capability evidence: ${resolution.status} (${safe(resolution.detail)})\n`);
          }
        }
      } catch (error) {
        process.stdout.write(
          `Capability evidence: unavailable (${safe(error instanceof Error ? error.message : String(error))})\n`,
        );
        process.exitCode = 1;
      }
    }
    process.stdout.write(`${safe(status.detail)}\n`);
    const openCodeStatus = await opencode.status();
    process.stdout.write(`OpenCode global config: ${openCodeStatus.state}\n`);
    if (openCodeStatus.model !== undefined) {
      process.stdout.write(`OpenCode model: ${credentialResult.ok ? safe(openCodeStatus.model) : "[hidden: credential unavailable]"}\n`);
    }
    process.stdout.write(`OpenCode configuration source: ${safe(openCodeStatus.configPath)}\n`);
    if (openCodeStatus.state === "connected" && openCodeStatus.model !== undefined) {
      const runtime = await readBridgeRuntimeForOwner(paths, "opencode");
      const bridgeReady = runtime !== null &&
        runtime.model === openCodeStatus.model &&
        await bridgeIsHealthy(runtime);
      let launchReady = false;
      if (runtime !== null && credentialResult.ok && credentialResult.credential.secret !== null) {
        launchReady = await openCodeLaunchCredentialMatches(
          paths.openCodeBridgeCredentialFile,
          deriveBridgeBearer(credentialResult.credential.secret, runtime.instanceId),
        );
      }
      process.stdout.write(`OpenCode local bridge: ${bridgeReady ? "healthy" : "unavailable"}\n`);
      process.stdout.write(
        `Plain OpenCode launch: ${bridgeReady && launchReady ? "ready (run 'opencode')" : "not ready; re-run 'krutrimconnect opencode on --model <model>'"}\n`,
      );
    }
    process.stdout.write(`${safe(openCodeStatus.detail)}\n`);
  });

program
  .command("doctor")
  .description("Run non-destructive config, credential, reachability, and capability checks")
  .option("--json", "emit a machine-readable redacted report")
  .option("--model <model>", "read model-bound capability evidence without running inference")
  .action(async (options: { json?: boolean; model?: string }) => {
    const { secrets, codex } = await dependencies();
    const credentialResult = await secrets.inspect().then(
      (credential) => ({ ok: true as const, credential }),
      () => ({ ok: false as const }),
    );
    const apiKey = credentialResult.ok ? credentialResult.credential.secret : null;
    let provider = krutrimProvider;
    let capabilityOverride: ReturnType<typeof bridgeCapabilities> | undefined;
    let capabilityScopeMessage: string | undefined;
    let model = options.model;
    if (model === undefined) {
      const active = await codex.status().catch(() => undefined);
      if (active?.state === "connected") {
        model = active.model;
      }
    }
    if (model !== undefined && apiKey !== null) {
      const decision = await decideCodexRoute(paths, model, apiKey);
      if (decision.mode === "native" && decision.provider !== undefined) {
        provider = decision.provider;
      } else if (decision.mode === "bridge") {
        capabilityOverride = bridgeCapabilities();
        capabilityScopeMessage =
          `${options.model === undefined ? "Active" : "Requested"} exact-model streaming local-bridge evidence with a passing full Codex canary was resolved. No inference was run.`;
      } else {
        provider = (await resolveKrutrimProviderForModel(paths, model, apiKey)).provider;
      }
    }
    const report = await runDoctor({
      paths,
      provider,
      harness: codex,
      secrets,
      ...(model === undefined ? {} : { model }),
      ...(capabilityOverride === undefined ? {} : { capabilityOverride }),
      ...(capabilityScopeMessage === undefined ? {} : { capabilityScopeMessage }),
    });
    const safeReport = redactValue(report, apiKey === null ? [] : [apiKey]) as typeof report;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(safeReport, null, 2)}\n`);
    } else {
      for (const check of safeReport.checks) {
        process.stdout.write(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.message}\n`);
      }
    }
    if (!report.ok) {
      process.exitCode = 1;
    }
  });

const codex = program.command("codex").description("Manage the Codex connection to Krutrim Cloud");

const openCode = program
  .command("opencode")
  .description("Manage the OpenCode connection to Krutrim Cloud");

const bridge = program
  .command("bridge", { hidden: true })
  .description("Assess and manage local Responses-to-Chat compatibility");

bridge
  .command("probe")
  .description("Run Chat tool probes plus a billable full Codex bridge canary")
  .requiredOption("--model <model>", "exact Krutrim model id")
  .option(
    "--accept-inference-charges",
    "confirm that accepted probe requests may consume billable input and output tokens",
  )
  .option("--json", "emit a machine-readable redacted report")
  .action(
    async (options: {
      model: string;
      acceptInferenceCharges?: boolean;
      json?: boolean;
    }) => {
      if (options.acceptInferenceCharges !== true) {
        throw new ConfigurationError(
          "The bridge probe and full Codex canary can incur inference charges. Re-run with --accept-inference-charges to proceed.",
        );
      }
      const { secrets } = await dependencies();
      const result = await runBridgeQualificationAttempts(
        async () => await probeAndStoreKrutrimBridgeCapabilities(paths, {
          model: options.model,
          apiKey: async () => await storedApiKey(secrets),
        }),
        (attempt) => attempt.report,
      );
      if (options.json) {
        process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
      } else {
        process.stdout.write(`Bridge probe result: ${result.report.outcome}\n`);
        process.stdout.write(`Model: ${result.report.model}\n`);
        for (const [name, check] of Object.entries(result.report.checks)) {
          process.stdout.write(`${check.status.toUpperCase().padEnd(12)} ${name}: ${check.detail}\n`);
        }
        process.stdout.write(`Model-bound bridge evidence: ${result.evidencePath}\n`);
        if (result.report.outcome === "streaming-compatible") {
          process.stdout.write(
            "The model passed streaming Chat tools and a real full Codex request through the local bridge.\n",
          );
        } else if (result.report.outcome === "buffered-compatible") {
          process.stdout.write(
            "Buffered Chat tool calling was observed, but it does not qualify for Codex streaming.\n",
          );
        } else {
          process.stdout.write("The latest probe did not establish a usable local bridge mode.\n");
        }
      }
      if (result.report.outcome !== "streaming-compatible") {
        process.exitCode = 1;
      }
    },
  );

codex
  .command("probe", { hidden: true })
  .description("Probe native Responses first, then automatic Chat-bridge compatibility if needed")
  .requiredOption("--model <model>", "exact Krutrim model id")
  .option(
    "--accept-inference-charges",
    "confirm that accepted probe requests may consume billable input and output tokens",
  )
  .option("--json", "emit a machine-readable redacted report")
  .action(
    async (options: {
      model: string;
      acceptInferenceCharges?: boolean;
      json?: boolean;
    }) => {
      if (options.acceptInferenceCharges !== true) {
        throw new ConfigurationError(
          "The authenticated probe can incur inference charges. Re-run with --accept-inference-charges to proceed.",
        );
      }
      const { secrets } = await dependencies();
      const apiKey = await storedApiKey(secrets);
      const native = await probeAndStoreKrutrimCapabilities(paths, {
        model: options.model,
        apiKey,
      });
      const mayProbeBridge =
        native.report.outcome !== "passed" &&
        native.report.checks.authentication.status === "pass";
      const bridged = mayProbeBridge
        ? await runBridgeQualificationAttempts(
            async () => await probeAndStoreKrutrimBridgeCapabilities(paths, {
              model: options.model,
              apiKey,
            }),
            (attempt) => attempt.report,
          )
        : undefined;
      const selectedMode = native.report.outcome === "passed"
        ? "native"
        : bridged?.report.outcome === "streaming-compatible"
          ? "bridge"
          : undefined;
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          model: native.report.model,
          selectedMode: selectedMode ?? null,
          native: native.report,
          bridge: bridged?.report ?? null,
        }, null, 2)}\n`);
      } else {
        process.stdout.write(`Native probe result: ${native.report.outcome}\n`);
        process.stdout.write(`Model: ${native.report.model}\n`);
        for (const [name, check] of Object.entries(native.report.checks)) {
          process.stdout.write(`${check.status.toUpperCase().padEnd(7)} ${name}: ${check.detail}\n`);
        }
        process.stdout.write(`Native model-bound evidence: ${native.evidencePath}\n`);
        process.stdout.write(`${native.resolution.detail}\n`);
        if (bridged !== undefined) {
          process.stdout.write(`Bridge probe result: ${bridged.report.outcome}\n`);
          for (const [name, check] of Object.entries(bridged.report.checks)) {
            process.stdout.write(`${check.status.toUpperCase().padEnd(12)} ${name}: ${check.detail}\n`);
          }
          process.stdout.write(`Bridge model-bound evidence: ${bridged.evidencePath}\n`);
        }
        process.stdout.write(
          selectedMode === undefined
            ? "No usable Codex route was established.\n"
            : `Codex route established: ${selectedMode}.\n`,
        );
      }
      if (selectedMode === undefined) {
        process.exitCode = 1;
      }
    },
  );

codex
  .command("on")
  .description("Connect Codex to a compatible Krutrim Cloud model")
  .requiredOption("--model <model>", "exact Krutrim model id")
  .action(async (options: { model: string }) => {
    const { secrets, opencode } = await dependencies();
    const apiKey = await storedApiKey(secrets);
    const qualification = await qualifyCodexRoute(paths, options.model, apiKey, {
      onStage: (stage) => {
        process.stdout.write(
          stage === "native"
            ? `Checking ${options.model} compatibility with Codex; first-time qualification may incur inference charges.\n`
            : "Continuing Codex compatibility checks with another supported connection method.\n",
        );
      },
    });
    if (qualification.decision.mode === undefined) {
      const failedChecks = [
        ...Object.entries(qualification.nativeProbe?.checks ?? {}),
        ...Object.entries(qualification.bridgeProbe?.checks ?? {}),
      ]
        .filter(([, check]) => check.status === "fail" || check.status === "inconclusive")
        .map(([name, check]) => `${name}: ${check.detail}`);
      throw new CapabilityError(
        `Could not connect Codex to '${options.model}'. Automatic compatibility qualification ` +
          "did not establish a supported connection method. " +
          `${failedChecks.join(" ") || qualification.decision.native.detail} ` +
          "No configuration was changed.",
      );
    }
    const result = await enableCodexAutomatically(
      paths,
      cliEntrypoint,
      secrets,
      options.model,
    );
    if (result.mode === "native") {
      await stopHarnessBridge(
        "codex",
        "opencode",
        await opencode.status(),
      );
    }
    if (!result.changed) {
      process.stdout.write(
        `Codex is already connected to ${result.model}; no files changed.\n`,
      );
      process.stdout.write(
        "New Codex sessions use this default; already-open or resumed sessions keep their selected model.\n",
      );
      if (result.modelCatalogPath !== undefined) {
        process.stdout.write(`Managed model catalogue: ${result.modelCatalogPath}\n`);
      }
      return;
    }
    process.stdout.write(`Codex connected to ${result.model}.\n`);
    process.stdout.write(`Configuration: ${result.configPath}\n`);
    process.stdout.write(`Pre-change snapshot: ${result.snapshotPath}\n`);
    if (result.modelCatalogPath !== undefined) {
      process.stdout.write(`Managed model catalogue: ${result.modelCatalogPath}\n`);
    }
    if (result.modelContextWindow !== undefined) {
      process.stdout.write(`Krutrim model context window: ${result.modelContextWindow} tokens\n`);
    }
    process.stdout.write(
      "New Codex sessions use this default; already-open or resumed sessions keep their selected model.\n",
    );
  });

codex
  .command("off")
  .description("Restore the exact pre-connect Codex configuration")
  .option("--force", "snapshot externally changed config before restoring the exact baseline")
  .action(async (options: { force?: boolean }) => {
    const { codex: harness, opencode } = await dependencies();
    const result = await harness.disable({ force: options.force === true });
    const stoppedBridge = await stopHarnessBridge(
      "codex",
      "opencode",
      await opencode.status(),
    );
    if (!result.changed) {
      process.stdout.write(
        stoppedBridge
          ? "Codex was already disconnected; background connection cleanup completed.\n"
          : "Codex is already disconnected; no files changed.\n",
      );
      return;
    }
    process.stdout.write(`Codex configuration restored from ${result.restoredSnapshotPath}.\n`);
    if (result.rescueSnapshotPath) {
      process.stdout.write(`Externally changed config was preserved at ${result.rescueSnapshotPath}.\n`);
    }
    if (result.preservedCatalogPath) {
      process.stdout.write(
        `Modified or unsafe managed model catalogue was preserved at ${result.preservedCatalogPath}.\n`,
      );
    }
  });

openCode
  .command("on")
  .description("Connect OpenCode to a compatible Krutrim Cloud model")
  .requiredOption("--model <model>", "exact Krutrim model id")
  .action(async (options: { model: string }) => {
    const { secrets } = await dependencies();
    const apiKey = await storedApiKey(secrets);
    const qualification = await qualifyBridgeRoute(paths, options.model, apiKey, {
      onStage: () => {
        process.stdout.write(
          `Checking ${options.model} compatibility with OpenCode; first-time qualification may incur inference charges.\n`,
        );
      },
    });
    if (!qualification.resolution.usable) {
      const failedChecks = Object.entries(qualification.bridgeProbe?.checks ?? {})
        .filter(([, check]) => check.status === "fail" || check.status === "inconclusive")
        .map(([name, check]) => `${name}: ${check.detail}`);
      throw new CapabilityError(
        `Could not connect OpenCode to '${options.model}'. Automatic compatibility qualification ` +
          "did not establish a supported connection method. " +
          `${failedChecks.join(" ") || qualification.resolution.detail} ` +
          "No configuration was changed.",
      );
    }
    const result = await enableOpenCodeAutomatically(paths, cliEntrypoint, secrets, options.model);
    process.stdout.write(
      result.changed
        ? `OpenCode connected to ${result.model}.\n`
        : `OpenCode is already connected to ${result.model}; no files changed.\n`,
    );
    process.stdout.write(`Configuration: ${result.configPath}\n`);
    if (result.snapshotPath !== undefined) {
      process.stdout.write(`Pre-change snapshot: ${result.snapshotPath}\n`);
    }
    process.stdout.write("OpenCode is ready. Start it normally with 'opencode'.\n");
    process.stdout.write("You can also launch it with 'krutrimconnect opencode run'.\n");
  });

openCode
  .command("off")
  .description("Restore the exact pre-connect OpenCode global configuration")
  .option("--force", "snapshot externally changed config before restoring the exact baseline")
  .action(async (options: { force?: boolean }) => {
    const { codex, opencode } = await dependencies();
    const result = await opencode.disable({ force: options.force === true });
    const stoppedBridge = await stopHarnessBridge(
      "opencode",
      "codex",
      await codex.status(),
    );
    if (!result.changed) {
      process.stdout.write(
        stoppedBridge
          ? "OpenCode was already disconnected; background connection cleanup completed.\n"
          : "OpenCode is already disconnected; no files changed.\n",
      );
      return;
    }
    process.stdout.write(`OpenCode configuration restored from ${result.restoredSnapshotPath}.\n`);
    if (result.rescueSnapshotPath !== undefined) {
      process.stdout.write(`Externally changed config was preserved at ${result.rescueSnapshotPath}.\n`);
    }
  });

openCode
  .command("status")
  .description("Show OpenCode connection state without exposing credentials")
  .action(async () => {
    const { secrets, opencode } = await dependencies();
    const status = await opencode.status();
    process.stdout.write(`OpenCode global config: ${status.state}\n`);
    if (status.model !== undefined) {
      process.stdout.write(`Model: ${status.model}\n`);
    }
    process.stdout.write(`Configuration source: ${status.configPath}\n`);
    if (status.state === "connected" && status.model !== undefined) {
      const runtime = await readBridgeRuntimeForOwner(paths, "opencode");
      const bridgeReady = runtime !== null &&
        runtime.model === status.model &&
        await bridgeIsHealthy(runtime);
      let credentialReady = false;
      if (runtime !== null) {
        try {
          credentialReady = await openCodeLaunchCredentialMatches(
            paths.openCodeBridgeCredentialFile,
            await bridgeCredential(secrets, runtime.instanceId),
          );
        } catch {
          credentialReady = false;
        }
      }
      process.stdout.write(`Local bridge: ${bridgeReady ? "running" : "unavailable"}\n`);
      process.stdout.write(
        `Plain OpenCode launch: ${bridgeReady && credentialReady ? "ready (run 'opencode')" : "not ready; re-run 'krutrimconnect opencode on --model <model>'"}\n`,
      );
    }
    process.stdout.write(`${status.detail}\n`);
  });

openCode
  .command("run [args...]")
  .description("Launch OpenCode with Krutrim Connect; forwards all arguments to OpenCode")
  .allowUnknownOption(true)
  .action(async (args: string[] = []) => {
    await runOpenCode(args);
  });

program
  .command("_credential", { hidden: true })
  .argument("<action>")
  .requiredOption("--app-home <path>")
  .option("--instance <id>")
  .action(async (action: string, options: { appHome: string; instance?: string }) => {
    if (action !== "read" && action !== "bridge") {
      throw new KrutrimConnectError("INVALID_HELPER_ACTION", "Invalid credential helper action.");
    }
    const helperPaths = resolveRuntimePaths({
      ...process.env,
      KRUTRIM_CONNECT_HOME: options.appHome,
    });
    const { secrets } = await dependencies(helperPaths);
    if (action === "bridge") {
      if (options.instance === undefined || options.instance.length === 0) {
        throw new KrutrimConnectError("INVALID_HELPER_ACTION", "Bridge credential helper requires an instance id.");
      }
      process.stdout.write(await bridgeCredential(secrets, options.instance));
      return;
    }
    process.stdout.write(await storedApiKey(secrets));
  });

program
  .command("_bridge", { hidden: true })
  .argument("<action>")
  .requiredOption("--model <model>")
  .requiredOption("--instance <id>")
  .requiredOption("--app-home <path>")
  .requiredOption("--owner <owner>")
  .action(
    async (
      action: string,
      options: { model: string; instance: string; appHome: string; owner: string },
    ) => {
      if (action !== "serve") {
        throw new KrutrimConnectError("INVALID_BRIDGE_ACTION", "Invalid local bridge action.");
      }
      if (options.owner !== "codex" && options.owner !== "opencode") {
        throw new KrutrimConnectError(
          "INVALID_BRIDGE_ACTION",
          "Invalid local bridge owner.",
        );
      }
      const owner: BridgeRuntimeOwner = options.owner;
      const runtimePaths = resolveRuntimePaths({
        ...process.env,
        KRUTRIM_CONNECT_HOME: options.appHome,
      });
      await serveBridgeRuntime(
        bridgeRuntimeFileFor(runtimePaths, owner),
        krutrimProvider.resolveModel(options.model).id,
        options.instance,
        async () => {
          const { secrets } = await dependencies(runtimePaths);
          return await storedApiKey(secrets);
        },
      );
    },
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${redactText(message)}\n`);
  process.exitCode = error instanceof KrutrimConnectError ? 2 : 1;
});
