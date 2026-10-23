import { describe, expect, it } from "vitest";

import {
  OPENCODE_BRIDGE_TOKEN_ENV,
  configuredOpenCodeModel,
  hasOpenCodeProvider,
  mappingMatchesOpenCode,
  mergeOpenCodeMapping,
  rebaseOpenCodeRollbackSource,
} from "../../src/config/opencode-json.js";

const mapping = {
  model: "Qwen3.6-35B-A3B",
  baseUrl: "http://127.0.0.1:43123/v1",
  credentialFile: "/private/krutrim-connect/runtime/opencode.token",
};

describe("OpenCode configuration mapping", () => {
  it("adds a v2 managed provider when the existing configuration uses providers", () => {
    const updated = mergeOpenCodeMapping(JSON.stringify({ autoupdate: false, providers: { existing: { name: "Existing" } } }), mapping, {
      allowExistingProvider: false,
    });
    const value = JSON.parse(updated) as Record<string, unknown>;
    expect(value.autoupdate).toBe(false);
    expect(value.model).toBe("krutrim/Qwen3.6-35B-A3B");
    expect(value.providers).toMatchObject({
      existing: { name: "Existing" },
      krutrim: {
        package: "@opencode-ai/ai/providers/openai-compatible",
        settings: {
          baseURL: mapping.baseUrl,
          apiKey: `{file:${mapping.credentialFile}}`,
        },
      },
    });
    expect(updated).not.toContain(OPENCODE_BRIDGE_TOKEN_ENV);
    expect(mappingMatchesOpenCode(updated, mapping)).toBe(true);
    expect(configuredOpenCodeModel(updated)).toBe(mapping.model);
  });

  it("adds a v1 managed provider when the existing configuration uses provider", () => {
    const updated = mergeOpenCodeMapping(JSON.stringify({ provider: { existing: { name: "Existing" } } }), mapping, {
      allowExistingProvider: false,
    });
    const value = JSON.parse(updated) as Record<string, unknown>;
    expect(value.model).toBe("krutrim/Qwen3.6-35B-A3B");
    expect(value.provider).toMatchObject({
      existing: { name: "Existing" },
      krutrim: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: mapping.baseUrl,
          apiKey: `{file:${mapping.credentialFile}}`,
        },
      },
    });
    expect(value).not.toHaveProperty("providers");
    expect(mappingMatchesOpenCode(updated, mapping)).toBe(true);
  });

  it("continues to recognize legacy environment-token mappings during upgrade", () => {
    const legacyMapping = {
      model: mapping.model,
      baseUrl: mapping.baseUrl,
    };
    const updated = mergeOpenCodeMapping("{}", legacyMapping, {
      allowExistingProvider: false,
    });
    expect(updated).toContain(`{env:${OPENCODE_BRIDGE_TOKEN_ENV}}`);
    expect(mappingMatchesOpenCode(updated, legacyMapping)).toBe(true);
    expect(mappingMatchesOpenCode(updated, mapping)).toBe(false);
  });

  it("rejects a credential path that could escape file substitution", () => {
    expect(() => mergeOpenCodeMapping("{}", {
      ...mapping,
      credentialFile: "/private/token}suffix",
    }, { allowExistingProvider: false })).toThrow(/not safe/u);
  });

  it("refuses to overwrite an unmanaged Krutrim provider", () => {
    expect(() => mergeOpenCodeMapping(JSON.stringify({ providers: { krutrim: { name: "manual" } } }), mapping, {
      allowExistingProvider: false,
    })).toThrow(/Refusing to overwrite unmanaged/u);
  });

  it("rebases rollback onto unrelated configuration changes", () => {
    const baseline = JSON.stringify({ model: "openai/original", autoupdate: false });
    const connected = mergeOpenCodeMapping(baseline, mapping, { allowExistingProvider: false });
    const current = JSON.parse(connected) as Record<string, unknown>;
    current.watcher = { ignore: ["generated/**"] };
    const rebased = rebaseOpenCodeRollbackSource(JSON.stringify(current), baseline);
    expect(JSON.parse(rebased)).toEqual({
      model: "openai/original",
      autoupdate: false,
      watcher: { ignore: ["generated/**"] },
    });
    expect(hasOpenCodeProvider(rebased)).toBe(false);
  });

  it("removes managed provider values from either schema during rollback rebasing", () => {
    const baseline = JSON.stringify({ provider: { existing: { name: "Existing" } } });
    const connected = mergeOpenCodeMapping(baseline, mapping, { allowExistingProvider: false });
    const current = JSON.parse(connected) as Record<string, unknown>;
    current.providers = {
      krutrim: {
        name: "Krutrim Cloud",
      },
    };
    const rebased = rebaseOpenCodeRollbackSource(JSON.stringify(current), baseline);
    expect(JSON.parse(rebased)).toEqual({ provider: { existing: { name: "Existing" } } });
  });
});
