import { describe, expect, it, vi } from "vitest";

import { runKrutrimChatCompletion } from "../../src/inference/chat-completions.js";

const apiKey = "stored-key-that-must-not-leak";

function fetchReturning(response: Response): {
  fetchImpl: typeof fetch;
  calls: Array<{ input: string; init: RequestInit }>;
} {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const implementation = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input: String(input), init: init ?? {} });
    return response;
  });
  return { fetchImpl: implementation as unknown as typeof fetch, calls };
}

describe("Krutrim Chat Completions client", () => {
  it("sends only to the fixed Krutrim endpoint and parses a JSON completion", async () => {
    const queued = fetchReturning(
      Response.json({
        model: "Krutrim-2",
        choices: [{ message: { role: "assistant", content: "Namaste" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    );

    const result = await runKrutrimChatCompletion({
      model: "Krutrim-2",
      prompt: "Say hello",
      apiKey,
      stream: false,
      maxTokens: 32,
      temperature: 0.2,
      fetchImpl: queued.fetchImpl,
    });

    expect(result).toEqual({
      model: "Krutrim-2",
      text: "Namaste",
      finishReason: "stop",
      usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
      streamed: false,
    });
    expect(queued.calls).toHaveLength(1);
    expect(queued.calls[0]!.input).toBe("https://cloud.olakrutrim.com/v1/chat/completions");
    expect(queued.calls[0]!.init.redirect).toBe("manual");
    expect(new Headers(queued.calls[0]!.init.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
    expect(JSON.parse(String(queued.calls[0]!.init.body))).toEqual({
      model: "Krutrim-2",
      messages: [{ role: "user", content: "Say hello" }],
      stream: false,
      max_tokens: 32,
      temperature: 0.2,
    });
  });

  it("delivers Chat Completions deltas and requires the terminal marker", async () => {
    const body = [
      { model: "Krutrim-2", choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
      { model: "Krutrim-2", choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
      { model: "Krutrim-2", choices: [{ delta: { content: " world" }, finish_reason: "stop" }] },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("") + "data: [DONE]\n\n";
    const queued = fetchReturning(
      new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }),
    );
    const deltas: string[] = [];

    const result = await runKrutrimChatCompletion({
      model: "Krutrim-2",
      prompt: "Say hello",
      apiKey,
      fetchImpl: queued.fetchImpl,
      onDelta: (delta) => deltas.push(delta),
    });

    expect(deltas).toEqual(["Hello", " world"]);
    expect(result).toEqual({
      model: "Krutrim-2",
      text: "Hello world",
      finishReason: "stop",
      streamed: true,
    });
  });

  it("fails before the network when the model contains the credential", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runKrutrimChatCompletion({
        model: `model-${apiKey}`,
        prompt: "hello",
        apiKey,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/model id contains the stored API key/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not include an error response body or credential in failures", async () => {
    const queued = fetchReturning(
      Response.json(
        { error: { message: `bad credential ${apiKey}`, prompt: "private prompt" } },
        { status: 401 },
      ),
    );

    let caught: unknown;
    try {
      await runKrutrimChatCompletion({
        model: "Krutrim-2",
        prompt: "private prompt",
        apiKey,
        fetchImpl: queued.fetchImpl,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("Krutrim inference failed with HTTP 401.");
    expect((caught as Error).message).not.toContain(apiKey);
    expect((caught as Error).message).not.toContain("private prompt");
  });

  it("rejects malformed or incomplete streaming responses", async () => {
    const malformed = fetchReturning(
      new Response("data: not-json\n\n", { headers: { "Content-Type": "text/event-stream" } }),
    );
    await expect(
      runKrutrimChatCompletion({
        model: "Krutrim-2",
        prompt: "hello",
        apiKey,
        fetchImpl: malformed.fetchImpl,
      }),
    ).rejects.toThrow("malformed streaming JSON");

    const incomplete = fetchReturning(
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    await expect(
      runKrutrimChatCompletion({
        model: "Krutrim-2",
        prompt: "hello",
        apiKey,
        fetchImpl: incomplete.fetchImpl,
      }),
    ).rejects.toThrow("without the [DONE] marker");
  });
});
