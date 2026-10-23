import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import {
  configuredOpenCodeModel,
  hasOpenCodeProvider,
  mappingMatchesOpenCode,
  mergeOpenCodeMapping,
  rebaseOpenCodeRollbackSource,
  type OpenCodeManagedMapping,
} from "../config/opencode-json.js";
import { ConfigurationError } from "../errors.js";
import { atomicWriteFile, removeFileDurably, sha256, withFileLock } from "../fs/atomic.js";
import {
  openCodeLaunchCredentialIsReady,
  removeOpenCodeLaunchCredential,
} from "../opencode/launch-credential.js";
import type { RuntimePaths } from "../paths.js";
import { createSnapshot, readConfigFile, readVerifiedSnapshot, type ConfigFileRecord } from "../snapshots.js";
import { readState, writeState, type AppState, type OpenCodeConnectionRecord } from "../state.js";
import type { DisableResult, EnableResult, HarnessStatus } from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeConfig(content: Uint8Array): string {
  try {
    return decoder.decode(content);
  } catch (error) {
    throw new ConfigurationError("OpenCode configuration is not valid UTF-8.", { cause: error });
  }
}

export class OpenCodeHarness {
  readonly id = "opencode";
  readonly displayName = "OpenCode";
  readonly #paths: RuntimePaths;

  constructor(paths: RuntimePaths) {
    this.#paths = paths;
  }

  #mapping(
    model: string,
    baseUrl: string,
    credentialFile?: string,
  ): OpenCodeManagedMapping {
    return {
      model,
      baseUrl,
      ...(credentialFile === undefined ? {} : { credentialFile }),
    };
  }

  async #ensureHomeForWrite(): Promise<void> {
    try {
      const info = await lstat(this.#paths.openCodeHome);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ConfigurationError(`OpenCode configuration directory is not a real directory: ${this.#paths.openCodeHome}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await mkdir(this.#paths.openCodeHome, { recursive: true, mode: 0o700 });
    }
  }

  async #jsoncConfigExists(): Promise<boolean> {
    try {
      const info = await lstat(this.#paths.openCodeJsoncConfig);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new ConfigurationError(`OpenCode JSONC configuration is not a regular file: ${this.#paths.openCodeJsoncConfig}`);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async #assertNoJsoncConfig(): Promise<void> {
    if (await this.#jsoncConfigExists()) {
      throw new ConfigurationError(
        `OpenCode JSONC configuration exists at ${this.#paths.openCodeJsoncConfig}. KrutrimConnect will not rewrite JSONC because it could discard comments; migrate it to opencode.json before connecting.`,
      );
    }
  }

  #statusResult(
    state: HarnessStatus["state"],
    detail: string,
    model?: string,
  ): HarnessStatus {
    return {
      harness: this.id,
      state,
      configPath: this.#paths.openCodeConfig,
      configSource: "global OpenCode configuration",
      detail,
      ...(state === "disconnected" ? {} : { connectionMode: "bridge" as const }),
      ...(model === undefined ? {} : { model }),
    };
  }

  async status(): Promise<HarnessStatus> {
    const current = await readConfigFile(this.#paths.openCodeConfig);
    const jsoncExists = await this.#jsoncConfigExists();
    if (jsoncExists && !current.existed) {
      return this.#statusResult(
        "disconnected",
        `OpenCode JSONC configuration exists at ${this.#paths.openCodeJsoncConfig}; it is intentionally not managed by this alpha.`,
      );
    }
    if (jsoncExists) {
      return this.#statusResult(
        "unmanaged",
        "Both OpenCode JSON and JSONC global configurations exist. Refusing to infer their precedence or modify either file.",
      );
    }
    const source = decodeConfig(current.content);
    const state = await readState(this.#paths.openCodeStateFile);
    if (state.opencode !== undefined) {
      if (state.opencode.configPath !== this.#paths.openCodeConfig) {
        return this.#statusResult("drifted", "Saved OpenCode state refers to a different configuration source.", state.opencode.model);
      }
      if (
        state.opencode.credentialFile !== undefined &&
        state.opencode.credentialFile !== this.#paths.openCodeBridgeCredentialFile
      ) {
        return this.#statusResult(
          "drifted",
          "Saved OpenCode state refers to a different launch credential file.",
          state.opencode.model,
        );
      }
      const mapping = this.#mapping(
        state.opencode.model,
        state.opencode.baseUrl,
        state.opencode.credentialFile,
      );
      const exact = current.sha256 === state.opencode.connectedSha256;
      const semantic = current.existed && mappingMatchesOpenCode(source, mapping);
      const launchReady = state.opencode.credentialFile === undefined ||
        await openCodeLaunchCredentialIsReady(state.opencode.credentialFile);
      return exact && semantic && launchReady
        ? this.#statusResult(
            "connected",
            state.opencode.credentialFile === undefined
              ? "Managed OpenCode global configuration is present; this legacy connection must be launched through krutrimconnect opencode run."
              : "Managed OpenCode global configuration and private launch credential are present; plain opencode is ready.",
            state.opencode.model,
          )
        : this.#statusResult(
            "drifted",
            exact && semantic && !launchReady
              ? "The managed OpenCode launch credential is missing or unsafe. Re-run krutrimconnect opencode on to repair it."
              : semantic
              ? "Managed OpenCode values are intact, but the global configuration changed after activation. Updating or disconnecting requires an explicit review."
              : "Managed OpenCode provider values changed after activation.",
            state.opencode.model,
          );
    }
    const unmanagedModel = current.existed ? configuredOpenCodeModel(source) : undefined;
    return unmanagedModel !== undefined || (current.existed && hasOpenCodeProvider(source))
      ? this.#statusResult("unmanaged", "Krutrim OpenCode provider values exist without rollback state.", unmanagedModel)
      : this.#statusResult("disconnected", "No managed Krutrim OpenCode configuration is present.");
  }

  async enable(
    model: string,
    baseUrl: string,
    options: { credentialFile?: string } = {},
  ): Promise<EnableResult> {
    if (
      options.credentialFile !== undefined &&
      options.credentialFile !== this.#paths.openCodeBridgeCredentialFile
    ) {
      throw new ConfigurationError(
        "OpenCode launch credentials must use the managed KrutrimConnect runtime path.",
      );
    }
    await this.#ensureHomeForWrite();
    await this.#assertNoJsoncConfig();
    const lockPath = path.join(this.#paths.openCodeHome, ".krutrim-connect.lock");
    return await withFileLock(lockPath, async () => {
      const current = await readConfigFile(this.#paths.openCodeConfig);
      const source = decodeConfig(current.content);
      const state = await readState(this.#paths.openCodeStateFile);
      const mapping = this.#mapping(model, baseUrl, options.credentialFile);
      if (state.opencode === undefined) {
        const updatedSource = mergeOpenCodeMapping(source, mapping, { allowExistingProvider: false });
        const baseline = await createSnapshot(
          this.#paths.openCodeConfig,
          this.#paths.openCodeSnapshotsDir,
          "pre-connect",
          current,
        );
        const record: OpenCodeConnectionRecord = {
          providerId: "krutrim",
          providerName: "Krutrim Cloud",
          baseUrl,
          model,
          configPath: this.#paths.openCodeConfig,
          baseline,
          connectedSha256: sha256(updatedSource),
          activatedAt: new Date().toISOString(),
          ...(mapping.credentialFile === undefined
            ? {}
            : { credentialFile: mapping.credentialFile }),
          safetySnapshots: [],
        };
        await atomicWriteFile(this.#paths.openCodeConfig, updatedSource, {
          mode: current.mode ?? 0o600,
          expectedSha256: current.sha256,
        });
        await writeState(this.#paths.openCodeStateFile, this.#paths.appHome, { version: 1, opencode: record });
        return { changed: true, configPath: this.#paths.openCodeConfig, model, snapshotPath: baseline.path };
      }
      return await this.#update(state, state.opencode, current, source, mapping);
    });
  }

  async #update(
    state: AppState,
    record: OpenCodeConnectionRecord,
    current: ConfigFileRecord,
    source: string,
    mapping: OpenCodeManagedMapping,
  ): Promise<EnableResult> {
    if (record.configPath !== this.#paths.openCodeConfig) {
      throw new ConfigurationError("Saved OpenCode state refers to a different configuration source.");
    }
    if (
      record.credentialFile !== undefined &&
      record.credentialFile !== this.#paths.openCodeBridgeCredentialFile
    ) {
      throw new ConfigurationError(
        "Saved OpenCode state refers to a different launch credential file.",
      );
    }
    const savedMapping = this.#mapping(
      record.model,
      record.baseUrl,
      record.credentialFile,
    );
    const managedMappingIntact = current.existed && mappingMatchesOpenCode(source, savedMapping);
    if (record.model === mapping.model && mappingMatchesOpenCode(source, mapping)) {
      return { changed: false, configPath: this.#paths.openCodeConfig, model: mapping.model };
    }
    if (!managedMappingIntact) {
      throw new ConfigurationError(
        "Krutrim-managed OpenCode values changed after activation. Refusing automatic repair; review the configuration before reconnecting.",
      );
    }
    const updatedSource = mergeOpenCodeMapping(source, mapping, { allowExistingProvider: true });
    const safety = await createSnapshot(
      this.#paths.openCodeConfig,
      this.#paths.openCodeSnapshotsDir,
      "pre-update",
      current,
    );
    let baseline = record.baseline;
    let safetySnapshots = record.safetySnapshots;
    if (current.sha256 !== record.connectedSha256) {
      const rebased = Buffer.from(
        rebaseOpenCodeRollbackSource(source, decodeConfig(await readVerifiedSnapshot(record.baseline))),
        "utf8",
      );
      baseline = await createSnapshot(
        this.#paths.openCodeConfig,
        this.#paths.openCodeSnapshotsDir,
        "pre-connect",
        { existed: true, content: rebased, sha256: sha256(rebased), mode: current.mode ?? record.baseline.mode ?? 0o600 },
      );
      safetySnapshots = [...safetySnapshots, record.baseline];
    }
    await atomicWriteFile(this.#paths.openCodeConfig, updatedSource, {
      mode: current.mode ?? 0o600,
      expectedSha256: current.sha256,
    });
    const nextRecord: OpenCodeConnectionRecord = {
      ...record,
      model: mapping.model,
      baseUrl: mapping.baseUrl,
      ...(mapping.credentialFile === undefined
        ? {}
        : { credentialFile: mapping.credentialFile }),
      baseline,
      connectedSha256: sha256(updatedSource),
      safetySnapshots: [...safetySnapshots, safety],
    };
    if (mapping.credentialFile === undefined) {
      delete nextRecord.credentialFile;
    }
    await writeState(this.#paths.openCodeStateFile, this.#paths.appHome, {
      ...state,
      opencode: nextRecord,
    });
    return { changed: true, configPath: this.#paths.openCodeConfig, model: mapping.model, snapshotPath: safety.path };
  }

  async disable(options: { force?: boolean } = {}): Promise<DisableResult> {
    await this.#ensureHomeForWrite();
    const lockPath = path.join(this.#paths.openCodeHome, ".krutrim-connect.lock");
    return await withFileLock(lockPath, async () => {
      const state = await readState(this.#paths.openCodeStateFile);
      if (state.opencode === undefined) {
        const current = await readConfigFile(this.#paths.openCodeConfig);
        const source = decodeConfig(current.content);
        if (current.existed && hasOpenCodeProvider(source)) {
          throw new ConfigurationError("OpenCode has unmanaged Krutrim provider values; refusing to remove them.");
        }
        await removeOpenCodeLaunchCredential(
          this.#paths.openCodeBridgeCredentialFile,
        );
        return { changed: false, configPath: this.#paths.openCodeConfig };
      }
      const record = state.opencode;
      if (record.configPath !== this.#paths.openCodeConfig) {
        throw new ConfigurationError("Saved OpenCode state refers to a different configuration source.");
      }
      if (
        record.credentialFile !== undefined &&
        record.credentialFile !== this.#paths.openCodeBridgeCredentialFile
      ) {
        throw new ConfigurationError(
          "Saved OpenCode state refers to a different launch credential file.",
        );
      }
      const current = await readConfigFile(this.#paths.openCodeConfig);
      if (current.sha256 !== record.connectedSha256 && options.force !== true) {
        throw new ConfigurationError(
          "OpenCode configuration changed after activation. Refusing to overwrite it; review the changes or rerun disconnect with --force to create a rescue snapshot.",
        );
      }
      const rescueSnapshot = current.sha256 !== record.connectedSha256
        ? await createSnapshot(this.#paths.openCodeConfig, this.#paths.openCodeSnapshotsDir, "pre-restore-drift", current)
        : undefined;
      const baseline = await readVerifiedSnapshot(record.baseline);
      if (record.baseline.existed) {
        await atomicWriteFile(this.#paths.openCodeConfig, baseline, {
          mode: record.baseline.mode ?? current.mode ?? 0o600,
          expectedSha256: current.sha256,
        });
      } else {
        await removeFileDurably(this.#paths.openCodeConfig);
      }
      await writeState(this.#paths.openCodeStateFile, this.#paths.appHome, { version: 1 });
      await removeOpenCodeLaunchCredential(
        this.#paths.openCodeBridgeCredentialFile,
      );
      return {
        changed: true,
        configPath: this.#paths.openCodeConfig,
        restoredSnapshotPath: record.baseline.path,
        ...(rescueSnapshot === undefined ? {} : { rescueSnapshotPath: rescueSnapshot.path }),
      };
    });
  }
}
