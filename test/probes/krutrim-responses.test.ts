import { describe, expect, it, vi } from "vitest";

import { krutrimProvider } from "../../src/providers/krutrim.js";
import { runKrutrimCodexProbe } from "../../src/probes/krutrim-responses.js";
import { KRUTRIM_CONNECT_VERSION } from "../../src/version.js";

const apiKey = "live-test-key-never-log-this";
const model = "Krutrim-Probe-Model";

function jsonResponse(status: number, body = ""): Response {
  return new Response(body, {
    status,
    ...(body.length > 0 ? { headers: { "Content-Type": "application/json" } } : {}),
  });
}

function sseResponse(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function usage(): Record<string, unknown> {
  return {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 11,
  };
}

function textEvents(marker: string, itemId: string): Record<string, unknown>[] {
  const message = {
    id: itemId,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: marker, annotations: [] }],
  };
  return [
    {
      type: "response.created",
      response: { id: `resp_${itemId}`, model, status: "in_progress" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: marker,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: { id: `resp_${itemId}`, model, status: "completed", output: [message], usage: usage() },
    },
  ];
}

function toolEvents(nonce: string, callId = "call_probe"): Record<string, unknown>[] {
  const args = JSON.stringify({ nonce });
  const reasoning = {
    id: "rs_probe",
    type: "reasoning",
    summary: [],
    encrypted_content: "opaque-probe-reasoning",
  };
  const item = {
    id: "fc_probe",
    type: "function_call",
    name: "krutrim_connect_echo",
    call_id: callId,
    arguments: args,
    status: "completed",
  };
  return [
    { type: "response.created", response: { id: "resp_tool", model, status: "in_progress" } },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    {
      type: "response.output_item.added",
      output_index: 1,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 1,
      delta: args,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 1,
      arguments: args,
    },
    { type: "response.output_item.done", output_index: 1, item },
    {
      type: "response.completed",
      response: { id: "resp_tool", model, status: "completed", output: [reasoning, item], usage: usage() },
    },
  ];
}

function successfulResponses(): Response[] {
  return [
    jsonResponse(401),
    jsonResponse(400),
    jsonResponse(401),
    jsonResponse(400),
    sseResponse(textEvents("KRUTRIM_CONNECT_TEXT_text-nonce", "msg_text")),
    sseResponse(toolEvents("tool-nonce")),
    sseResponse(textEvents("KRUTRIM_CONNECT_TOOL_RESULT_result-nonce", "msg_result")),
  ];
}

function queuedFetch(responses: Response[]): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
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
  const values = ["text-nonce", "tool-nonce", "result-nonce"];
  return () => values.shift() ?? "unexpected-nonce";
}

describe("Krutrim Codex Responses conformance probe", () => {
  it("rejects an API key accidentally supplied as the model before any request", async () => {
    const queued = queuedFetch([]);

    await expect(
      runKrutrimCodexProbe({
        provider: krutrimProvider,
        model: apiKey,
        apiKey,
        fetchImpl: queued.fetchImpl,
      }),
    ).rejects.toThrow(/model id contains the stored API key/u);
    expect(queued.calls).toHaveLength(0);
  });

  it("passes the sequential auth, Responses SSE, streamed tool, and continuation contract", async () => {
    const queued = queuedFetch(successfulResponses());
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
      now: () => new Date("2026-08-11T05:00:00.000Z"),
    });

    expect(result.outcome).toBe("passed");
    expect(result.observations.requestCount).toBe(7);
    expect(result.checks).toMatchObject({
      authentication: { status: "pass" },
      responsesApi: { status: "pass" },
      streaming: { status: "pass" },
      toolCalling: { status: "pass" },
    });
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(queued.calls.every((call) => call.init.redirect === "manual")).toBe(true);
    expect(
      queued.calls.every(
        (call) => new Headers(call.init.headers).get("User-Agent") ===
          `krutrimconnect/${KRUTRIM_CONNECT_VERSION}`,
      ),
    ).toBe(true);

    const authHeaders = queued.calls.map((call) => new Headers(call.init.headers).get("Authorization"));
    expect(authHeaders.slice(0, 4)).toEqual([
      "Bearer krutrim-connect-intentionally-invalid",
      `Bearer ${apiKey}`,
      "Bearer krutrim-connect-intentionally-invalid",
      `Bearer ${apiKey}`,
    ]);

    const toolBody = JSON.parse(String(queued.calls[5]!.init.body)) as Record<string, unknown>;
    expect(toolBody).toMatchObject({
      model,
      stream: true,
      store: false,
      parallel_tool_calls: false,
      reasoning: { summary: "auto" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "krutrim-connect-probe",
      tool_choice: "auto",
    });
    expect(toolBody).not.toHaveProperty("max_output_tokens");
    expect(toolBody.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function", name: "krutrim_connect_echo", strict: false }),
        expect.objectContaining({ type: "namespace" }),
        expect.objectContaining({ type: "web_search", external_web_access: false }),
      ]),
    );
    const continuation = JSON.parse(String(queued.calls[6]!.init.body)) as {
      input: Array<Record<string, unknown>>;
    };
    expect(continuation.input.slice(-2)).toEqual([
      expect.objectContaining({ type: "function_call", call_id: "call_probe" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call_probe" }),
    ]);
    expect(continuation.input).toContainEqual(
      expect.objectContaining({ type: "reasoning", encrypted_content: "opaque-probe-reasoning" }),
    );
    const continuationBody = JSON.parse(String(queued.calls[6]!.init.body)) as {
      tool_choice: unknown;
      tools: Array<Record<string, unknown>>;
    };
    expect(continuationBody.tool_choice).toBe("auto");
    expect(continuationBody.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "function", name: "krutrim_connect_echo" }),
        expect.objectContaining({ type: "namespace" }),
        expect.objectContaining({ type: "web_search", external_web_access: false }),
      ]),
    );
    expect(
      String(queued.calls[6]!.init.body).match(/KRUTRIM_CONNECT_TOOL_RESULT_result-nonce/gu),
    ).toHaveLength(1);
  });

  it("accepts canonical initial text without requiring exact long-marker reproduction", async () => {
    const responses = successfulResponses();
    responses[4] = sseResponse(textEvents("A valid model response with different wording.", "msg_text"));
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("passed");
    expect(result.checks.responsesApi.status).toBe("pass");
  });

  it("accepts completed events that omit output because Codex records output_item.done", async () => {
    const responses = successfulResponses();
    for (const index of [4, 5, 6]) {
      const source = index === 5
        ? toolEvents("tool-nonce")
        : textEvents(
            index === 4
              ? "KRUTRIM_CONNECT_TEXT_text-nonce"
              : "KRUTRIM_CONNECT_TOOL_RESULT_result-nonce",
            index === 4 ? "msg_text" : "msg_result",
          );
      responses[index] = sseResponse(
        source.map((event) => {
          if (event.type !== "response.completed") {
            return event;
          }
          const response = { ...(event.response as Record<string, unknown>) };
          delete response.output;
          return { ...event, response };
        }),
      );
    }
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("passed");
    expect(result.checks.toolCalling.status).toBe("pass");
  });

  it("still requires the continuation to prove synthetic function-output consumption", async () => {
    const responses = successfulResponses();
    responses[6] = sseResponse(textEvents("Ignored the function output.", "msg_result"));
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("pass");
    expect(result.checks.streaming.status).toBe("pass");
    expect(result.checks.toolCalling.detail).toMatch(/synthetic function output/u);
  });

  it("stops before sending the real credential when the invalid-token control is unsafe", async () => {
    const queued = queuedFetch([jsonResponse(422)]);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
    });

    expect(result.outcome).toBe("inconclusive");
    expect(result.observations.requestCount).toBe(1);
    expect(new Headers(queued.calls[0]!.init.headers).get("Authorization")).not.toContain(apiKey);
  });

  it("rejects redirects without following or transmitting the real key", async () => {
    const queued = queuedFetch([new Response(null, { status: 302, headers: { Location: "https://example.test" } })]);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
    });

    expect(result.outcome).toBe("failed");
    expect(result.observations.requestCount).toBe(1);
    expect(queued.calls[0]!.init.redirect).toBe("manual");
  });

  it("stops at an absent Responses route before sending a real key to that route", async () => {
    const queued = queuedFetch([jsonResponse(401), jsonResponse(400), jsonResponse(404)]);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("fail");
    expect(result.observations.requestCount).toBe(3);
    expect(new Headers(queued.calls[2]!.init.headers).get("Authorization")).not.toContain(apiKey);
  });

  it("redacts a credential echoed in allowlisted upstream error fields", async () => {
    const responses = successfulResponses().slice(0, 4);
    responses.push(
      jsonResponse(400, JSON.stringify({ error: { type: "invalid_request", code: apiKey, param: "model" } })),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("inconclusive");
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(result.checks.responsesApi.detail).toContain("[REDACTED]");
  });

  it("classifies an active-model 403 as model-scope uncertainty, not a missing route", async () => {
    const responses = successfulResponses().slice(0, 4);
    responses.push(jsonResponse(403));
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("inconclusive");
    expect(result.checks.responsesApi.detail).toMatch(/requested model or model group/u);
    expect(result.checks.responsesApi.detail).not.toMatch(/absent/u);
  });

  it("never persists an untrusted SSE type string", async () => {
    const responses = successfulResponses();
    const textStream = textEvents("KRUTRIM_CONNECT_TEXT_text-nonce", "msg_text");
    textStream.splice(-1, 0, { type: apiKey, arbitrary: "upstream-controlled" });
    responses[4] = sseResponse(textStream);
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("passed");
    expect(result.observations.eventTypes).toContain("other");
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("does not promote streaming or tool calling without function argument deltas", async () => {
    const responses = successfulResponses();
    responses[5] = sseResponse(
      toolEvents("tool-nonce").filter((event) => event.type !== "response.function_call_arguments.delta"),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("pass");
    expect(result.checks.streaming.status).toBe("fail");
    expect(result.checks.toolCalling.status).toBe("fail");
    expect(result.observations.requestCount).toBe(6);
  });

  it("rejects a text stream without its terminal completed event", async () => {
    const responses = successfulResponses();
    responses[4] = sseResponse(
      textEvents("KRUTRIM_CONNECT_TEXT_text-nonce", "msg_text").filter(
        (event) => event.type !== "response.completed",
      ),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("fail");
    expect(result.observations.requestCount).toBe(5);
  });

  it("rejects malformed present usage that Codex cannot deserialize", async () => {
    const responses = successfulResponses();
    responses[4] = sseResponse(
      textEvents("KRUTRIM_CONNECT_TEXT_text-nonce", "msg_text").map((event) =>
        event.type === "response.completed"
          ? {
              ...event,
              response: { ...(event.response as Record<string, unknown>), usage: {} },
            }
          : event,
      ),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("fail");
    expect(result.observations.requestCount).toBe(5);
  });

  it("rejects a completed event with an end_turn value Codex cannot deserialize", async () => {
    const responses = successfulResponses();
    responses[4] = sseResponse(
      textEvents("KRUTRIM_CONNECT_TEXT_text-nonce", "msg_text").map((event) =>
        event.type === "response.completed"
          ? {
              ...event,
              response: { ...(event.response as Record<string, unknown>), end_turn: "yes" },
            }
          : event,
      ),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("fail");
    expect(result.observations.requestCount).toBe(5);
  });

  it("rejects a gateway response served by a different model", async () => {
    const responses = successfulResponses();
    responses[4] = sseResponse(
      textEvents("KRUTRIM_CONNECT_TEXT_text-nonce", "msg_text").map((event) => {
        if (event.type !== "response.created" && event.type !== "response.completed") {
          return event;
        }
        return {
          ...event,
          response: { ...(event.response as Record<string, unknown>), model: "Different-Model" },
        };
      }),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("fail");
  });

  it("rejects a message item containing content Codex cannot deserialize", async () => {
    const responses = successfulResponses();
    responses[4] = sseResponse(
      textEvents("KRUTRIM_CONNECT_TEXT_text-nonce", "msg_text").map((event) => {
        if (event.type !== "response.output_item.done") {
          return event;
        }
        const item = event.item as Record<string, unknown>;
        return {
          ...event,
          item: {
            ...item,
            content: [
              ...(item.content as Array<Record<string, unknown>>),
              { type: "output_text", text: 42 },
            ],
          },
        };
      }),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("fail");
    expect(result.observations.requestCount).toBe(5);
  });

  it("rejects typed event fields that make Codex discard an otherwise usable delta", async () => {
    const responses = successfulResponses();
    responses[4] = sseResponse(
      textEvents("KRUTRIM_CONNECT_TEXT_text-nonce", "msg_text").map((event) =>
        event.type === "response.output_text.delta"
          ? { ...event, call_id: 42 }
          : event,
      ),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.responsesApi.status).toBe("fail");
    expect(result.observations.requestCount).toBe(5);
  });

  it("rejects mismatched function item identifiers", async () => {
    const responses = successfulResponses();
    responses[5] = sseResponse(
      toolEvents("tool-nonce").map((event) =>
        event.type === "response.function_call_arguments.done"
          ? { ...event, item_id: "different_item" }
          : event,
      ),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.toolCalling.status).toBe("fail");
    expect(result.observations.requestCount).toBe(6);
  });

  it("rejects a namespace on the top-level probe function", async () => {
    const responses = successfulResponses();
    responses[5] = sseResponse(
      toolEvents("tool-nonce").map((event) => {
        if (
          (event.type === "response.output_item.added" || event.type === "response.output_item.done") &&
          typeof event.item === "object" &&
          event.item !== null &&
          (event.item as Record<string, unknown>).type === "function_call"
        ) {
          return {
            ...event,
            item: {
              ...(event.item as Record<string, unknown>),
              namespace: "krutrim_connect_namespace",
            },
          };
        }
        if (event.type === "response.completed") {
          const response = event.response as Record<string, unknown>;
          return {
            ...event,
            response: {
              ...response,
              output: (response.output as Array<Record<string, unknown>>).map((item) =>
                item.type === "function_call"
                  ? { ...item, namespace: "krutrim_connect_namespace" }
                  : item,
              ),
            },
          };
        }
        return event;
      }),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.toolCalling.status).toBe("fail");
    expect(result.observations.requestCount).toBe(6);
  });

  it("rejects malformed function metadata that makes Codex drop the call", async () => {
    const responses = successfulResponses();
    responses[5] = sseResponse(
      toolEvents("tool-nonce").map((event) => {
        if (
          event.type === "response.output_item.done" &&
          typeof event.item === "object" &&
          event.item !== null &&
          (event.item as Record<string, unknown>).type === "function_call"
        ) {
          return {
            ...event,
            item: {
              ...(event.item as Record<string, unknown>),
              internal_chat_message_metadata_passthrough: { turn_id: 42 },
            },
          };
        }
        return event;
      }),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.toolCalling.status).toBe("fail");
    expect(result.observations.requestCount).toBe(6);
  });

  it("rejects extra completed output items that real Codex would replay", async () => {
    const responses = successfulResponses();
    const events = toolEvents("tool-nonce");
    events.splice(1, 0, {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: "msg_commentary",
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [{ type: "output_text", text: "Working." }],
      },
    });
    responses[5] = sseResponse(events);
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.toolCalling.status).toBe("fail");
    expect(result.observations.requestCount).toBe(6);
  });

  it("rejects a streamed reasoning item that Codex cannot deserialize", async () => {
    const responses = successfulResponses();
    responses[5] = sseResponse(
      toolEvents("tool-nonce").map((event) => {
        if (
          event.type === "response.output_item.done" &&
          typeof event.item === "object" &&
          event.item !== null &&
          (event.item as Record<string, unknown>).type === "reasoning"
        ) {
          return {
            ...event,
            item: { ...(event.item as Record<string, unknown>), summary: [{}] },
          };
        }
        return event;
      }),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("failed");
    expect(result.checks.toolCalling.status).toBe("fail");
    expect(result.observations.requestCount).toBe(6);
  });

  it("omits Text-only reasoning content exactly as Codex does when replaying history", async () => {
    const responses = successfulResponses();
    responses[5] = sseResponse(
      toolEvents("tool-nonce").map((event) => {
        if (
          event.type === "response.output_item.done" &&
          typeof event.item === "object" &&
          event.item !== null &&
          (event.item as Record<string, unknown>).type === "reasoning"
        ) {
          return {
            ...event,
            item: {
              ...(event.item as Record<string, unknown>),
              content: [{ type: "text", text: "not replayed by Codex" }],
            },
          };
        }
        return event;
      }),
    );
    const queued = queuedFetch(responses);
    const result = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model,
      apiKey,
      fetchImpl: queued.fetchImpl,
      nonceFactory: nonceFactory(),
    });

    expect(result.outcome).toBe("passed");
    const continuation = JSON.parse(String(queued.calls[6]!.init.body)) as {
      input: Array<Record<string, unknown>>;
    };
    const replayedReasoning = continuation.input.find((item) => item.type === "reasoning");
    expect(replayedReasoning).not.toHaveProperty("content");
  });
});
