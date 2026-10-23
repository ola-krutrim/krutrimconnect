import { describe, expect, it, vi } from "vitest";

import { KRUTRIM_SIGN_IN_URL } from "../src/browser.js";
import {
  KRUTRIM_LOGIN_CHOICES,
  promptForKrutrimApiKey,
  type KrutrimLoginChoice,
} from "../src/login.js";

describe("interactive login", () => {
  it("shows the numbered create-or-paste choices", () => {
    expect(KRUTRIM_LOGIN_CHOICES).toEqual([
      {
        name: "Create one for me — opens your browser to sign in or sign up",
        value: "create",
      },
      {
        name: "I already have a key — paste it securely",
        value: "existing",
      },
    ]);
  });

  it("pastes an existing key without opening a browser", async () => {
    const output: string[] = [];
    const openSignIn = vi.fn(async () => undefined);
    const apiKey = await promptForKrutrimApiKey({
      choose: async (): Promise<KrutrimLoginChoice> => "existing",
      readKey: async () => "test-key",
      openSignIn,
      write: (message) => output.push(message),
    });

    expect(apiKey).toBe("test-key");
    expect(openSignIn).not.toHaveBeenCalled();
    expect(output.join(""))
      .toContain("KrutrimConnect needs a Krutrim API key for this machine");
    expect(output.join(""))
      .toContain("Removable anytime with krutrimconnect logout");
  });

  it("opens sign-in before returning to the masked key prompt", async () => {
    const events: string[] = [];
    const apiKey = await promptForKrutrimApiKey({
      choose: async () => "create",
      openSignIn: async () => {
        events.push("open");
      },
      readKey: async () => {
        events.push("read");
        return "test-key";
      },
      write: (message) => events.push(message),
    });

    expect(apiKey).toBe("test-key");
    expect(events.indexOf("open")).toBeLessThan(events.indexOf("read"));
    expect(events.join(""))
      .toContain(`Opening ${KRUTRIM_SIGN_IN_URL}`);
    expect(events.join(""))
      .toContain("Create a Krutrim model API key, then return here");
  });

  it("prints the manual URL and still accepts a key when browser opening fails", async () => {
    const output: string[] = [];
    await expect(promptForKrutrimApiKey({
      choose: async () => "create",
      openSignIn: async () => {
        throw new Error("opener failed");
      },
      readKey: async () => "test-key",
      write: (message) => output.push(message),
    })).resolves.toBe("test-key");

    expect(output.join(""))
      .toContain(`Open ${KRUTRIM_SIGN_IN_URL} manually`);
  });
});
