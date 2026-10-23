import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCodexModelCatalog,
  fetchKrutrimModelMetadata,
  managedCodexModelCatalogIsIntact,
  prepareCodexModelCatalog,
  removeManagedCodexModelCatalog,
  type KrutrimLiveModelMetadata,
} from "../../src/codex/model-catalog.js";
import { resolveRuntimePaths } from "../../src/paths.js";

const roots: string[] = [];
const model = "gpt-oss-20b";
const apiKey = "catalog-test-key-never-persist";

const metadata: KrutrimLiveModelMetadata = {
  id: model,
  name: "GPT OSS 20B",
  contextLength: 131_072,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportedParameters: ["max_tokens", "temperature"],
  supportedFeatures: [],
  description: "Krutrim deployment metadata",
  modelEndpoint: "https://cloud.olakrutrim.com/v1/chat/completions",
  observedAt: "2026-08-13T00:00:00.000Z",
};

const template = {
  slug: "gpt-5.6-terra",
  display_name: "Template",
  description: "template",
  base_instructions: "You are Codex based on GPT-5.\n\nKeep working until done.",
  model_messages: {
    instructions_template: "You are Codex based on GPT-5.\n\nKeep working until done.",
    instructions_variables: {},
  },
  context_window: 258_400,
  max_context_window: 258_400,
  input_modalities: ["text", "image"],
  apply_patch_tool_type: "freeform",
  tool_mode: "code_mode_only",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("managed Codex model catalogue", () => {
  it("reads only the exact authenticated Krutrim deployment entry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
      expect(init?.redirect).toBe("manual");
      return Response.json({
        object: "list",
        data: [{
          id: model,
          name: "GPT OSS 20B",
          context_length: 131_072,
          input_modalities: ["text"],
          output_modalities: ["text"],
          supported_parameters: ["max_tokens"],
          supported_features: [],
          description: "Krutrim deployment metadata",
          model_endpoint: "https://cloud.olakrutrim.com/v1/chat/completions",
        }],
      });
    });

    await expect(fetchKrutrimModelMetadata(
      model,
      apiKey,
      fetchImpl,
      () => new Date("2026-08-13T00:00:00.000Z"),
    )).resolves.toMatchObject({ id: model, contextLength: 131_072 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://cloud.olakrutrim.com/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("builds one text-only model with Krutrim identity and deployment context", () => {
    const catalog = buildCodexModelCatalog(metadata, template, "bridge") as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]).toMatchObject({
      slug: model,
      display_name: "GPT OSS 20B (Krutrim)",
      context_window: 131_072,
      max_context_window: 131_072,
      input_modalities: ["text"],
      supported_reasoning_levels: [],
      default_reasoning_level: null,
    });
    expect(catalog.models[0]?.base_instructions).toContain(
      `powered by the ${model} model served by Krutrim through KrutrimConnect`,
    );
    expect(catalog.models[0]?.base_instructions).not.toContain("based on GPT-5");
    expect(catalog.models[0]?.tool_mode).toBe("direct");
    expect(catalog.models[0]?.apply_patch_tool_type).toBeNull();
  });

  it("preserves the installed tool contract for native Responses models", () => {
    const catalog = buildCodexModelCatalog(metadata, template, "native") as {
      models: Array<Record<string, unknown>>;
    };
    expect(catalog.models[0]?.tool_mode).toBe("code_mode_only");
    expect(catalog.models[0]?.apply_patch_tool_type).toBe("freeform");
  });

  it("writes a private content-addressed catalogue and removes only intact managed content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "krutrim-connect-catalog-test-"));
    roots.push(root);
    const paths = resolveRuntimePaths(
      { KRUTRIM_CONNECT_HOME: path.join(root, "app"), CODEX_HOME: path.join(root, "codex") },
      root,
    );
    const prepared = await prepareCodexModelCatalog(paths, {
      model,
      apiKey,
      mode: "bridge",
      metadataResolver: async () => metadata,
      templateLoader: async () => structuredClone(template),
    });
    expect(path.dirname(prepared.path)).toBe(paths.codexModelCatalogDir);
    expect(path.basename(prepared.path)).toBe(`${prepared.sha256}.json`);
    expect(await managedCodexModelCatalogIsIntact(paths, prepared.path, prepared.sha256)).toBe(true);
    expect(await readFile(prepared.path, "utf8")).not.toContain(apiKey);
    await expect(removeManagedCodexModelCatalog(paths, prepared.path, "0".repeat(64))).resolves.toBe(false);
    await expect(removeManagedCodexModelCatalog(paths, prepared.path, prepared.sha256)).resolves.toBe(true);
    await expect(managedCodexModelCatalogIsIntact(paths, prepared.path, prepared.sha256)).resolves.toBe(false);
  });
});
