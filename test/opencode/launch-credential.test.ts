import { chmod, lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  openCodeLaunchCredentialIsReady,
  openCodeLaunchCredentialMatches,
  readOpenCodeLaunchCredential,
  removeOpenCodeLaunchCredential,
  restoreOpenCodeLaunchCredential,
  writeOpenCodeLaunchCredential,
} from "../../src/opencode/launch-credential.js";
import { createTestWorkspace } from "../helpers.js";

describe("OpenCode launch credential", () => {
  it("writes only a private instance-bound token and removes it", async () => {
    const test = await createTestWorkspace();
    try {
      const token = "c".repeat(64);
      const previous = await writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        token,
      );
      expect(previous.existed).toBe(false);
      expect(await readFile(test.paths.openCodeBridgeCredentialFile, "utf8")).toBe(token);
      if (process.platform !== "win32") {
        expect((await lstat(test.paths.openCodeBridgeCredentialFile)).mode & 0o777).toBe(0o600);
      }
      await expect(openCodeLaunchCredentialIsReady(
        test.paths.openCodeBridgeCredentialFile,
      )).resolves.toBe(true);
      await expect(openCodeLaunchCredentialMatches(
        test.paths.openCodeBridgeCredentialFile,
        token,
      )).resolves.toBe(true);
      await expect(openCodeLaunchCredentialMatches(
        test.paths.openCodeBridgeCredentialFile,
        "0".repeat(64),
      )).resolves.toBe(false);
      await expect(removeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
      )).resolves.toBe(true);
      await expect(openCodeLaunchCredentialIsReady(
        test.paths.openCodeBridgeCredentialFile,
      )).resolves.toBe(false);
    } finally {
      await test.cleanup();
    }
  });

  it("restores the previous private file when activation rolls back", async () => {
    const test = await createTestWorkspace();
    try {
      await writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        "d".repeat(64),
      );
      const previous = await readOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
      );
      await writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        "e".repeat(64),
      );
      await restoreOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        previous,
      );
      expect(await readFile(test.paths.openCodeBridgeCredentialFile, "utf8")).toBe(
        "d".repeat(64),
      );
    } finally {
      await test.cleanup();
    }
  });

  it("rejects malformed, accessible, and symlinked credential files", async () => {
    const test = await createTestWorkspace();
    try {
      await expect(writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        "not-a-token",
      )).rejects.toThrow(/invalid/u);

      await writeOpenCodeLaunchCredential(
        test.paths.openCodeBridgeCredentialFile,
        "f".repeat(64),
      );
      if (process.platform !== "win32") {
        await chmod(test.paths.openCodeBridgeCredentialFile, 0o644);
        await expect(readOpenCodeLaunchCredential(
          test.paths.openCodeBridgeCredentialFile,
        )).rejects.toThrow(/group- or world-accessible/u);
      }

      await test.cleanup();
      const replacement = await createTestWorkspace();
      try {
        await mkdir(path.dirname(replacement.paths.fallbackSecretFile), {
          recursive: true,
        });
        await mkdir(path.dirname(replacement.paths.openCodeBridgeCredentialFile), {
          recursive: true,
        });
        await writeFile(replacement.paths.fallbackSecretFile, "target", {
          mode: 0o600,
        });
        await symlink(
          replacement.paths.fallbackSecretFile,
          replacement.paths.openCodeBridgeCredentialFile,
        );
        await expect(readOpenCodeLaunchCredential(
          replacement.paths.openCodeBridgeCredentialFile,
        )).rejects.toThrow(/not a regular file/u);
      } finally {
        await replacement.cleanup();
      }
    } finally {
      await test.cleanup();
    }
  });
});
