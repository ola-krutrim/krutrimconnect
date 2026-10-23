import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRuntimePaths } from "../src/paths.js";

describe("runtime path partitioning", () => {
  it("uses a distinct rollback state file for each Codex configuration", () => {
    const home = path.resolve("/tmp/krutrim-connect-path-test-home");
    const appHome = path.resolve("/tmp/krutrim-connect-path-test-app");
    const first = resolveRuntimePaths(
      { KRUTRIM_CONNECT_HOME: appHome, CODEX_HOME: path.join(home, "codex-a") },
      home,
    );
    const second = resolveRuntimePaths(
      { KRUTRIM_CONNECT_HOME: appHome, CODEX_HOME: path.join(home, "codex-b") },
      home,
    );

    expect(first.stateFile).not.toBe(second.stateFile);
    expect(path.dirname(first.stateFile)).toBe(path.dirname(second.stateFile));
    expect(first.codexBridgeRuntimeFile).not.toBe(first.openCodeBridgeRuntimeFile);
    expect(path.basename(first.codexBridgeRuntimeFile)).toBe("codex.json");
    expect(path.basename(first.openCodeBridgeRuntimeFile)).toBe("opencode.json");
    expect(path.basename(first.openCodeBridgeCredentialFile)).toBe("opencode.token");
    expect(path.dirname(first.codexBridgeRuntimeFile)).toBe(
      path.dirname(first.openCodeBridgeRuntimeFile),
    );
    expect(path.dirname(first.openCodeBridgeCredentialFile)).toBe(
      path.dirname(first.openCodeBridgeRuntimeFile),
    );
    expect(first.bridgeRuntimeFile).not.toBe(first.codexBridgeRuntimeFile);
  });
});
