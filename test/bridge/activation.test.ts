import { mkdir, readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import path from "node:path";
import { restoreActivationFiles, recoverReusedBridgeActivation } from "../../src/bridge/activation.js";
import { atomicWriteFile, sha256 } from "../../src/fs/atomic.js";
import { withFileMutationObserver } from "../../src/fs/mutations.js";
import { createTestWorkspace } from "../helpers.js";

it.each(["foreign-target", "invalid-snapshot"] as const)("reused recovery rejects %s without modifying files", async (fault) => {
  const test = await createTestWorkspace();
  try {
    const target = fault === "foreign-target" ? path.join(test.root, "unrelated") : test.paths.codexConfig;
    await writeFile(target, "keep");
    const journal = `${test.paths.codexBridgeRuntimeFile}.activation.json`;
    await mkdir(path.dirname(journal), { recursive: true, mode: 0o700 });
    await writeFile(journal, JSON.stringify({ version: 1, entries: [{
      target,
      before: { content: Buffer.from("before").toString("base64"), sha256: sha256(fault === "invalid-snapshot" ? "wrong" : "before"), mode: 0o600 },
      after: [sha256("keep")],
    }] }), { mode: 0o600 });
    await expect(recoverReusedBridgeActivation(test.paths, "codex")).rejects.toThrow(/Invalid bridge activation recovery data/);
    expect(await readFile(target, "utf8")).toBe("keep");
    expect(await readFile(journal, "utf8")).toContain("version");
  } finally { await test.cleanup(); }
});

it.each(["earlier-restore", "delete-observer"])("rollback deletion preserves edits during %s", async (phase) => {
  const test = await createTestWorkspace();
  try {
    const token = path.join(test.root, "token");
    const config = test.paths.codexConfig;
    await writeFile(token, "new token");
    await writeFile(config, "activation");
    await expect(withFileMutationObserver(async (target) => {
      if (target === (phase === "earlier-restore" ? token : config)) await writeFile(config, "external edit");
    }, async () => await restoreActivationFiles([
      { target: token, before: { content: Buffer.from("old token").toString("base64"), sha256: sha256("old token"), mode: 0o600 }, after: [sha256("new token")] },
      { target: config, before: { content: "", sha256: null, mode: 0o600 }, after: [sha256("activation")] },
    ]))).rejects.toThrow(/changed after it was read/);
    expect(await readFile(token, "utf8")).toBe("old token");
    expect(await readFile(config, "utf8")).toBe("external edit");
  } finally { await test.cleanup(); }
});

it("the activation write-ahead guard does not weaken the final concurrency check", async () => {
  const test = await createTestWorkspace();
  try {
    await writeFile(test.paths.codexConfig, "before");
    await expect(withFileMutationObserver(async (target) => {
      await writeFile(target, "external edit while the guard was awaiting acknowledgement");
    }, async () => {
      await atomicWriteFile(test.paths.codexConfig, "activation", { expectedSha256: sha256("before") });
    })).rejects.toThrow(/changed after it was read/);
    expect(await readFile(test.paths.codexConfig, "utf8")).toBe("external edit while the guard was awaiting acknowledgement");
  } finally { await test.cleanup(); }
});
