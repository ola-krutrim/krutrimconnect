import { access } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  runCodexBridgeCanary,
  type CodexCanaryProcessRunner,
} from "../../src/probes/codex-bridge-canary.js";

const model = "Krutrim-Full-Codex-Canary-Model";
const apiKey = "full-codex-canary-key-never-logged";
const marker = "KRUTRIM_CONNECT_FULL_CODEX_CANARY_OK";

function upstreamTextStream(text: string): Response {
  const source = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(source, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function upstreamToolStream(): Response {
  const source = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_canary", type: "function", function: { name: "read_file", arguments: "{\"path\":\".\"}" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  return new Response(source, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function configValue(args: string[], key: string): string {
  const source = args.find((value) => value.startsWith(`${key}=`));
  if (source === undefined) {
    throw new Error(`Missing ${key}`);
  }
  return JSON.parse(source.slice(key.length + 1)) as string;
}

describe("full Codex bridge canary", () => {
  it("requires an actual authenticated Responses request and exact final marker", async () => {
    let upstreamRequest = 0;
    let isolatedCodexHome = "";
    const upstream = vi.fn<typeof fetch>(async () => {
      upstreamRequest += 1;
      return upstreamRequest === 1 ? upstreamToolStream() : upstreamTextStream(marker);
    });
    const processRunner: CodexCanaryProcessRunner = async (request) => {
      isolatedCodexHome = request.env.CODEX_HOME!;
      await expect(access(isolatedCodexHome)).resolves.toBeUndefined();
      expect(request.cwd).toBe(isolatedCodexHome);
      expect(request.args).toContain("--ephemeral");
      expect(request.args).toContain("read-only");
      expect(request.args).toContain("features.hooks=false");
      expect(request.args).toContain('model_catalog_json="/safe/models.json"');
      expect(request.args.at(-1)).toContain(
        'Call the exec_command function exactly once with the JSON arguments {"cmd":"pwd"}.',
      );
      expect(request.args.at(-1)).toContain("Do not call write_stdin or any other tool.");
      const baseUrl = configValue(
        request.args,
        "model_providers.krutrim_connect_canary.base_url",
      );
      const bearer = request.env.KRUTRIM_CONNECT_CANARY_BEARER;
      expect(typeof bearer).toBe("string");

      const models = await fetch(`${baseUrl}/models?client_version=test`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      expect(await models.json()).toEqual({
        object: "list",
        data: [{ id: model, object: "model", created: 0, owned_by: "krutrim" }],
      });

      const first = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: true,
          input: `Reply with exactly ${marker}.`,
          tools: [{
            type: "function",
            name: "read_file",
            description: "Read a file during a representative Codex request.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          }],
          tool_choice: "auto",
        }),
      });
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("response.function_call_arguments.done");

      const second = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          stream: true,
          input: [
            { type: "function_call", call_id: "call_canary", name: "read_file", arguments: '{"path":"."}' },
            { type: "function_call_output", call_id: "call_canary", output: "/workspace" },
          ],
          tools: [{
            type: "function",
            name: "read_file",
            description: "Read a file during a representative Codex request.",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          }],
          tool_choice: "auto",
        }),
      });
      expect(second.status).toBe(200);
      expect(await second.text()).toContain(marker);
      return { exitCode: 0, stdout: `${marker}\n`, stderr: "" };
    };

    const result = await runCodexBridgeCanary({
      model,
      apiKey,
      modelCatalogPath: "/safe/models.json",
      fetchImpl: upstream,
      processRunner,
    });

    expect(result.status).toBe("pass");
    await expect(access(isolatedCodexHome)).rejects.toMatchObject({ code: "ENOENT" });
    expect(upstream).toHaveBeenCalledTimes(2);
    const upstreamHeaders = new Headers(upstream.mock.calls[0]![1]?.headers);
    expect(upstreamHeaders.get("Authorization")).toBe(`Bearer ${apiKey}`);
  });

  it("reports safe stream-shape diagnostics when Chat returns reasoning but no assistant output", async () => {
    const reasoningOnly = new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "hidden reasoning" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
    const result = await runCodexBridgeCanary({
      model,
      apiKey,
      modelCatalogPath: "/safe/models.json",
      fetchImpl: vi.fn(async () => reasoningOnly) as unknown as typeof fetch,
      processRunner: async (request) => {
        const baseUrl = configValue(
          request.args,
          "model_providers.krutrim_connect_canary.base_url",
        );
        const response = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${request.env.KRUTRIM_CONNECT_CANARY_BEARER}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, stream: true, input: "canary" }),
        });
        await response.text();
        return {
          exitCode: 1,
          stdout: "",
          stderr: "stream disconnected before completion",
        };
      },
    });

    expect(result).toMatchObject({ status: "fail" });
    expect(result.detail).toContain(
      "chat=stage=stream-complete,chunks=2,reasoning=1,text=0,tools=0,tool-fragments=0,finish=stop",
    );
    expect(result.detail).toContain("codex-error=response-stream-ended");
    expect(result.detail).toContain(
      "bridge-errors=Krutrim Chat Completions completed without assistant text or a tool call.",
    );
    expect(result.detail).not.toContain("hidden reasoning");
    expect(result.detail).not.toContain(apiKey);
  });

  it("fails qualification when Codex reaches the bridge but inference fails", async () => {
    const processRunner: CodexCanaryProcessRunner = async (request) => {
      const baseUrl = configValue(
        request.args,
        "model_providers.krutrim_connect_canary.base_url",
      );
      const response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${request.env.KRUTRIM_CONNECT_CANARY_BEARER}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model, stream: true, input: "canary" }),
      });
      await response.body?.cancel();
      return {
        exitCode: 1,
        stdout: "",
        stderr: 'ERROR: {"error":{"message":"Krutrim rejected the bridged request (HTTP 400)."}}',
      };
    };
    const result = await runCodexBridgeCanary({
      model,
      apiKey,
      modelCatalogPath: "/safe/models.json",
      fetchImpl: vi.fn(async () => new Response(null, { status: 400 })) as unknown as typeof fetch,
      processRunner,
    });

    expect(result).toMatchObject({ status: "fail" });
    expect(result.detail).toContain("codex-error=upstream-request-rejected");
    expect(result.detail).toContain("bridge-errors=Krutrim rejected the bridged request (HTTP 400).");
    expect(result.detail).not.toContain(apiKey);
  });

  it("is inconclusive when the Codex executable cannot start", async () => {
    const result = await runCodexBridgeCanary({
      model,
      apiKey,
      modelCatalogPath: "/safe/models.json",
      processRunner: async () => ({
        exitCode: null,
        stdout: "",
        stderr: "",
        failure: "spawn",
      }),
    });
    expect(result).toMatchObject({ status: "inconclusive" });
  });

  it("fails when Codex reports fallback model metadata", async () => {
    const result = await runCodexBridgeCanary({
      model,
      apiKey,
      modelCatalogPath: "/safe/models.json",
      processRunner: async (request) => {
        const baseUrl = configValue(
          request.args,
          "model_providers.krutrim_connect_canary.base_url",
        );
        const response = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${request.env.KRUTRIM_CONNECT_CANARY_BEARER}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model, stream: true, input: "canary" }),
        });
        await response.body?.cancel();
        return {
          exitCode: 0,
          stdout: `${marker}\n`,
          stderr: `Model metadata for '${model}' not found. Defaulting to fallback metadata.`,
        };
      },
      fetchImpl: vi.fn(async () => upstreamTextStream(marker)) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("missing model metadata"),
    });
  });
});
