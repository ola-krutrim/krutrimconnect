import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KRUTRIM_CATALOG } from "../../src/catalog/krutrim.js";
import {
  LIVE_CATALOG_CACHE_TTL_MS,
  liveModelIdsFromEntries,
  mergeLiveKrutrimCatalog,
  readLiveCatalogCache,
  registryModelsFromEntries,
  writeLiveCatalogCache,
  type MergedKrutrimCatalog,
} from "../../src/catalog/live.js";

const REGISTRY_ENTRY = {
  userName: "openai",
  artifactType: "model",
  artifactName: "gpt-oss-20b",
  artifactInfo: {
    parentTags: ["text-generation"],
    status: "active",
    contextLength: 131072,
    pricing: { input: "8.0 Input", output: "32.0 Output", unit: "/1M Tokens" },
  },
};

describe("registry catalogue parsing", () => {
  it("extracts metadata rows from artifact-registry entries and rejects junk", () => {
    const rows = registryModelsFromEntries([
      REGISTRY_ENTRY,
      {
        userName: "zai",
        artifactType: "model",
        artifactName: "GLM-5.3-Flash",
        artifactInfo: {
          parentTags: ["text-generation"],
          status: "active",
          pricing: { input: "6.5 Input", output: "26.0 Output", unit: "/1M Tokens" },
        },
      },
      { artifactType: "dataset", artifactName: "not-a-model" },
      { artifactType: "model" },
      "junk",
      null,
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "gpt-oss-20b",
      publisher: "openai",
      modality: "text-generation",
      contextLength: 131072,
      pricing: { input: 8, output: 32 },
    });
    expect(rows[1]?.id).toBe("GLM-5.3-Flash");
    expect(rows[1]?.pricing).toEqual({ input: 6.5, output: 26 });
    expect(rows[1]?.contextLength).toBeUndefined();
  });

  it("omits pricing it cannot parse instead of guessing", () => {
    const rows = registryModelsFromEntries([
      {
        artifactType: "model",
        artifactName: "weird",
        artifactInfo: { pricing: { input: "call us", output: null } },
      },
    ]);
    expect(rows[0]).toEqual({ id: "weird" });
  });
});

describe("live Krutrim catalogue merge", () => {
  it("extracts model ids from OpenAI-style /v1/models entries and rejects junk", () => {
    expect(
      liveModelIdsFromEntries([
        { id: "gpt-oss-20b", object: "model" },
        { id: "Qwen3.5-9B" },
        { object: "model" },
        "not-an-object",
        { id: 42 },
      ]),
    ).toEqual(["gpt-oss-20b", "Qwen3.5-9B"]);
  });

  it("tags snapshot models as available or unavailable and live-only models as unlisted", () => {
    const liveIds = ["gpt-oss-20b", "gpt-oss-120b", "some-new-model"];

    const merged = mergeLiveKrutrimCatalog(liveIds, [], new Date("2026-09-08T00:00:00Z"));

    const byId = new Map(merged.models.map((model) => [model.id, model]));
    expect(byId.get("gpt-oss-20b")?.availability).toBe("available");
    expect(byId.get("gpt-oss-20b")?.pricing?.input).toBe(8);
    expect(byId.get("gpt-oss-120b")?.availability).toBe("available");
    expect(byId.get("some-new-model")).toEqual({
      id: "some-new-model",
      availability: "unlisted",
      metadataSource: "none",
    });
    expect(byId.get("Qwen3.5-9B")?.availability).toBe("unavailable");
    expect(merged.live).toBe(true);
    expect(merged.fetched).toBe("2026-09-08T00:00:00.000Z");
    expect(merged.snapshotObserved).toBe(KRUTRIM_CATALOG.observed);
    expect(merged.models).toHaveLength(KRUTRIM_CATALOG.models.length + 1);
  });

  it("prefers live registry metadata over the snapshot and covers snapshot-unknown models", () => {
    const registry = registryModelsFromEntries([
      REGISTRY_ENTRY,
      {
        userName: "zai",
        artifactType: "model",
        artifactName: "GLM-5.3-Flash",
        artifactInfo: {
          parentTags: ["text-generation"],
          status: "active",
          contextLength: 128000,
          pricing: { input: "6.5 Input", output: "26.0 Output", unit: "/1M Tokens" },
        },
      },
    ]);

    const merged = mergeLiveKrutrimCatalog(
      ["gpt-oss-20b", "GLM-5.3-Flash", "gpt-oss-120b-at"],
      registry,
      new Date("2026-09-08T00:00:00Z"),
    );

    const byId = new Map(merged.models.map((model) => [model.id, model]));
    expect(byId.get("gpt-oss-20b")).toMatchObject({
      availability: "available",
      metadataSource: "registry",
      publisher: "openai",
      contextLength: 131072,
      pricing: { input: 8, output: 32 },
    });
    expect(byId.get("GLM-5.3-Flash")).toMatchObject({
      availability: "available",
      metadataSource: "registry",
      pricing: { input: 6.5, output: 26 },
    });
    expect(byId.get("gpt-oss-120b-at")).toMatchObject({
      availability: "unlisted",
      metadataSource: "none",
    });
    expect(byId.get("gpt-oss-120b")).toMatchObject({
      availability: "unavailable",
      metadataSource: "snapshot",
    });
  });

  it("demotes registry-dropped snapshot models to unlisted when the registry responded", () => {
    // Krutrim can keep serving a model id on /v1/models after removing it from
    // the supported catalogue (KAPI-17751: Qwen3.6-27B). A trusted registry
    // response is the support authority: routable-but-unregistered models must
    // not appear as "available".
    const merged = mergeLiveKrutrimCatalog(
      ["gpt-oss-20b", "Qwen3.6-27B"],
      registryModelsFromEntries([REGISTRY_ENTRY]),
      new Date("2026-09-18T00:00:00Z"),
    );

    const byId = new Map(merged.models.map((model) => [model.id, model]));
    expect(byId.get("gpt-oss-20b")).toMatchObject({
      availability: "available",
      metadataSource: "registry",
    });
    expect(byId.get("Qwen3.6-27B")).toMatchObject({
      availability: "unlisted",
      metadataSource: "snapshot",
    });
    // Not routable and not registered: stays unavailable, not unlisted.
    expect(byId.get("gpt-oss-120b")).toMatchObject({
      availability: "unavailable",
      metadataSource: "snapshot",
    });
  });

  it("keeps snapshot availability when the registry fetch degraded to empty", () => {
    const merged = mergeLiveKrutrimCatalog(["Qwen3.6-27B"], [], new Date());
    const row = merged.models.find((model) => model.id === "Qwen3.6-27B");
    expect(row).toMatchObject({ availability: "available", metadataSource: "snapshot" });
  });

  it("marks snapshot metadata provenance on merged rows", () => {
    const merged = mergeLiveKrutrimCatalog(["gpt-oss-20b"], [], new Date());
    const available = merged.models.find((model) => model.id === "gpt-oss-20b");
    expect(available?.metadataSource).toBe("snapshot");
  });
});

describe("live Krutrim catalogue cache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "krutrim-live-cache-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function cacheFile(): string {
    return path.join(dir, "live-catalog.json");
  }

  it("round-trips a merged catalogue through the cache file", async () => {
    const merged = mergeLiveKrutrimCatalog(["gpt-oss-20b"], [], new Date("2026-09-08T10:00:00Z"));

    await writeLiveCatalogCache(cacheFile(), merged);
    const restored = await readLiveCatalogCache(cacheFile(), new Date("2026-09-08T10:30:00Z"));

    expect(restored?.stale).toBe(false);
    expect(restored?.catalog).toEqual(merged);
  });

  it("returns the cache as stale after the TTL and null when missing", async () => {
    const merged = mergeLiveKrutrimCatalog(["gpt-oss-20b"], [], new Date("2026-09-08T10:00:00Z"));
    await writeLiveCatalogCache(cacheFile(), merged);

    const afterTtl = new Date(
      new Date("2026-09-08T10:00:00Z").getTime() + LIVE_CATALOG_CACHE_TTL_MS + 1,
    );
    const stale = await readLiveCatalogCache(cacheFile(), afterTtl);
    expect(stale?.stale).toBe(true);
    expect(stale?.catalog.models.length).toBeGreaterThan(0);

    expect(await readLiveCatalogCache(path.join(dir, "missing.json"), new Date())).toBeNull();
  });

  it("ignores a corrupt or wrong-shape cache file instead of throwing", async () => {
    await writeFile(cacheFile(), "{not json", "utf8");
    expect(await readLiveCatalogCache(cacheFile(), new Date())).toBeNull();

    await writeFile(cacheFile(), JSON.stringify({ fetched: 12, models: "nope" }), "utf8");
    expect(await readLiveCatalogCache(cacheFile(), new Date())).toBeNull();
  });

  it("writes the cache file with owner-only permissions", async () => {
    const merged: MergedKrutrimCatalog = mergeLiveKrutrimCatalog([], [], new Date());
    await writeLiveCatalogCache(cacheFile(), merged);
    const raw = JSON.parse(await readFile(cacheFile(), "utf8")) as unknown;
    expect(raw).toEqual(merged);
    if (process.platform !== "win32") {
      const { stat } = await import("node:fs/promises");
      const info = await stat(cacheFile());
      expect(info.mode & 0o077).toBe(0);
    }
  });
});
