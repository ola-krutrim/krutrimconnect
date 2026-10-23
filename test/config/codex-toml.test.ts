import { describe, expect, it } from "vitest";

import {
  CODEX_PROVIDER_ID,
  mappingMatches,
  mergeCodexMapping,
  parseCodexToml,
  rebaseCodexRollbackSource,
  type CodexManagedMapping,
} from "../../src/config/codex-toml.js";

const mapping: CodexManagedMapping = {
  model: "Krutrim-2",
  providerId: CODEX_PROVIDER_ID,
  displayName: "Krutrim Cloud",
  baseUrl: "https://cloud.olakrutrim.com/v1",
  modelCatalogPath: "/absolute/krutrim-connect/models.json",
  helper: {
    command: "/absolute/node",
    args: ["/absolute/krutrimconnect.js", "_credential", "read"],
  },
};

describe("Codex TOML merging", () => {
  it("preserves comments and unrelated configuration", () => {
    const source = `# keep this top-level comment
model = "original-model" # keep this inline comment
model_reasoning_effort = "high"
large_integer = 9_223_372_036_854_775_807

[mcp_servers.example]
# keep this server comment
url = "https://example.invalid/mcp"
enabled = false

[[example.rules]]
name = "first"
`;

    const merged = mergeCodexMapping(source, mapping, { allowExistingProvider: false });
    const parsed = parseCodexToml(merged);

    expect(mappingMatches(merged, mapping)).toBe(true);
    expect(merged).toContain("# keep this top-level comment");
    expect(merged).toContain("# keep this server comment");
    expect(parsed.model_reasoning_effort).toBe("high");
    expect(parsed.large_integer).toBe(9_223_372_036_854_775_807n);
    expect(parsed.mcp_servers).toEqual({
      example: { url: "https://example.invalid/mcp", enabled: false },
    });
    expect(parsed.model_providers).not.toHaveProperty(
      "krutrim.supports_standalone_web_search",
    );
    expect(parsed.example).toEqual({ rules: [{ name: "first" }] });
  });

  it("refuses to overwrite an unmanaged provider table", () => {
    const source = `[model_providers.krutrim]
name = "user-owned"
base_url = "https://example.invalid/v1"
`;
    expect(() => mergeCodexMapping(source, mapping, { allowExistingProvider: false })).toThrow(
      /unmanaged model_providers\.krutrim/u,
    );
  });

  it.each([
    'model_providers = "user-owned"\n',
    'model_providers = { krutrim = "user-owned" }\n',
    '[[model_providers.krutrim]]\nname = "user-owned"\n',
  ])("refuses every non-table or array collision", (source) => {
    expect(() => mergeCodexMapping(source, mapping, { allowExistingProvider: false })).toThrow(
      /refusing to overwrite/u,
    );
  });

  it("is textually idempotent once the managed mapping exists", () => {
    const once = mergeCodexMapping("# retained\n", mapping, { allowExistingProvider: false });
    const twice = mergeCodexMapping(once, mapping, { allowExistingProvider: true });
    expect(twice).toBe(once);
  });

  it("rebases rollback values while preserving unrelated post-connect settings", () => {
    const baseline = `# original\nmodel = "openai-default"\n\n[features]\napps = true\n`;
    const managed = mergeCodexMapping(baseline, mapping, { allowExistingProvider: false });
    const drifted = managed.replace(
      "\n[features]",
      '\nmodel_reasoning_effort = "high"\n\n[features]',
    ) + "\n[plugins.sites]\nenabled = true\n";

    const rebased = rebaseCodexRollbackSource(drifted, baseline);
    const parsed = parseCodexToml(rebased);
    expect(parsed.model).toBe("openai-default");
    expect(parsed.model_provider).toBeUndefined();
    expect(parsed.model_catalog_json).toBeUndefined();
    expect(parsed.model_providers).toBeUndefined();
    expect(parsed.model_reasoning_effort).toBe("high");
    expect(parsed.features).toEqual({ apps: true });
    expect(parsed.plugins).toEqual({ sites: { enabled: true } });
    expect(rebased).toContain("# original");
  });
});
