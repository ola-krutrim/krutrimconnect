import { readFile, readdir } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probeAndStoreKrutrimBridgeCapabilities,
  resolveKrutrimBridgeForModel,
} from "../../src/bridge/krutrim.js";
import { createTestWorkspace, testCatalogOptions, type TestWorkspace } from "../helpers.js";

const apiKey = "bridge-wrapper-key-never-persist";
const workspaces: TestWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (workspace) => await workspace.cleanup()));
});

describe("stored Krutrim bridge probes", () => {
  it("stores bridge evidence separately without changing native capability evidence", async () => {
    const workspace = await createTestWorkspace();
    workspaces.push(workspace);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 422 })) as unknown as typeof fetch;

    const result = await probeAndStoreKrutrimBridgeCapabilities(workspace.paths, {
      model: "Krutrim-Bridge-Model",
      apiKey,
      fetchImpl,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });
    const source = await readFile(result.evidencePath, "utf8");

    expect(result.report.outcome).toBe("inconclusive");
    expect(result.evidencePath.startsWith(workspace.paths.bridgeEvidenceDir)).toBe(true);
    expect(source).toContain("chat-direct-tools-deterministic-canary-v6");
    expect(source).not.toContain(apiKey);
    expect(await readdir(workspace.paths.capabilityEvidenceDir)).toEqual([".probe.lock"]);
  });

  it("rejects a credential-shaped model before bridge evidence is written", async () => {
    const workspace = await createTestWorkspace();
    workspaces.push(workspace);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      probeAndStoreKrutrimBridgeCapabilities(workspace.paths, {
        model: apiKey,
        apiKey,
        fetchImpl,
      }),
    ).rejects.toThrow(/model id contains the stored API key/u);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readdir(workspace.paths.bridgeEvidenceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores usable evidence only after the full Codex canary passes", async () => {
    const workspace = await createTestWorkspace();
    workspaces.push(workspace);
    let request = 0;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      request += 1;
      if (request === 1) {
        return new Response(null, { status: 401 });
      }
      if (request === 2) {
        return new Response(null, { status: 400 });
      }
      const body = JSON.parse(String(init?.body)) as {
        stream?: boolean;
        messages: Array<Record<string, unknown>>;
        tools?: Array<{ function: { name: string; parameters: { properties: { nonce: { enum: string[] } } } } }>;
      };
      if (request === 5) {
        const marker = String(body.messages.at(-1)?.content);
        return Response.json({
          choices: [{ message: { role: "assistant", content: marker }, finish_reason: "stop" }],
        });
      }
      const fn = body.tools![0]!.function;
      const nonce = fn.parameters.properties.nonce.enum[0]!;
      const toolCall = {
        index: 0,
        id: request === 3 ? "call_nonstream" : "call_stream",
        type: "function",
        function: { name: fn.name, arguments: JSON.stringify({ nonce }) },
      };
      if (body.stream === true) {
        const source =
          `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [toolCall] } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n` +
          "data: [DONE]\n\n";
        return new Response(source, { headers: { "Content-Type": "text/event-stream" } });
      }
      return Response.json({
        choices: [{
          message: { role: "assistant", content: null, tool_calls: [toolCall] },
          finish_reason: "tool_calls",
        }],
      });
    }) as unknown as typeof fetch;

    const result = await probeAndStoreKrutrimBridgeCapabilities(workspace.paths, {
      model: "Krutrim-Bridge-Qualified-Model",
      apiKey,
      fetchImpl,
      now: () => new Date("2026-08-12T12:00:00.000Z"),
      codexCanary: async () => ({
        status: "pass",
        detail: "A real ephemeral Codex request completed.",
      }),
      ...testCatalogOptions,
    });

    expect(result.report.outcome).toBe("streaming-compatible");
    expect(result.report.checks.codexCanary.status).toBe("pass");
    expect(
      await resolveKrutrimBridgeForModel(
        workspace.paths,
        result.report.model,
        apiKey,
        new Date("2026-08-12T12:00:00.000Z"),
      ),
    ).toMatchObject({ status: "valid", usable: true });
  });
});
