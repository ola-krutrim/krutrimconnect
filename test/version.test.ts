import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { KRUTRIM_CONNECT_VERSION } from "../src/version.js";

describe("package version", () => {
  it("keeps CLI version output bound to package.json", async () => {
    const metadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(KRUTRIM_CONNECT_VERSION).toBe(metadata.version);
  });
});
