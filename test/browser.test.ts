import { describe, expect, it, vi } from "vitest";

import {
  KRUTRIM_SIGN_IN_URL,
  browserOpenCommand,
  openKrutrimSignInPage,
  type BrowserProcessRunner,
} from "../src/browser.js";

describe("browser opening", () => {
  it.each([
    ["darwin", "open", [KRUTRIM_SIGN_IN_URL]],
    ["linux", "xdg-open", [KRUTRIM_SIGN_IN_URL]],
    [
      "win32",
      "cmd.exe",
      ["/d", "/s", "/c", "start", "", KRUTRIM_SIGN_IN_URL],
    ],
  ] as const)("uses the native %s command without a shell", (platform, command, args) => {
    expect(browserOpenCommand(platform)).toEqual({ command, args });
  });

  it("rejects unsupported platforms with the manual URL", () => {
    expect(() => browserOpenCommand("freebsd"))
      .toThrow(`Open ${KRUTRIM_SIGN_IN_URL} manually`);
  });

  it("opens only the fixed sign-in URL through the bounded process runner", async () => {
    const run = vi.fn<BrowserProcessRunner>(async () => ({
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
    }));

    await openKrutrimSignInPage({ platform: "darwin", run });

    expect(run).toHaveBeenCalledWith(
      "open",
      [KRUTRIM_SIGN_IN_URL],
      { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 },
    );
  });

  it("returns a safe manual fallback when the opener fails", async () => {
    const run = vi.fn<BrowserProcessRunner>(async () => ({
      code: 1,
      signal: null,
      stdout: "ignored",
      stderr: "ignored",
    }));

    await expect(openKrutrimSignInPage({ platform: "linux", run }))
      .rejects.toThrow(`Open ${KRUTRIM_SIGN_IN_URL} manually`);
  });
});
