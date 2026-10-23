import { describe, expect, it, vi } from "vitest";

import { krutrimProvider } from "../../src/providers/krutrim.js";
import { runKrutrimChatBridgeProbe } from "../../src/probes/krutrim-chat-tools.js";
import { KRUTRIM_CONNECT_VERSION } from "../../src/version.js";

const apiKey = "bridge-test-key-never-log-this";
const model = "Krutrim-Bridge-Probe-Model";

function jsonResponse(status: number, body = ""): Response {
  return new Response(body, {
    status,
    ...(body.length === 0 ? {} : { headers: { "Content-Type": "application/json" } }),
  });
}

function toolResponse(nonce: string, callId = "call_nonstream"): Response {
  return Response.json({
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callId,
              type: "function",
              function: {
                name: "krutrim_connect_echo",
                arguments: JSON.stringify({ nonce }),
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  });
}

function streamedToolResponse(nonce: string, callId = "call_stream"): Response {
  const args = JSON.stringify({ nonce });
  const split = Math.floor(args.length / 2);
  const chunks = [
    { model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    {
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: { name: "krutrim_connect_echo", arguments: args.slice(0, split) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] },
          finish_reason: null,
        },
      ],
    },
    { model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function malformedToolStream(): Response {
  const body = [
    { model, choices: [{ index: 0, delta: { content: "No tool" }, finish_reason: "stop" }] },
  ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function continuationResponse(marker: string): Response {
  return Response.json({
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: marker },
        finish_reason: "stop",
      },
    ],
  });
}

function successfulResponses(): Response[] {
  return [
    jsonResponse(401),
    jsonResponse(400),
    toolResponse("nonstream-nonce"),
    streamedToolResponse("stream-nonce"),
    continuationResponse("KRUTRIM_CONNECT_CHAT_TOOL_RESULT_result-nonce"),
  ];
}

function queuedFetch(responses: Response[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const implementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = responses.shift();
    if (!response) {
      throw new Error("No queued response");
    }
    return response;
  });
  return { fetchImpl: implementation as unknown as typeof fetch, calls };
}

function nonceFactory(): () => string {
  const values = ["nonstream-nonce", "stream-nonce", "result-nonce"];
  return () => values.shift() ?? "unexpected-nonce";
}

describe("Krutrim Chat Completions bridge-feasibility probe", () => {
  it("passes authentication, non-streaming tools, streamed arguments, and continuation", async () => {
    const queued = queuedFetch(successfulResponses());
    const result = await runKrutrimChatBridgeProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
      now: () => new Date("2026-08-12T12:00:00.000Z"),
    });

    expect(result.outcome).toBe("streaming-compatible");
    expect(result.observations).toEqual({
      requestCount: 5,
      streamEventCount: 5,
      argumentDeltaCount: 2,
    });
    expect(result.checks).toMatchObject({
      authentication: { status: "pass" },
      nonStreamingToolCalling: { status: "pass" },
      streamingToolCalling: { status: "pass" },
      toolContinuation: { status: "pass" },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain("nonstream-nonce");
    expect(queued.calls.every((call) => call.url === "https://cloud.olakrutrim.com/v1/chat/completions")).toBe(true);
    expect(queued.calls.every((call) => call.init.redirect === "manual")).toBe(true);
    expect(
      queued.calls.every(
        (call) => new Headers(call.init.headers).get("User-Agent") ===
          `krutrimconnect/${KRUTRIM_CONNECT_VERSION}`,
      ),
    ).toBe(true);
    expect(queued.calls.map((call) => new Headers(call.init.headers).get("Authorization"))).toEqual([
      "Bearer krutrim-connect-intentionally-invalid",
      `Bearer ${apiKey}`,
      `Bearer ${apiKey}`,
      `Bearer ${apiKey}`,
      `Bearer ${apiKey}`,
    ]);

    const toolBody = JSON.parse(String(queued.calls[2]!.init.body)) as Record<string, unknown>;
    expect(toolBody).toMatchObject({
      model,
      stream: false,
      tool_choice: { type: "function", function: { name: "krutrim_connect_echo" } },
      parallel_tool_calls: false,
      temperature: 0,
      max_tokens: 512,
    });
    expect(toolBody.tools).toEqual([
      expect.objectContaining({
        type: "function",
        function: expect.objectContaining({ name: "krutrim_connect_echo", strict: false }),
      }),
    ]);

    const continuation = JSON.parse(String(queued.calls[4]!.init.body)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(continuation.messages.slice(-2)).toEqual([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({ id: "call_nonstream", type: "function" })],
      }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_nonstream" }),
    ]);
    expect(continuation).toMatchObject({
      tool_choice: "none",
      parallel_tool_calls: false,
      temperature: 0,
    });
  });

  it("reports buffered compatibility when tool calls and continuation work without streamed deltas", async () => {
    const responses = successfulResponses();
    responses[3] = malformedToolStream();
    const queued = queuedFetch(responses);
    const result = await runKrutrimChatBridgeProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("buffered-compatible");
    expect(result.checks.nonStreamingToolCalling.status).toBe("pass");
    expect(result.checks.streamingToolCalling.status).toBe("fail");
    expect(result.checks.toolContinuation.status).toBe("pass");
    expect(result.observations.requestCount).toBe(5);
  });

  it("stops when non-streaming Chat Completions rejects tool calling", async () => {
    const queued = queuedFetch([
      jsonResponse(401),
      jsonResponse(400),
      jsonResponse(400, JSON.stringify({ error: { type: "invalid_request", param: "tools" } })),
    ]);
    const result = await runKrutrimChatBridgeProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.nonStreamingToolCalling.status).toBe("fail");
    expect(result.checks.streamingToolCalling.status).toBe("not-run");
    expect(result.checks.toolContinuation.status).toBe("not-run");
    expect(result.observations.requestCount).toBe(3);
  });

  it("stops before the real credential when the invalid-token control is unsafe", async () => {
    const queued = queuedFetch([jsonResponse(422)]);
    const result = await runKrutrimChatBridgeProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
    });

    expect(result.outcome).toBe("inconclusive");
    expect(result.observations.requestCount).toBe(1);
    expect(new Headers(queued.calls[0]!.init.headers).get("Authorization")).not.toContain(apiKey);
  });

  it("rejects redirects without following or transmitting the real credential", async () => {
    const queued = queuedFetch([
      new Response(null, { status: 302, headers: { Location: "https://example.test" } }),
    ]);
    const result = await runKrutrimChatBridgeProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
    });

    expect(result.outcome).toBe("failed");
    expect(result.observations.requestCount).toBe(1);
    expect(queued.calls[0]!.init.redirect).toBe("manual");
  });

  it("classifies active-model authorization uncertainty separately from incompatibility", async () => {
    const queued = queuedFetch([jsonResponse(401), jsonResponse(400), jsonResponse(403)]);
    const result = await runKrutrimChatBridgeProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("inconclusive");
    expect(result.checks.nonStreamingToolCalling.status).toBe("inconclusive");
    expect(result.checks.nonStreamingToolCalling.detail).toMatch(/model or model group/u);
  });

  it("redacts credentials echoed in allowlisted error fields", async () => {
    const queued = queuedFetch([
      jsonResponse(401),
      jsonResponse(400),
      jsonResponse(
        400,
        JSON.stringify({ error: { type: "invalid_request", code: apiKey, param: "tools" } }),
      ),
    ]);
    const result = await runKrutrimChatBridgeProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(result.checks.nonStreamingToolCalling.detail).toContain("[REDACTED]");
  });

  it("rejects an API key accidentally supplied as the model before any request", async () => {
    const queued = queuedFetch([]);
    await expect(
      runKrutrimChatBridgeProbe({
        provider: krutrimProvider,
        model: apiKey,
        apiKey,
        fetchImpl: queued.fetchImpl,
      }),
    ).rejects.toThrow(/model id contains the stored API key/u);
    expect(queued.calls).toHaveLength(0);
  });
});
