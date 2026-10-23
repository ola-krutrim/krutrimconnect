#!/usr/bin/env node
// Refreshes catalog/krutrim-live.json from the live Krutrim endpoints.
// Requires KRUTRIM_API_KEY in the environment (CI secret). Exits non-zero on failure
// so the scheduled workflow surfaces breakage instead of committing junk.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  fetchKrutrimModelCatalogue,
  fetchKrutrimModelRegistry,
} from "../dist/auth.js";
import {
  liveModelIdsFromEntries,
  mergeLiveKrutrimCatalog,
  registryModelsFromEntries,
} from "../dist/catalog/live.js";

const apiKey = process.env.KRUTRIM_API_KEY;
if (typeof apiKey !== "string" || apiKey.length === 0) {
  console.error("KRUTRIM_API_KEY is not set.");
  process.exit(2);
}

const [entries, registryEntries] = await Promise.all([
  fetchKrutrimModelCatalogue(apiKey),
  fetchKrutrimModelRegistry(apiKey),
]);
const catalog = mergeLiveKrutrimCatalog(
  liveModelIdsFromEntries(entries),
  registryModelsFromEntries(registryEntries),
  new Date(),
);
const available = catalog.models.filter((model) => model.availability === "available");
if (available.length === 0) {
  console.error("Refusing to publish a catalogue with zero available models.");
  process.exit(1);
}

const file = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "catalog",
  "krutrim-live.json",
);
await writeFile(file, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`Wrote ${catalog.models.length} models (${available.length} available) to ${file}`);
