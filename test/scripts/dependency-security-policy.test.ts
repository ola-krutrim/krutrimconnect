import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"));
const atLeast = (version: string, minimum: number[]) => {
  const parts = version.split(".").map(Number);
  for (let i = 0; i < minimum.length; i++) {
    if (parts[i] !== minimum[i]) return parts[i]! > minimum[i]!;
  }
  return true;
};

describe("dependency security baseline", () => {
  it("locks Vitest outside the published advisory ranges, including GHSA-qxg6-89mg-rqv8", () => {
    for (const name of ["vitest", "@vitest/mocker", "@vitest/coverage-v8"]) {
      expect(atLeast(lock.packages[`node_modules/${name}`].version, [4, 1, 12]), name).toBe(true);
    }
  });

  it("locks Vite and source-map-js outside their affected patch ranges", () => {
    expect(atLeast(lock.packages["node_modules/vite"].version, [6, 4, 5])).toBe(true);
    expect(atLeast(lock.packages["node_modules/source-map-js"].version, [1, 2, 2])).toBe(true);
  });

  it("locks fast-uri outside the affected ranges in GHSA-f65p-4m7j-42xc and GHSA-hrr3-gc8f-f4qj", () => {
    expect(atLeast(lock.packages["node_modules/fast-uri"].version, [3, 1, 8])).toBe(true);
  });
});
