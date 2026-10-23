import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeLiveKrutrimCatalog } from "../../src/catalog/live.js";
import {
  MAX_PUBLISHED_CATALOG_BYTES,
  PUBLISHED_CATALOG_URL,
  fetchPublishedCatalog,
  readBundledCatalogFile,
} from "../../src/catalog/published.js";

describe("published catalogue fetch", () => {
  it("pins the published catalogue URL to the repository raw path", () => {
    expect(PUBLISHED_CATALOG_URL).toBe(
      "https://raw.githubusercontent.com/ola-krutrim/krutrimconnect/main/catalog/krutrim-live.json",
    );
  });

  it("returns a validated catalogue from a successful fetch", async () => {
    const catalog = mergeLiveKrutrimCatalog(["gpt-oss-20b"], [], new Date("2026-09-08T10:00:00Z"));
    const fetchImpl = (async () =>
      new Response(JSON.stringify(catalog), { status: 200 })) as typeof fetch;

    const fetched = await fetchPublishedCatalog(fetchImpl);

    expect(fetched).toEqual(catalog);
  });

  it("returns null on HTTP errors, junk payloads, and network failures", async () => {
    const notFound = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    expect(await fetchPublishedCatalog(notFound)).toBeNull();

    const junk = (async () => new Response("{not json", { status: 200 })) as typeof fetch;
    expect(await fetchPublishedCatalog(junk)).toBeNull();

    const wrongShape = (async () =>
      new Response(JSON.stringify({ provider: "other" }), { status: 200 })) as typeof fetch;
    expect(await fetchPublishedCatalog(wrongShape)).toBeNull();

    const network = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await fetchPublishedCatalog(network)).toBeNull();
  });

  it("rejects oversized payloads instead of parsing them", async () => {
    const oversized = "x".repeat(MAX_PUBLISHED_CATALOG_BYTES + 1);
    const fetchImpl = (async () => new Response(oversized, { status: 200 })) as typeof fetch;
    expect(await fetchPublishedCatalog(fetchImpl)).toBeNull();
  });
});

describe("bundled catalogue file", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "krutrim-bundled-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads and validates a bundled catalogue file", async () => {
    const catalog = mergeLiveKrutrimCatalog(["gpt-oss-20b"], [], new Date("2026-09-08T10:00:00Z"));
    const file = path.join(dir, "krutrim-live.json");
    await writeFile(file, JSON.stringify(catalog), "utf8");

    expect(await readBundledCatalogFile(file)).toEqual(catalog);
  });

  it("returns null for missing, corrupt, or wrong-shape bundled files", async () => {
    expect(await readBundledCatalogFile(path.join(dir, "missing.json"))).toBeNull();

    const corrupt = path.join(dir, "corrupt.json");
    await writeFile(corrupt, "{nope", "utf8");
    expect(await readBundledCatalogFile(corrupt)).toBeNull();

    const wrongShape = path.join(dir, "wrong.json");
    await writeFile(wrongShape, JSON.stringify({ provider: "other" }), "utf8");
    expect(await readBundledCatalogFile(wrongShape)).toBeNull();
  });
});
