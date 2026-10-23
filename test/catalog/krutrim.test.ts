import { describe, expect, it } from "vitest";

import {
  KRUTRIM_CATALOG,
  findKrutrimModel,
  isKrutrimModality,
  listKrutrimModels,
} from "../../src/catalog/krutrim.js";

describe("bundled Krutrim model catalogue", () => {
  it("identifies itself as a dated non-live snapshot", () => {
    expect(KRUTRIM_CATALOG).toMatchObject({
      provider: "krutrim",
      observed: "2026-08-12",
      source: "https://cloud.olakrutrim.com/console/inference-service?section=catalogue",
      live: false,
    });
    expect(KRUTRIM_CATALOG.models).toHaveLength(8);
    expect(KRUTRIM_CATALOG.models.map((model) => model.id)).toEqual([
      "gpt-oss-20b",
      "gpt-oss-120b",
      "gemma-4-E4B-it",
      "gemma-4-31b-it",
      "gemma-4-26B-A4B-it",
      "Qwen3.5-9B",
      "Qwen3.6-27B",
      "Qwen3.6-35B-A3B",
    ]);
  });

  it("filters by modality, publisher, and free-text query without changing the snapshot", () => {
    expect(listKrutrimModels({ modality: "text-generation" })).toHaveLength(2);
    expect(listKrutrimModels({ publisher: "qwen" }).map((model) => model.id)).toEqual([
      "Qwen3.5-9B",
      "Qwen3.6-27B",
      "Qwen3.6-35B-A3B",
    ]);
    expect(listKrutrimModels({ query: "oss" }).map((model) => model.id)).toEqual([
      "gpt-oss-20b",
      "gpt-oss-120b",
    ]);
    expect(KRUTRIM_CATALOG.models).toHaveLength(8);
  });

  it("finds an exact model id case-insensitively while preserving the console id", () => {
    expect(findKrutrimModel("qwen3.6-35b-a3b")).toEqual({
      id: "Qwen3.6-35B-A3B",
      publisher: "Qwen",
      modality: "multimodal",
      pricing: { currency: "INR", unit: "1M tokens", input: 7, output: 28 },
    });
    expect(findKrutrimModel("missing-model")).toBeUndefined();
  });

  it("validates supported modality filters", () => {
    expect(isKrutrimModality("text-generation")).toBe(true);
    expect(isKrutrimModality("video-generation")).toBe(false);
  });
});
