import { describe, expect, it } from "vitest";

import { translateChatCompletionStream } from "../../src/bridge/stream.js";

function chatStream(events: unknown[]): Response {
  const source = events
    .map((event) => event === "[DONE]" ? "data: [DONE]\n\n" : `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(source, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("Chat to Responses stream translation", () => {
  it("emits canonical streamed function arguments and preserves call_id", async () => {
    const response = chatStream([
      {
        choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "call_chat_123",
          type: "function",
          function: { name: "encoded_tool", arguments: '{"path":' },
        }] } }],
      },
      {
        choices: [{ delta: { tool_calls: [{
          index: 0,
          function: { arguments: '"README.md"}' },
        }] }, finish_reason: "tool_calls" }],
      },
      "[DONE]",
    ]);
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    await translateChatCompletionStream(
      response,
      "bridge-model",
      new Map([["encoded_tool", { name: "read_file", namespace: "workspace" }]]),
      { write: (event, data) => emitted.push({ event, data }) },
    );

    expect(emitted.map((item) => item.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(emitted[1]!.data.item).toMatchObject({
      type: "function_call",
      call_id: "call_chat_123",
      name: "read_file",
      namespace: "workspace",
    });
    expect(emitted[3]!.data.arguments).toBe('{"path":"README.md"}');
    const doneItem = emitted[4]!.data.item as Record<string, unknown>;
    expect(doneItem).toMatchObject({
      call_id: "call_chat_123",
      arguments: '{"path":"README.md"}',
      status: "completed",
    });
  });

  it("emits the canonical message text sequence", async () => {
    const response = chatStream([
      { choices: [{ delta: { content: "hello " } }] },
      { choices: [{ delta: { content: "world" }, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    const events: string[] = [];
    const payloads: Record<string, unknown>[] = [];
    await translateChatCompletionStream(response, "bridge-model", new Map(), {
      write: (event, data) => { events.push(event); payloads.push(data); },
    });
    expect(events).toContain("response.output_text.delta");
    expect(events).toContain("response.output_text.done");
    expect(payloads.find((item) => item.type === "response.output_text.done")?.text).toBe("hello world");
    expect(events.at(-1)).toBe("response.completed");
  });

  it("normalizes Gemma wrapped arguments before exposing them to Codex", async () => {
    const response = chatStream([
      {
        choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "call_gemma_exec",
          type: "function",
          function: {
            name: "exec_command",
            arguments: '<|tool_call>call:exec_command{cmd:<|"|>pwd<|"|>}<tool_call|>',
          },
        }] }, finish_reason: "stop" }],
      },
      "[DONE]",
    ]);
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    await translateChatCompletionStream(
      response,
      "bridge-model",
      new Map([["exec_command", { name: "exec_command" }]]),
      { write: (event, data) => emitted.push({ event, data }) },
    );

    const delta = emitted.find((item) => item.event === "response.function_call_arguments.delta");
    const done = emitted.find((item) => item.event === "response.function_call_arguments.done");
    expect(delta?.data.delta).toBe('{"cmd":"pwd"}');
    expect(done?.data.arguments).toBe('{"cmd":"pwd"}');
    expect(JSON.stringify(emitted)).not.toContain("<|tool_call>");
  });

  it("unwraps Chat function arguments into a streamed Responses custom tool call", async () => {
    const response = chatStream([
      {
        choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "call_patch",
          type: "function",
          function: { name: "encoded_patch", arguments: '{"input":"*** Begin' },
        }] } }],
      },
      {
        choices: [{ delta: { tool_calls: [{
          index: 0,
          function: { arguments: ' Patch"}' },
        }] }, finish_reason: "tool_calls" }],
      },
      "[DONE]",
    ]);
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    await translateChatCompletionStream(
      response,
      "bridge-model",
      new Map([["encoded_patch", { name: "apply_patch", kind: "custom" as const }]]),
      { write: (event, data) => emitted.push({ event, data }) },
    );
    expect(emitted.map((item) => item.event)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.custom_tool_call_input.delta",
      "response.custom_tool_call_input.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(emitted[1]!.data.item).toMatchObject({
      type: "custom_tool_call",
      call_id: "call_patch",
      name: "apply_patch",
      input: "",
    });
    expect(emitted[2]!.data.delta).toBe("*** Begin Patch");
    expect(emitted[4]!.data.item).toMatchObject({
      type: "custom_tool_call",
      input: "*** Begin Patch",
      status: "completed",
    });
  });

  it("converts the narrow exec_command shape into Codex code-mode custom input", async () => {
    const response = chatStream([
      {
        choices: [{ delta: { tool_calls: [{
          index: 0,
          id: "call_exec",
          type: "function",
          function: { name: "exec_command", arguments: '{"cmd":"pwd","workdir":"/workspace"}' },
        }] }, finish_reason: "tool_calls" }],
      },
      "[DONE]",
    ]);
    const emitted: Array<{ event: string; data: Record<string, unknown> }> = [];
    await translateChatCompletionStream(
      response,
      "bridge-model",
      new Map([["exec_command", { name: "exec", kind: "custom" as const }]]),
      { write: (event, data) => emitted.push({ event, data }) },
    );
    const done = emitted.find((item) => item.event === "response.custom_tool_call_input.done");
    expect(done?.data.input).toBe(
      'const result = await tools.exec_command({"cmd":"pwd","workdir":"/workspace"});\ntext(result);',
    );
    const item = emitted.find((entry) => entry.event === "response.output_item.done")?.data.item;
    expect(item).toMatchObject({ type: "custom_tool_call", name: "exec" });
  });
});
