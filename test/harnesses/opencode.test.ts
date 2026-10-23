import { access, mkdir, readFile, writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { OpenCodeHarness } from "../../src/harnesses/opencode.js";
import { writeOpenCodeLaunchCredential } from "../../src/opencode/launch-credential.js";
import { createTestWorkspace } from "../helpers.js";

const bridgeUrl = "http://127.0.0.1:43123/v1";

describe("OpenCodeHarness", () => {
  it("connects, changes models, and restores the exact initial configuration", async () => {
    const test = await createTestWorkspace();
    try {
      const baseline = `${JSON.stringify({ autoupdate: false, model: "openai/original" }, null, 2)}\n`;
      await mkdir(test.paths.openCodeHome, { recursive: true });
      await writeFile(test.paths.openCodeConfig, baseline, { mode: 0o600 });
      const harness = new OpenCodeHarness(test.paths);
      await writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        "a".repeat(64),
      );

      const first = await harness.enable("Qwen3.6-35B-A3B", bridgeUrl, {
        credentialFile: test.paths.openCodeBridgeCredentialFile,
      });
      expect(first.changed).toBe(true);
      expect((await harness.status()).state).toBe("connected");
      expect(await readFile(test.paths.openCodeConfig, "utf8")).toContain("krutrim/Qwen3.6-35B-A3B");
      expect(JSON.parse(await readFile(test.paths.openCodeConfig, "utf8"))).toMatchObject({
        provider: {
          krutrim: {
            options: { apiKey: `{file:${test.paths.openCodeBridgeCredentialFile}}` },
          },
        },
      });

      const second = await harness.enable("Qwen3.6-27B", bridgeUrl, {
        credentialFile: test.paths.openCodeBridgeCredentialFile,
      });
      expect(second.changed).toBe(true);
      expect((await harness.status()).model).toBe("Qwen3.6-27B");

      const disconnected = await harness.disable();
      expect(disconnected.changed).toBe(true);
      expect(await readFile(test.paths.openCodeConfig, "utf8")).toBe(baseline);
      await expect(access(test.paths.openCodeBridgeCredentialFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await harness.status()).state).toBe("disconnected");
    } finally {
      await test.cleanup();
    }
  });

  it("preserves unrelated edits when switching models", async () => {
    const test = await createTestWorkspace();
    try {
      const harness = new OpenCodeHarness(test.paths);
      await harness.enable("Qwen3.6-35B-A3B", bridgeUrl);
      const current = JSON.parse(await readFile(test.paths.openCodeConfig, "utf8")) as Record<string, unknown>;
      current.watcher = { ignore: ["coverage/**"] };
      await writeFile(test.paths.openCodeConfig, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });

      await harness.enable("Qwen3.6-27B", bridgeUrl);
      const updated = JSON.parse(await readFile(test.paths.openCodeConfig, "utf8")) as Record<string, unknown>;
      expect(updated.watcher).toEqual({ ignore: ["coverage/**"] });

      await harness.disable({ force: true });
      expect(JSON.parse(await readFile(test.paths.openCodeConfig, "utf8"))).toEqual({ watcher: { ignore: ["coverage/**"] } });
    } finally {
      await test.cleanup();
    }
  });

  it("upgrades a legacy environment-token connection to plain launch and preserves rollback", async () => {
    const test = await createTestWorkspace();
    try {
      const baseline = `${JSON.stringify({ autoupdate: false }, null, 2)}\n`;
      await mkdir(test.paths.openCodeHome, { recursive: true });
      await writeFile(test.paths.openCodeConfig, baseline, { mode: 0o600 });
      const harness = new OpenCodeHarness(test.paths);
      await harness.enable("Qwen3.6-35B-A3B", bridgeUrl);
      expect(await readFile(test.paths.openCodeConfig, "utf8")).toContain(
        "{env:KRUTRIM_CONNECT_BRIDGE_TOKEN}",
      );

      await writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        "9".repeat(64),
      );
      const upgraded = await harness.enable("Qwen3.6-35B-A3B", bridgeUrl, {
        credentialFile: test.paths.openCodeBridgeCredentialFile,
      });
      expect(upgraded.changed).toBe(true);
      expect(JSON.parse(await readFile(test.paths.openCodeConfig, "utf8"))).toMatchObject({
        provider: {
          krutrim: {
            options: { apiKey: `{file:${test.paths.openCodeBridgeCredentialFile}}` },
          },
        },
      });
      await expect(harness.status()).resolves.toMatchObject({
        state: "connected",
        detail: expect.stringMatching(/plain opencode is ready/iu),
      });

      await harness.disable();
      expect(await readFile(test.paths.openCodeConfig, "utf8")).toBe(baseline);
    } finally {
      await test.cleanup();
    }
  });

  it("refuses normal disconnect after external changes", async () => {
    const test = await createTestWorkspace();
    try {
      const harness = new OpenCodeHarness(test.paths);
      await harness.enable("Qwen3.6-35B-A3B", bridgeUrl);
      await writeFile(test.paths.openCodeConfig, "{}\n", { mode: 0o600 });
      await expect(harness.disable()).rejects.toThrow(/changed after activation/u);
      expect((await harness.status()).state).toBe("drifted");
    } finally {
      await test.cleanup();
    }
  });

  it("leaves a JSONC configuration untouched", async () => {
    const test = await createTestWorkspace();
    try {
      await mkdir(test.paths.openCodeHome, { recursive: true });
      await writeFile(test.paths.openCodeJsoncConfig, "{ // user comment\n}\n", { mode: 0o600 });
      const harness = new OpenCodeHarness(test.paths);
      await expect(harness.enable("Qwen3.6-35B-A3B", bridgeUrl)).rejects.toThrow(/will not rewrite JSONC/u);
      expect((await harness.status()).state).toBe("disconnected");
    } finally {
      await test.cleanup();
    }
  });

  it("marks a launch-ready connection drifted if its private credential disappears", async () => {
    const test = await createTestWorkspace();
    try {
      const harness = new OpenCodeHarness(test.paths);
      await writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        "b".repeat(64),
      );
      await harness.enable("Qwen3.6-35B-A3B", bridgeUrl, {
        credentialFile: test.paths.openCodeBridgeCredentialFile,
      });
      await writeFile(test.paths.openCodeBridgeCredentialFile, "invalid", {
        mode: 0o600,
      });
      await expect(harness.status()).resolves.toMatchObject({
        state: "drifted",
        detail: expect.stringMatching(/credential is missing or unsafe/u),
      });
    } finally {
      await test.cleanup();
    }
  });
});
