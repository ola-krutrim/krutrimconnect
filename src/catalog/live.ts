import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteFile, ensurePrivateDirectory } from "../fs/atomic.js";
import {
  KRUTRIM_CATALOG,
  type KrutrimCatalogModel,
  type KrutrimModality,
} from "./krutrim.js";

export const LIVE_CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;

export type KrutrimModelAvailability = "available" | "unavailable" | "unlisted";

export interface RegistryModelMetadata {
  id: string;
  publisher?: string;
  modality?: string;
  contextLength?: number;
  pricing?: { input: number; output: number };
}

export interface MergedKrutrimCatalogModel {
  id: string;
  availability: KrutrimModelAvailability;
  metadataSource: "registry" | "snapshot" | "none";
  publisher?: string;
  modality?: string;
  contextLength?: number;
  pricing?: { input: number; output: number };
}

export interface MergedKrutrimCatalog {
  provider: "krutrim";
  live: true;
  fetched: string;
  snapshotObserved: string;
  models: readonly MergedKrutrimCatalogModel[];
}

export interface CachedLiveCatalog {
  catalog: MergedKrutrimCatalog;
  stale: boolean;
}

export function liveModelIdsFromEntries(entries: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      ids.push(id);
    }
  }
  return ids;
}

function foldId(id: string): string {
  return id.toLocaleLowerCase("en-US");
}

function parsePricingValue(value: unknown): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(\d+(?:\.\d+)?)\b/u.exec(value.trim());
  if (match?.[1] === undefined) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

export function registryModelsFromEntries(
  entries: readonly unknown[],
): RegistryModelMetadata[] {
  const rows: RegistryModelMetadata[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (candidate.artifactType !== "model" || typeof candidate.artifactName !== "string") {
      continue;
    }
    const row: RegistryModelMetadata = { id: candidate.artifactName };
    if (typeof candidate.userName === "string" && candidate.userName.length > 0) {
      row.publisher = candidate.userName;
    }
    const info = candidate.artifactInfo;
    if (info !== null && typeof info === "object") {
      const details = info as Record<string, unknown>;
      const tags = details.parentTags;
      if (Array.isArray(tags) && typeof tags[0] === "string" && tags[0].length > 0) {
        row.modality = tags[0];
      }
      if (typeof details.contextLength === "number" && Number.isFinite(details.contextLength)) {
        row.contextLength = details.contextLength;
      }
      const pricing = details.pricing;
      if (pricing !== null && typeof pricing === "object") {
        const input = parsePricingValue((pricing as Record<string, unknown>).input);
        const output = parsePricingValue((pricing as Record<string, unknown>).output);
        if (input !== null && output !== null) {
          row.pricing = { input, output };
        }
      }
    }
    rows.push(row);
  }
  return rows;
}

export function mergeLiveKrutrimCatalog(
  liveModelIds: readonly string[],
  registryModels: readonly RegistryModelMetadata[],
  fetchedAt: Date,
): MergedKrutrimCatalog {
  const liveById = new Map(liveModelIds.map((id) => [foldId(id), id]));
  const snapshotById = new Map(
    KRUTRIM_CATALOG.models.map((model) => [foldId(model.id), model]),
  );
  const models: MergedKrutrimCatalogModel[] = [];

  for (const registry of registryModels) {
    const key = foldId(registry.id);
    const live = liveById.delete(key);
    snapshotById.delete(key);
    models.push({
      id: registry.id,
      availability: live ? "available" : "unavailable",
      metadataSource: "registry",
      ...(registry.publisher === undefined ? {} : { publisher: registry.publisher }),
      ...(registry.modality === undefined ? {} : { modality: registry.modality }),
      ...(registry.contextLength === undefined ? {} : { contextLength: registry.contextLength }),
      ...(registry.pricing === undefined ? {} : { pricing: { ...registry.pricing } }),
    });
  }
  // A non-empty registry response is authoritative for support status.
  const registryAuthoritative = registryModels.length > 0;
  for (const snapshot of snapshotById.values()) {
    const live = liveById.delete(foldId(snapshot.id));
    models.push({
      id: snapshot.id,
      availability: live ? (registryAuthoritative ? "unlisted" : "available") : "unavailable",
      metadataSource: "snapshot",
      publisher: snapshot.publisher,
      modality: snapshot.modality,
      pricing: { input: snapshot.pricing.input, output: snapshot.pricing.output },
    });
  }
  for (const id of liveById.values()) {
    models.push({ id, availability: "unlisted", metadataSource: "none" });
  }

  return {
    provider: "krutrim",
    live: true,
    fetched: fetchedAt.toISOString(),
    snapshotObserved: KRUTRIM_CATALOG.observed,
    models,
  };
}

const MAX_CACHE_BYTES = 1024 * 1024;

export function isMergedCatalog(value: unknown): value is MergedKrutrimCatalog {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.provider === "krutrim" &&
    candidate.live === true &&
    typeof candidate.fetched === "string" &&
    !Number.isNaN(Date.parse(candidate.fetched)) &&
    typeof candidate.snapshotObserved === "string" &&
    Array.isArray(candidate.models) &&
    candidate.models.every(
      (model) =>
        model !== null &&
        typeof model === "object" &&
        typeof (model as { id?: unknown }).id === "string" &&
        typeof (model as { availability?: unknown }).availability === "string",
    )
  );
}

export async function readLiveCatalogCache(
  cacheFile: string,
  now: Date,
): Promise<CachedLiveCatalog | null> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(cacheFile);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_CACHE_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(cacheFile, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (!isMergedCatalog(parsed)) {
    return null;
  }
  const age = now.getTime() - Date.parse(parsed.fetched);
  return { catalog: parsed, stale: age > LIVE_CATALOG_CACHE_TTL_MS };
}

export async function writeLiveCatalogCache(
  cacheFile: string,
  catalog: MergedKrutrimCatalog,
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(cacheFile));
  await atomicWriteFile(cacheFile, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
}
