import { afterEach, describe, expect, it, vi } from "vitest";

import {
  deriveBridgeBearer,
  startBridgeServer,
  type StartedBridgeServer,
} from "../../src/bridge/server.js";

const servers: StartedBridgeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.close().catch(() => undefined)));
});

function upstreamToolStream(): Response {
  const chunks = [
    {
      choices: [{ delta: { tool_calls: [{
        index: 0,
        id: "call_upstream",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"README.md"}' },
      }] } }],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
  const source = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(source, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("private local bridge server", () => {
  it("authenticates loopback traffic and translates an actual /v1/responses request", async () => {
    const apiKey = "server-test-api-key-never-logged";
    const instanceId = "private-runtime-instance";
    const controlToken = "c".repeat(64);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${apiKey}` });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "bridge-model", stream: true });
      return upstreamToolStream();
    });
    const started = await startBridgeServer({
      model: "bridge-model",
      instanceId,
      controlToken,
      apiKey,
      fetchImpl,
    });
    servers.push(started);
    const origin = `http://${started.host}:${started.port}`;

    expect((await fetch(`${origin}/health`)).status).toBe(401);
    const health = await fetch(`${origin}/health`, {
      headers: { "X-Krutrim-Connect-Instance": instanceId },
    });
    expect(health.status).toBe(401);
    const authorizedHealth = await fetch(`${origin}/health`, {
      headers: { "X-Krutrim-Connect-Instance": controlToken },
    });
    expect(await authorizedHealth.json()).toEqual({
      status: "ok",
      model: "bridge-model",
      contract: "responses-chat-v2-model-list",
    });

    const unauthorized = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
      body: JSON.stringify({ model: "bridge-model", stream: true, input: "read" }),
    });
    expect(unauthorized.status).toBe(401);

    const unauthorizedModels = await fetch(`${origin}/v1/models?client_version=test`);
    expect(unauthorizedModels.status).toBe(401);
    const modelList = await fetch(`${origin}/v1/models?client_version=test`, {
      headers: {
        Authorization: `Bearer ${deriveBridgeBearer(apiKey, instanceId)}`,
      },
    });
    expect(modelList.status).toBe(200);
    expect(await modelList.json()).toEqual({
      object: "list",
      data: [{ id: "bridge-model", object: "model", created: 0, owned_by: "krutrim" }],
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const response = await fetch(`${origin}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deriveBridgeBearer(apiKey, instanceId)}`,
      },
      body: JSON.stringify({
        model: "bridge-model",
        stream: true,
        input: "read",
        tools: [{
          type: "function",
          name: "read_file",
          parameters: { type: "object" },
        }],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();
    expect(stream).toContain("event: response.created");
    expect(stream).toContain("event: response.function_call_arguments.delta");
    expect(stream).toContain('"call_id":"call_upstream"');
    expect(stream).toContain("event: response.completed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const shutdown = await fetch(`${origin}/shutdown`, {
      method: "POST",
      headers: { "X-Krutrim-Connect-Shutdown": controlToken },
    });
    expect(shutdown.status).toBe(200);
  });

  it("forwards a bound OpenAI-compatible Chat Completions stream without exposing the Krutrim key", async () => {
    const apiKey = "chat-route-api-key-never-logged";
    const instanceId = "opencode-runtime-instance";
    const controlToken = "d".repeat(64);
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
      });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "bridge-model", stream: true });
      return new Response("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    const started = await startBridgeServer({ model: "bridge-model", instanceId, controlToken, apiKey, fetchImpl });
    servers.push(started);
    const origin = `http://${started.host}:${started.port}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${deriveBridgeBearer(apiKey, instanceId)}`,
    };

    const wrongModel = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "other-model", stream: true, messages: [] }),
    });
    expect(wrongModel.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();

    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "bridge-model", stream: true, messages: [{ role: "user", content: "hello" }] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("data: [DONE]");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports bounded upstream error metadata without persisting the response message", async () => {
    const apiKey = "upstream-error-api-key-never-logged";
    const instanceId = "upstream-error-runtime";
    const controlToken = "e".repeat(64);
    const errors: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      error: {
        message: `System message must be at the beginning ${apiKey}`,
        type: "BadRequestError",
        param: null,
        code: 400,
      },
    }, { status: 400 }));
    const started = await startBridgeServer({
      model: "bridge-model",
      instanceId,
      controlToken,
      apiKey,
      fetchImpl,
      onResponsesError: (message) => errors.push(message),
    });
    servers.push(started);
    const response = await fetch(`http://${started.host}:${started.port}/v1/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deriveBridgeBearer(apiKey, instanceId)}`,
      },
      body: JSON.stringify({ model: "bridge-model", stream: true, input: "hello" }),
    });

    expect(response.status).toBe(400);
    expect(errors).toEqual([
      "Krutrim rejected the bridged request (HTTP 400,type=BadRequestError,code=400,param=none).",
    ]);
    expect(JSON.stringify(errors)).not.toContain("System message must be at the beginning");
    expect(JSON.stringify(errors)).not.toContain(apiKey);
  });
});
