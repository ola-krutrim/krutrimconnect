import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import {
  managedCodexModelCatalogIsIntact,
  prepareCodexModelCatalog,
  removeManagedCodexModelCatalog,
  type CodexConnectionCatalogMode,
  type CodexCatalogTemplateLoader,
  type KrutrimModelMetadataResolver,
  type PreparedCodexModelCatalog,
} from "../codex/model-catalog.js";
import {
  CODEX_PROVIDER_ID,
  configuredKrutrimModel,
  mappingMatches,
  mergeCodexMapping,
  parseCodexToml,
  rebaseCodexRollbackSource,
  type CodexManagedMapping,
  type CredentialHelperConfig,
} from "../config/codex-toml.js";
import {
  AtomicWriteError,
  CapabilityError,
  ConfigurationError,
  SecretStoreError,
} from "../errors.js";
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  removeFileDurably,
  sha256,
  withFileLock,
} from "../fs/atomic.js";
import type { RuntimePaths } from "../paths.js";
import type { ProviderAdapter, ProviderCapabilities } from "../providers/types.js";
import type { SecretReader } from "../secrets/types.js";
import { createSnapshot, readConfigFile, readVerifiedSnapshot } from "../snapshots.js";
import {
  readState,
  writeState,
  type AppState,
  type CodexConnectionRecord,
  type CodexTransactionRecord,
} from "../state.js";
import type {
  CodingToolHarness,
  DisableResult,
  EnableResult,
  HarnessStatus,
} from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeConfig(content: Uint8Array): string {
  try {
    return decoder.decode(content);
  } catch (error) {
    throw new ConfigurationError("Codex config is not valid UTF-8.", { cause: error });
  }
}

export class CodexHarness implements CodingToolHarness {
  readonly id = "codex";
  readonly displayName = "Codex";
  readonly requiredCapabilities = [
    { name: "responsesApi", reason: "Codex custom providers use only the Responses wire API." },
    { name: "streaming", reason: "Codex requires Responses SSE and streamed tool-call deltas." },
    { name: "toolCalling", reason: "Codex requires model tool calls for its coding-agent loop." },
  ] as const;

  readonly #paths: RuntimePaths;
  readonly #secrets: SecretReader;
  readonly #helper: CredentialHelperConfig;
  readonly #beforeConfigMutation: (() => Promise<void>) | undefined;
  readonly #connectionMode: CodexConnectionCatalogMode;
  readonly #metadataResolver: KrutrimModelMetadataResolver | undefined;
  readonly #catalogTemplateLoader: CodexCatalogTemplateLoader | undefined;

  constructor(
    paths: RuntimePaths,
    secrets: SecretReader,
    helper: CredentialHelperConfig,
    options: {
      beforeConfigMutation?: () => Promise<void>;
      connectionMode?: CodexConnectionCatalogMode;
      metadataResolver?: KrutrimModelMetadataResolver;
      catalogTemplateLoader?: CodexCatalogTemplateLoader;
    } = {},
  ) {
    this.#paths = paths;
    this.#secrets = secrets;
    this.#helper = helper;
    this.#beforeConfigMutation = options.beforeConfigMutation;
    this.#connectionMode = options.connectionMode ?? "native";
    this.#metadataResolver = options.metadataResolver;
    this.#catalogTemplateLoader = options.catalogTemplateLoader;
  }

  #mapping(
    provider: ProviderAdapter,
    model: string,
    modelCatalogPath: string,
  ): CodexManagedMapping {
    return {
      model,
      providerId: CODEX_PROVIDER_ID,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      modelCatalogPath,
      helper: this.#helper,
    };
  }

  async #prepareCatalog(model: string, apiKey: string): Promise<PreparedCodexModelCatalog> {
    return await prepareCodexModelCatalog(this.#paths, {
      model,
      apiKey,
      mode: this.#connectionMode,
      ...(this.#metadataResolver === undefined ? {} : { metadataResolver: this.#metadataResolver }),
      ...(this.#catalogTemplateLoader === undefined
        ? {}
        : { templateLoader: this.#catalogTemplateLoader }),
    });
  }

  async #catalogIsIntact(record: CodexConnectionRecord): Promise<boolean> {
    return (
      typeof record.modelCatalogPath === "string" &&
      typeof record.modelCatalogSha256 === "string" &&
      await managedCodexModelCatalogIsIntact(
        this.#paths,
        record.modelCatalogPath,
        record.modelCatalogSha256,
      )
    );
  }

  #assertCapabilities(capabilities: ProviderCapabilities): void {
    const missing = this.requiredCapabilities.filter(
      (requirement) => capabilities[requirement.name].support !== "supported",
    );
    if (missing.length > 0) {
      const details = missing
        .map((item) => `${item.name}=${capabilities[item.name].support}`)
        .join(", ");
      throw new CapabilityError(
        `Codex activation is blocked because required Krutrim capabilities are not verified (${details}). Run the explicit krutrimconnect codex probe for this exact model, then inspect krutrimconnect doctor --model. See docs/phase-2-conformance.md. No config was changed.`,
      );
    }
  }

  async #codexHomeExistsSafely(): Promise<boolean> {
    try {
      const info = await lstat(this.#paths.codexHome);
      if (info.isSymbolicLink()) {
        throw new ConfigurationError(`Refusing to use a symlinked CODEX_HOME: ${this.#paths.codexHome}`);
      }
      if (!info.isDirectory()) {
        throw new ConfigurationError(`CODEX_HOME is not a directory: ${this.#paths.codexHome}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async #ensureCodexHomeForWrite(): Promise<void> {
    if (await this.#codexHomeExistsSafely()) {
      return;
    }
    await ensurePrivateDirectory(this.#paths.codexHome);
    if (!(await this.#codexHomeExistsSafely())) {
      throw new ConfigurationError(`Could not create a safe CODEX_HOME: ${this.#paths.codexHome}`);
    }
  }

  #stateWithConnection(
    state: AppState,
    connection: CodexConnectionRecord | undefined,
  ): AppState {
    const next: AppState = { ...state };
    delete next.codexTransaction;
    delete next.codex;
    if (connection) {
      next.codex = connection;
    }
    return next;
  }

  async #recoverTransaction(): Promise<AppState> {
    const state = await readState(this.#paths.stateFile);
    const transaction = state.codexTransaction;
    if (!transaction) {
      return state;
    }
    if (transaction.configPath !== this.#paths.codexConfig) {
      throw new ConfigurationError("Pending Codex transaction refers to a different configuration path.");
    }

    const current = await readConfigFile(this.#paths.codexConfig);
    let recovered: AppState;
    if (current.sha256 === transaction.afterSha256) {
      recovered = this.#stateWithConnection(state, transaction.nextCodex);
    } else if (current.sha256 === transaction.beforeSha256) {
      recovered = this.#stateWithConnection(state, transaction.previousCodex);
    } else {
      throw new ConfigurationError(
        "Codex config changed during an interrupted KrutrimConnect transaction; refusing automatic recovery.",
      );
    }
    await writeState(this.#paths.stateFile, this.#paths.appHome, recovered);
    return recovered;
  }

  #transaction(
    operation: CodexTransactionRecord["operation"],
    beforeSha256: string | null,
    afterSha256: string | null,
    previousCodex: CodexConnectionRecord | undefined,
    nextCodex: CodexConnectionRecord | undefined,
  ): CodexTransactionRecord {
    const transaction: CodexTransactionRecord = {
      id: randomUUID(),
      operation,
      preparedAt: new Date().toISOString(),
      configPath: this.#paths.codexConfig,
      beforeSha256,
      afterSha256,
    };
    if (previousCodex) {
      transaction.previousCodex = previousCodex;
    }
    if (nextCodex) {
      transaction.nextCodex = nextCodex;
    }
    return transaction;
  }

  async #runTransaction(
    state: AppState,
    transaction: CodexTransactionRecord,
    mutation: () => Promise<void>,
  ): Promise<void> {
    await writeState(this.#paths.stateFile, this.#paths.appHome, {
      ...state,
      codexTransaction: transaction,
    });
    try {
      await this.#beforeConfigMutation?.();
      await mutation();
    } catch (error) {
      if (error instanceof AtomicWriteError && error.committed) {
        await this.#recoverTransaction();
      } else {
        const rolledBack = { ...state };
        delete rolledBack.codexTransaction;
        await writeState(this.#paths.stateFile, this.#paths.appHome, rolledBack);
      }
      throw error;
    }
    await this.#recoverTransaction();
  }

  async status(): Promise<HarnessStatus> {
    const initialState = await readState(this.#paths.stateFile);
    const homeExists = await this.#codexHomeExistsSafely();
    if (!homeExists && !initialState.codex && !initialState.codexTransaction) {
      return await this.#statusFromState(initialState);
    }
    if (!homeExists) {
      await this.#ensureCodexHomeForWrite();
    }
    const lockPath = path.join(this.#paths.codexHome, ".krutrim-connect.lock");
    return await withFileLock(lockPath, async () =>
      await this.#statusFromState(await this.#recoverTransaction()),
    );
  }

  async #statusFromState(state: AppState): Promise<HarnessStatus> {
    const current = await readConfigFile(this.#paths.codexConfig);
    const source = current.existed ? decodeConfig(current.content) : "";
    if (current.existed) {
      parseCodexToml(source);
    }

    if (state.codex) {
      if (state.codex.configPath !== this.#paths.codexConfig) {
        return this.#statusResult("drifted", state.codex.model, "Saved state points to a different config path.");
      }
      const savedMapping: CodexManagedMapping = {
        model: state.codex.model,
        providerId: state.codex.providerId,
        displayName: state.codex.providerName,
        baseUrl: state.codex.baseUrl,
        modelCatalogPath: state.codex.modelCatalogPath ?? "",
        helper: { command: state.codex.helperCommand, args: state.codex.helperArgs },
      };
      const exact = current.sha256 === state.codex.connectedSha256;
      const semantic = current.existed && mappingMatches(source, savedMapping);
      const catalogIntact = await this.#catalogIsIntact(state.codex);
      const connectionMode = state.codex.baseUrl.startsWith("http://127.0.0.1:")
        ? "bridge"
        : "native";
      return exact && semantic && catalogIntact
        ? this.#statusResult(
            "connected",
            state.codex.model,
            "Managed base user config is present; profiles, CLI flags, project model overrides, or managed policy may change the effective model.",
            connectionMode,
            state.codex.modelCatalogPath,
            state.codex.modelContextWindow,
          )
        : this.#statusResult(
            "drifted",
            state.codex.model,
            !catalogIntact
              ? "Managed Codex model catalogue is missing, modified, unsafe, or belongs to legacy state. Re-run activation to repair it; disconnect remains available."
              : semantic
                ? "Managed provider values are intact, but unrelated base user config changed after activation. Repeating the same activation is safe; updates and disconnects remain blocked."
                : "Managed provider values changed after activation.",
            semantic && catalogIntact ? connectionMode : undefined,
            state.codex.modelCatalogPath,
            state.codex.modelContextWindow,
          );
    }

    const unmanagedModel = current.existed ? configuredKrutrimModel(source) : undefined;
    return unmanagedModel
      ? this.#statusResult("unmanaged", unmanagedModel, "Krutrim provider values exist without rollback state.")
      : this.#statusResult("disconnected", undefined, "No managed Krutrim base configuration is present.");
  }

  #statusResult(
    state: HarnessStatus["state"],
    model: string | undefined,
    detail: string,
    connectionMode?: HarnessStatus["connectionMode"],
    modelCatalogPath?: string,
    modelContextWindow?: number,
  ): HarnessStatus {
    const result: HarnessStatus = {
      harness: this.id,
      state,
      configPath: this.#paths.codexConfig,
      configSource: "base user-level $CODEX_HOME/config.toml",
      detail,
      ...(connectionMode === undefined ? {} : { connectionMode }),
      ...(modelCatalogPath === undefined ? {} : { modelCatalogPath }),
      ...(modelContextWindow === undefined ? {} : { modelContextWindow }),
    };
    if (model !== undefined) {
      result.model = model;
    }
    return result;
  }

  async enable(provider: ProviderAdapter, requestedModel: string): Promise<EnableResult> {
    const resolvedModel = provider.resolveModel(requestedModel);
    const model = resolvedModel.id;
    this.#assertCapabilities(provider.capabilitiesFor(resolvedModel));
    const apiKey = await this.#secrets.read();
    if (apiKey === null) {
      throw new SecretStoreError("No Krutrim API key is stored. Run krutrimconnect login first.");
    }

    await this.#ensureCodexHomeForWrite();
    const lockPath = path.join(this.#paths.codexHome, ".krutrim-connect.lock");
    return await withFileLock(lockPath, async () => {
      const state = await this.#recoverTransaction();
      const current = await readConfigFile(this.#paths.codexConfig);
      const source = decodeConfig(current.content);
      const catalog = await this.#prepareCatalog(model, apiKey);
      const mapping = this.#mapping(provider, model, catalog.path);
      try {
        if (state.codex) {
          return await this.#updateExistingConnection(
            state,
            state.codex,
            current,
            source,
            mapping,
            catalog,
          );
        }

        const updatedSource = mergeCodexMapping(source, mapping, { allowExistingProvider: false });
        const baseline = await createSnapshot(
          this.#paths.codexConfig,
          this.#paths.snapshotsDir,
          "pre-connect",
          current,
        );
        const updatedHash = sha256(updatedSource);
        const record: CodexConnectionRecord = {
          providerId: mapping.providerId,
          providerName: mapping.displayName,
          baseUrl: mapping.baseUrl,
          model,
          configPath: this.#paths.codexConfig,
          baseline,
          connectedSha256: updatedHash,
          activatedAt: new Date().toISOString(),
          helperCommand: this.#helper.command,
          helperArgs: this.#helper.args,
          modelCatalogPath: catalog.path,
          modelCatalogSha256: catalog.sha256,
          modelContextWindow: catalog.contextWindow,
          safetySnapshots: [],
        };
        await this.#runTransaction(
          state,
          this.#transaction("enable", current.sha256, updatedHash, undefined, record),
          async () => {
            await atomicWriteFile(this.#paths.codexConfig, updatedSource, {
              mode: current.mode ?? 0o600,
              expectedSha256: current.sha256,
            });
          },
        );
        return {
          changed: true,
          configPath: this.#paths.codexConfig,
          model,
          snapshotPath: baseline.path,
          modelCatalogPath: catalog.path,
          modelContextWindow: catalog.contextWindow,
        };
      } catch (error) {
        if (catalog.created) {
          await removeManagedCodexModelCatalog(
            this.#paths,
            catalog.path,
            catalog.sha256,
          ).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async #updateExistingConnection(
    state: AppState,
    record: CodexConnectionRecord,
    current: Awaited<ReturnType<typeof readConfigFile>>,
    source: string,
    mapping: CodexManagedMapping,
    catalog: PreparedCodexModelCatalog,
  ): Promise<EnableResult> {
    if (record.configPath !== this.#paths.codexConfig) {
      throw new ConfigurationError("Saved Codex state refers to a different configuration source.");
    }
    const catalogIntact = await this.#catalogIsIntact(record);
    if (record.model === mapping.model && mappingMatches(source, mapping) && catalogIntact) {
      // Codex may add unrelated settings (for example, a project trust entry)
      // after activation. Repeating an already-satisfied activation does not
      // overwrite those edits and therefore remains a safe no-op.
      return {
        changed: false,
        configPath: this.#paths.codexConfig,
        model: mapping.model,
        modelCatalogPath: mapping.modelCatalogPath,
        modelContextWindow: catalog.contextWindow,
      };
    }
    const savedMapping: CodexManagedMapping = {
      model: record.model,
      providerId: record.providerId,
      displayName: record.providerName,
      baseUrl: record.baseUrl,
      modelCatalogPath: record.modelCatalogPath ?? "",
      helper: { command: record.helperCommand, args: record.helperArgs },
    };
    const configDrifted = current.sha256 !== record.connectedSha256;
    const managedMappingIntact = mappingMatches(source, savedMapping);
    if (configDrifted && (!catalogIntact || !managedMappingIntact)) {
      throw new ConfigurationError(
        "Krutrim-managed Codex values or the managed model catalogue changed after activation. Refusing automatic repair; run status and reconcile the managed drift first.",
      );
    }

    const updatedSource = mergeCodexMapping(source, mapping, { allowExistingProvider: true });
    const safety = await createSnapshot(
      this.#paths.codexConfig,
      this.#paths.snapshotsDir,
      "pre-update",
      current,
    );
    let rollbackBaseline = record.baseline;
    let safetySnapshots = record.safetySnapshots;
    if (configDrifted) {
      const originalBaseline = decodeConfig(await readVerifiedSnapshot(record.baseline));
      const rebasedRollback = Buffer.from(
        rebaseCodexRollbackSource(source, originalBaseline, record.providerId),
        "utf8",
      );
      rollbackBaseline = await createSnapshot(
        this.#paths.codexConfig,
        this.#paths.snapshotsDir,
        "pre-connect",
        {
          existed: true,
          content: rebasedRollback,
          sha256: sha256(rebasedRollback),
          mode: current.mode ?? record.baseline.mode ?? 0o600,
        },
      );
      safetySnapshots = [...safetySnapshots, record.baseline];
    }
    const updatedHash = sha256(updatedSource);
    const updatedRecord: CodexConnectionRecord = {
      ...record,
      baseline: rollbackBaseline,
      providerName: mapping.displayName,
      baseUrl: mapping.baseUrl,
      model: mapping.model,
      connectedSha256: updatedHash,
      helperCommand: mapping.helper.command,
      helperArgs: mapping.helper.args,
      modelCatalogPath: catalog.path,
      modelCatalogSha256: catalog.sha256,
      modelContextWindow: catalog.contextWindow,
      safetySnapshots: [...safetySnapshots, safety],
    };
    await this.#runTransaction(
      state,
      this.#transaction("update", current.sha256, updatedHash, record, updatedRecord),
      async () => {
        await atomicWriteFile(this.#paths.codexConfig, updatedSource, {
          mode: current.mode ?? 0o600,
          expectedSha256: current.sha256,
        });
      },
    );
    if (
      record.modelCatalogPath !== undefined &&
      record.modelCatalogSha256 !== undefined &&
      record.modelCatalogPath !== catalog.path
    ) {
      await removeManagedCodexModelCatalog(
        this.#paths,
        record.modelCatalogPath,
        record.modelCatalogSha256,
      ).catch(() => undefined);
    }
    return {
      changed: true,
      configPath: this.#paths.codexConfig,
      model: mapping.model,
      snapshotPath: safety.path,
      modelCatalogPath: catalog.path,
      modelContextWindow: catalog.contextWindow,
    };
  }

  async disable(options: { force?: boolean } = {}): Promise<DisableResult> {
    const initialState = await readState(this.#paths.stateFile);
    if (!initialState.codex && !initialState.codexTransaction) {
      return { changed: false, configPath: this.#paths.codexConfig };
    }

    await this.#ensureCodexHomeForWrite();
    const lockPath = path.join(this.#paths.codexHome, ".krutrim-connect.lock");
    return await withFileLock(lockPath, async () => {
      const state = await this.#recoverTransaction();
      const record = state.codex;
      if (!record) {
        return { changed: false, configPath: this.#paths.codexConfig };
      }
      if (record.configPath !== this.#paths.codexConfig) {
        throw new ConfigurationError("Saved Codex state refers to a different configuration source.");
      }
      const current = await readConfigFile(this.#paths.codexConfig);
      const configDrifted = current.sha256 !== record.connectedSha256;
      const catalogDrifted = !(await this.#catalogIsIntact(record));
      const drifted = configDrifted || catalogDrifted;
      if (drifted && !options.force) {
        throw new ConfigurationError(
          "Codex config changed after activation. Refusing to overwrite it; use codex off --force to snapshot the drift and restore the exact baseline.",
        );
      }

      await readVerifiedSnapshot(record.baseline);
      const rescue = drifted
        ? await createSnapshot(
            this.#paths.codexConfig,
            this.#paths.snapshotsDir,
            "pre-restore-drift",
            current,
          )
        : undefined;
      const restoredHash = record.baseline.existed ? record.baseline.sha256 : null;
      await this.#runTransaction(
        state,
        this.#transaction("disable", current.sha256, restoredHash, record, undefined),
        async () => {
          await this.#restoreRecord(record.baseline, current.sha256);
        },
      );

      let preservedCatalogPath: string | undefined;
      if (
        record.modelCatalogPath !== undefined &&
        record.modelCatalogSha256 !== undefined
      ) {
        if (catalogDrifted) {
          preservedCatalogPath = record.modelCatalogPath;
        } else {
          const removed = await removeManagedCodexModelCatalog(
            this.#paths,
            record.modelCatalogPath,
            record.modelCatalogSha256,
          ).catch(() => false);
          if (!removed) {
            preservedCatalogPath = record.modelCatalogPath;
          }
        }
      }

      const result: DisableResult = {
        changed: true,
        configPath: this.#paths.codexConfig,
        restoredSnapshotPath: record.baseline.path,
      };
      if (rescue) {
        result.rescueSnapshotPath = rescue.path;
      }
      if (preservedCatalogPath !== undefined) {
        result.preservedCatalogPath = preservedCatalogPath;
      }
      return result;
    });
  }

  async #restoreRecord(
    snapshot: CodexConnectionRecord["baseline"],
    expectedSha256: string | null,
  ): Promise<void> {
    const content = await readVerifiedSnapshot(snapshot);
    if (snapshot.existed) {
      await atomicWriteFile(this.#paths.codexConfig, content, {
        mode: snapshot.mode ?? 0o600,
        expectedSha256,
      });
    } else {
      const current = await readConfigFile(this.#paths.codexConfig);
      if (current.sha256 !== expectedSha256) {
        throw new ConfigurationError("Codex config changed before restore; refusing to remove it.");
      }
      await removeFileDurably(this.#paths.codexConfig);
    }
  }
}
