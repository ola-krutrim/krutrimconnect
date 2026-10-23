import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { startBridgeServer, deriveBridgeBearer } from "../../src/bridge/server.js";
import { OPENCODE_BRIDGE_TOKEN_ENV } from "../../src/config/opencode-json.js";
import { OpenCodeHarness } from "../../src/harnesses/opencode.js";
import { writeOpenCodeLaunchCredential } from "../../src/opencode/launch-credential.js";
import { createTestWorkspace } from "../helpers.js";

const executable = process.env.KRUTRIM_OPENCODE_BIN?.trim() || "opencode";
const installed = spawnSync(executable, ["--version"], {
  encoding: "utf8",
  shell: false,
  timeout: 10_000,
});

describe.skipIf(installed.status !== 0)("plain OpenCode launch", () => {
  it("authenticates from the managed private token file without an environment token", async () => {
    const test = await createTestWorkspace();
    const apiKey = "synthetic-upstream-key-never-sent";
    const instanceId = randomUUID();
    const model = "plain-launch-model";
    const server = await startBridgeServer({
      apiKey,
      instanceId,
      model,
      controlToken: "1".repeat(64),
      fetchImpl: async () => {
        throw new Error("The model-list launch check must not call upstream inference.");
      },
    });
    try {
      await writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        deriveBridgeBearer(apiKey, instanceId),
      );
      const harness = new OpenCodeHarness(test.paths);
      await harness.enable(model, `http://${server.host}:${server.port}/v1`, {
        credentialFile: test.paths.openCodeBridgeCredentialFile,
      });

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: test.root,
        XDG_CONFIG_HOME: path.dirname(test.paths.openCodeHome),
        XDG_DATA_HOME: path.join(test.root, "opencode-data"),
        XDG_CACHE_HOME: path.join(test.root, "opencode-cache"),
        XDG_STATE_HOME: path.join(test.root, "opencode-state"),
      };
      delete env[OPENCODE_BRIDGE_TOKEN_ENV];
      const launched = spawnSync(executable, ["models", "krutrim"], {
        cwd: test.root,
        encoding: "utf8",
        env,
        shell: false,
        timeout: 30_000,
      });

      expect(launched.error).toBeUndefined();
      expect(launched.status, launched.stderr).toBe(0);
      expect(launched.stdout).toContain(`krutrim/${model}`);
      expect(launched.stdout).not.toContain(apiKey);
      await harness.disable();
    } finally {
      await server.close();
      await test.cleanup();
    }
  });
});
