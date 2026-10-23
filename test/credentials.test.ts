import { mkdir } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  removeKrutrimCredential,
  storeKrutrimCredential,
  type CredentialRemover,
  type CredentialValidator,
  type CredentialWriter,
} from "../src/credentials.js";
import { CodexHarness } from "../src/harnesses/codex.js";
import { OpenCodeHarness } from "../src/harnesses/opencode.js";
import { stateFileForCodexConfig, stateFileForOpenCodeConfig } from "../src/paths.js";
import { createTestWorkspace, supportedProvider, type TestWorkspace } from "./helpers.js";

const workspaces: TestWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (item) => await item.cleanup()));
});

function writer(): CredentialWriter & { store: ReturnType<typeof vi.fn> } {
  const store = vi.fn<CredentialWriter["store"]>(async (
    _secret,
    _allowFileFallback,
    validation,
  ) => ({
    backend: "restricted-file" as const,
    usedFallback: true,
    removedStaleBackends: [],
    cleanupFailures: [],
    validation,
  }));
  return { store };
}

const passedValidation = {
  status: "validated" as const,
  method: "authenticated-model-catalogue-v1" as const,
  endpoint: "https://cloud.olakrutrim.com/v1/models" as const,
  validatedAt: "2026-08-27T00:00:00.000Z",
};

function validator(): CredentialValidator {
  return vi.fn(async () => passedValidation);
}

function remover(): CredentialRemover & { clear: ReturnType<typeof vi.fn> } {
  return {
    clear: vi.fn(async () => ({
      changed: true,
      removedBackends: ["restricted-file" as const],
      missingBackends: [],
      removedBackendRecord: true,
    })),
  };
}


describe("credential rotation guard", () => {
  it("stores a credential while Codex is disconnected", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const credentials = writer();

    await expect(
      storeKrutrimCredential(
        test.paths,
        test.harness,
        credentials,
        "replacement-key",
        true,
        { validator: validator() },
      ),
    ).resolves.toMatchObject({ backend: "restricted-file", usedFallback: true });
    expect(credentials.store).toHaveBeenCalledOnce();
    expect(credentials.store).toHaveBeenCalledWith(
      "replacement-key",
      true,
      passedValidation,
    );
  });

  it("preserves the existing credential when online validation fails", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const credentials = writer();
    const rejected = vi.fn<CredentialValidator>(async () => {
      throw new Error("candidate rejected");
    });

    await expect(storeKrutrimCredential(
      test.paths,
      test.harness,
      credentials,
      "replacement-key",
      true,
      { validator: rejected },
    )).rejects.toThrow(/candidate rejected/u);
    expect(rejected).toHaveBeenCalledWith("replacement-key");
    expect(credentials.store).not.toHaveBeenCalled();
  });

  it("stores explicit skipped-validation state without calling the validator", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const credentials = writer();
    const notCalled = validator();

    await expect(storeKrutrimCredential(
      test.paths,
      test.harness,
      credentials,
      "replacement-key",
      true,
      { skipValidation: true, validator: notCalled },
    )).resolves.toMatchObject({ validation: { status: "skipped" } });
    expect(notCalled).not.toHaveBeenCalled();
    expect(credentials.store).toHaveBeenCalledWith(
      "replacement-key",
      true,
      { status: "skipped" },
    );
  });

  it("refuses to rotate the helper-backed credential while Codex is connected", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    await test.harness.enable(supportedProvider, "Krutrim-Credential-Guard");
    const credentials = writer();

    await expect(
      storeKrutrimCredential(
        test.paths,
        test.harness,
        credentials,
        "replacement-key",
        true,
        { validator: validator() },
      ),
    ).rejects.toThrow(/managed Codex configuration is active/u);
    expect(credentials.store).not.toHaveBeenCalled();
  });

  it("refuses to rotate the credential while OpenCode is connected", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    await new OpenCodeHarness(test.paths).enable("Krutrim-Credential-Guard", "http://127.0.0.1:43123/v1");
    const credentials = writer();

    await expect(
      storeKrutrimCredential(
        test.paths,
        test.harness,
        credentials,
        "replacement-key",
        true,
        { validator: validator() },
      ),
    ).rejects.toThrow(/OpenCode global configuration is connected/u);
    expect(credentials.store).not.toHaveBeenCalled();
  });

  it("refuses rotation from a second CODEX_HOME sharing the connected app home", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    await test.harness.enable(supportedProvider, "Krutrim-Multi-Home-Guard");

    const secondCodexHome = path.join(test.root, "codex-second");
    await mkdir(secondCodexHome, { recursive: true });
    const secondConfig = path.join(secondCodexHome, "config.toml");
    const secondPaths = {
      ...test.paths,
      codexHome: secondCodexHome,
      codexConfig: secondConfig,
      stateFile: stateFileForCodexConfig(test.paths.appHome, secondConfig),
    };
    const secondHarness = new CodexHarness(
      secondPaths,
      { read: async () => "test-secret-never-logged" },
      {
        command: "/absolute/node",
        args: [
          "/absolute/krutrimconnect.js",
          "_credential",
          "read",
          "--app-home",
          test.paths.appHome,
        ],
      },
    );
    const credentials = writer();

    await expect(
      storeKrutrimCredential(
        secondPaths,
        secondHarness,
        credentials,
        "replacement-key",
        true,
        { validator: validator() },
      ),
    ).rejects.toThrow(new RegExp(test.paths.codexConfig.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    expect(credentials.store).not.toHaveBeenCalled();
  });

  it("refuses logout from a second OpenCode config home sharing the app home", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    await new OpenCodeHarness(test.paths).enable(
      "Krutrim-Multi-OpenCode-Guard",
      "http://127.0.0.1:43123/v1",
    );

    const secondOpenCodeHome = path.join(test.root, "opencode-second");
    const secondOpenCodeConfig = path.join(secondOpenCodeHome, "opencode.json");
    const secondPaths = {
      ...test.paths,
      openCodeHome: secondOpenCodeHome,
      openCodeConfig: secondOpenCodeConfig,
      openCodeJsoncConfig: path.join(secondOpenCodeHome, "opencode.jsonc"),
      openCodeStateFile: stateFileForOpenCodeConfig(
        test.paths.appHome,
        secondOpenCodeConfig,
      ),
      openCodeSnapshotsDir: path.join(
        test.paths.appHome,
        "snapshots",
        "opencode-second",
      ),
    };
    const credentials = remover();

    await expect(
      removeKrutrimCredential(secondPaths, test.harness, credentials),
    ).rejects.toThrow(new RegExp(
      test.paths.openCodeConfig.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
      "u",
    ));
    expect(credentials.clear).not.toHaveBeenCalled();
  });

  it("removes a credential while every harness is disconnected", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    const credentials = remover();

    await expect(
      removeKrutrimCredential(test.paths, test.harness, credentials),
    ).resolves.toMatchObject({ changed: true });
    expect(credentials.clear).toHaveBeenCalledOnce();
  });

  it("refuses logout while Codex is connected", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    await test.harness.enable(supportedProvider, "Krutrim-Logout-Guard");
    const credentials = remover();

    await expect(
      removeKrutrimCredential(test.paths, test.harness, credentials),
    ).rejects.toThrow(/managed Codex configuration is active/u);
    expect(credentials.clear).not.toHaveBeenCalled();
  });

  it("refuses logout while OpenCode is connected", async () => {
    const test = await createTestWorkspace();
    workspaces.push(test);
    await new OpenCodeHarness(test.paths).enable(
      "Krutrim-Logout-Guard",
      "http://127.0.0.1:43123/v1",
    );
    const credentials = remover();

    await expect(
      removeKrutrimCredential(test.paths, test.harness, credentials),
    ).rejects.toThrow(/OpenCode global configuration is connected/u);
    expect(credentials.clear).not.toHaveBeenCalled();
  });
});
