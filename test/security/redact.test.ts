import { describe, expect, it } from "vitest";

import { redactText, redactValue } from "../../src/security/redact.js";

describe("secret redaction", () => {
  it("redacts exact secret values and bearer headers", () => {
    const secret = "krutrim-super-secret-123";
    const message = `request failed for ${secret}; Authorization: Bearer ${secret}`;
    const redacted = redactText(message, [secret]);
    expect(redacted).not.toContain(secret);
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts recognizable secret patterns in free-form text (KAPI-17720)", () => {
    const text = "github_pat_SYNTHETIC_QA_ONLY_1234567890 api_key=synthetic-qa-only";
    const redacted = redactText(text);
    expect(redacted).not.toContain("github_pat_SYNTHETIC_QA_ONLY_1234567890");
    expect(redacted).not.toContain("synthetic-qa-only");
    expect(redacted).toContain("[REDACTED]");
  });

  it("redacts common token prefixes and key/value assignments", () => {
    const text = [
      "classic ghp_abcdefghijklmnopqrstuvwxyz012345ABCD",
      "openai sk-abcdefghijklmnopqrstuvwx",
      "config token: super-secret-value",
      "password=hunter2-long-enough",
    ].join("\n");
    const redacted = redactText(text);
    expect(redacted).not.toMatch(/ghp_|sk-abcdef|super-secret-value|hunter2/u);
  });

  it("leaves ordinary prose untouched", () => {
    const text = "The bridge listens on 127.0.0.1 and reports status connected.";
    expect(redactText(text)).toBe(text);
  });

  it("recursively redacts sensitive keys without hiding safe status fields", () => {
    const value = {
      status: "connected",
      nested: {
        apiKey: "secret-one",
        authorization: "Bearer secret-two",
        message: "safe",
      },
      tokens: ["secret-three"],
    };
    const redacted = redactValue(value, ["secret-three"]);
    expect(redacted).toEqual({
      status: "connected",
      nested: {
        apiKey: "[REDACTED]",
        authorization: "[REDACTED]",
        message: "safe",
      },
      tokens: "[REDACTED]",
    });
    expect(JSON.stringify(redacted)).not.toMatch(/secret-(?:one|two|three)/u);
  });
});
