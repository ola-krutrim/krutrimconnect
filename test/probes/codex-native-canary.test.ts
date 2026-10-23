import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runCodexNativeCanary } from "../../src/probes/codex-native-canary.js";

const model = "Qwen3.6-35B-A3B";
const apiKey = "native-canary-key-never-logged";
const catalog = "/safe/qwen-models.json";
const marker = "KRUTRIM_CONNECT_NATIVE_CODEX_CANARY_OK";

describe("native full Codex canary", () => {
  it("requires the isolated installed-Codex tool-loop marker", async () => {
    let isolatedHome = "";
    const result = await runCodexNativeCanary({
      model,
      apiKey,
      modelCatalogPath: catalog,
      processRunner: async (request) => {
        isolatedHome = request.env.CODEX_HOME!;
        await expect(access(isolatedHome)).resolves.toBeUndefined();
        expect(request.env.KRUTRIM_CONNECT_NATIVE_CANARY_KEY).toBe(apiKey);
        expect(request.args).toContain(`model_catalog_json=${JSON.stringify(catalog)}`);
        expect(request.args).toContain(
          'model_providers.krutrim_connect_native_canary.base_url="https://cloud.olakrutrim.com/v1"',
        );
        expect(request.args.at(-1)).toContain("Use the shell tool exactly once to run pwd");
        return { exitCode: 0, stdout: `${marker}\n`, stderr: "" };
      },
    });
    expect(result).toMatchObject({ status: "pass", check: { status: "pass" } });
    await expect(access(isolatedHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("classifies an EdgeSuite HTML 403 as a native conformance failure", async () => {
    const result = await runCodexNativeCanary({
      model,
      apiKey,
      modelCatalogPath: catalog,
      processRunner: async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "unexpected status 403 Forbidden: <HTML><H1>Access Denied</H1> errors.edgesuite.net",
      }),
    });
    expect(result).toMatchObject({
      status: "fail",
      check: {
        status: "fail",
        httpStatus: 403,
        detail: expect.stringContaining("EdgeSuite/Akamai"),
      },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("is inconclusive when the installed Codex executable cannot start", async () => {
    const result = await runCodexNativeCanary({
      model,
      apiKey,
      modelCatalogPath: catalog,
      processRunner: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        failure: "spawn",
      }),
    });
    expect(result).toMatchObject({ status: "inconclusive", check: { status: "fail" } });
  });
});
