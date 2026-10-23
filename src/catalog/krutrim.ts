export const KRUTRIM_CATALOG_SOURCE =
  "https://cloud.olakrutrim.com/console/inference-service?section=catalogue";
export const KRUTRIM_CATALOG_OBSERVED = "2026-08-12";

export const KRUTRIM_MODALITIES = [
  "text-generation",
  "multimodal",
] as const;

export type KrutrimModality = (typeof KRUTRIM_MODALITIES)[number];

export interface KrutrimCatalogModel {
  id: string;
  publisher: string;
  modality: KrutrimModality;
  pricing: {
    readonly currency: "INR";
    readonly unit: "1M tokens";
    readonly input: number;
    readonly output: number;
  };
}

export interface KrutrimCatalogSnapshot {
  provider: "krutrim";
  observed: string;
  source: string;
  live: false;
  models: readonly KrutrimCatalogModel[];
}

const MODELS: readonly KrutrimCatalogModel[] = [
  {
    id: "gpt-oss-20b",
    publisher: "openai",
    modality: "text-generation",
    pricing: { currency: "INR", unit: "1M tokens", input: 8, output: 32 },
  },
  {
    id: "gpt-oss-120b",
    publisher: "openai",
    modality: "text-generation",
    pricing: { currency: "INR", unit: "1M tokens", input: 13, output: 65 },
  },
  {
    id: "gemma-4-E4B-it",
    publisher: "google",
    modality: "multimodal",
    pricing: { currency: "INR", unit: "1M tokens", input: 3, output: 8 },
  },
  {
    id: "gemma-4-31b-it",
    publisher: "google",
    modality: "multimodal",
    pricing: { currency: "INR", unit: "1M tokens", input: 9, output: 33 },
  },
  {
    id: "gemma-4-26B-A4B-it",
    publisher: "google",
    modality: "multimodal",
    pricing: { currency: "INR", unit: "1M tokens", input: 7, output: 28 },
  },
  {
    id: "Qwen3.5-9B",
    publisher: "Qwen",
    modality: "multimodal",
    pricing: { currency: "INR", unit: "1M tokens", input: 3, output: 8 },
  },
  {
    id: "Qwen3.6-27B",
    publisher: "Qwen",
    modality: "multimodal",
    pricing: { currency: "INR", unit: "1M tokens", input: 23, output: 188 },
  },
  {
    id: "Qwen3.6-35B-A3B",
    publisher: "Qwen",
    modality: "multimodal",
    pricing: { currency: "INR", unit: "1M tokens", input: 7, output: 28 },
  },
];

export const KRUTRIM_CATALOG: KrutrimCatalogSnapshot = Object.freeze({
  provider: "krutrim",
  observed: KRUTRIM_CATALOG_OBSERVED,
  source: KRUTRIM_CATALOG_SOURCE,
  live: false,
  models: Object.freeze(
    MODELS.map((model) =>
      Object.freeze({ ...model, pricing: Object.freeze({ ...model.pricing }) }),
    ),
  ),
});

export interface ListKrutrimModelsOptions {
  modality?: KrutrimModality;
  publisher?: string;
  query?: string;
}

function includesFolded(value: string, query: string): boolean {
  return value.toLocaleLowerCase("en-US").includes(query.toLocaleLowerCase("en-US"));
}

export function listKrutrimModels(
  options: ListKrutrimModelsOptions = {},
): KrutrimCatalogModel[] {
  return KRUTRIM_CATALOG.models
    .filter((model) => options.modality === undefined || model.modality === options.modality)
    .filter(
      (model) => options.publisher === undefined || includesFolded(model.publisher, options.publisher),
    )
    .filter(
      (model) =>
        options.query === undefined ||
        includesFolded(model.id, options.query) ||
        includesFolded(model.publisher, options.query) ||
        includesFolded(model.modality, options.query),
    )
    .map((model) => ({ ...model, pricing: { ...model.pricing } }));
}

export function findKrutrimModel(id: string): KrutrimCatalogModel | undefined {
  const folded = id.toLocaleLowerCase("en-US");
  const model = KRUTRIM_CATALOG.models.find(
    (candidate) => candidate.id.toLocaleLowerCase("en-US") === folded,
  );
  return model === undefined ? undefined : { ...model, pricing: { ...model.pricing } };
}

export function isKrutrimModality(value: string): value is KrutrimModality {
  return (KRUTRIM_MODALITIES as readonly string[]).includes(value);
}
