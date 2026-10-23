import { readFile } from "node:fs/promises";

import { isMergedCatalog, type MergedKrutrimCatalog } from "./live.js";
import { ConfigurationError } from "../errors.js";

export const PUBLISHED_CATALOG_URL =
  "https://raw.githubusercontent.com/ola-krutrim/krutrimconnect/main/catalog/krutrim-live.json";
export const MAX_PUBLISHED_CATALOG_BYTES = 1024 * 1024;
const PUBLISHED_FETCH_TIMEOUT_MS = 10_000;

function assertFixedPublishedEndpoint(): void {
  const endpoint = new URL(PUBLISHED_CATALOG_URL);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.origin !== "https://raw.githubusercontent.com" ||
    !endpoint.pathname.startsWith("/ola-krutrim/krutrimconnect/") ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ConfigurationError(
      "The published Krutrim catalogue endpoint failed the fixed-origin safety check.",
    );
  }
}

export async function fetchPublishedCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<MergedKrutrimCatalog | null> {
  assertFixedPublishedEndpoint();
  try {
    const response = await fetchImpl(PUBLISHED_CATALOG_URL, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(PUBLISHED_FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const body = await response.arrayBuffer();
    if (body.byteLength > MAX_PUBLISHED_CATALOG_BYTES) {
      return null;
    }
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
    return isMergedCatalog(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readBundledCatalogFile(
  file: string,
): Promise<MergedKrutrimCatalog | null> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  if (raw.length > MAX_PUBLISHED_CATALOG_BYTES) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  return isMergedCatalog(parsed) ? parsed : null;
}
