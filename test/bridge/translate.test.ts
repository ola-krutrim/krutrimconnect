import { describe, expect, it } from "vitest";

import { translateResponsesRequest } from "../../src/bridge/translate.js";

describe("Responses to Chat request translation", () => {
  it("preserves tool correlation and flattens namespaced functions reversibly", () => {
    const translated = translateResponsesRequest(
      {
        model: "bridge-model",
        stream: true,
        instructions: "Use tools when needed.",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "read it" }] },
          { type: "reasoning", id: "rs_ignored", encrypted_content: "opaque" },
          {
            type: "function_call",
            name: "read/file",
            namespace: "workspace",
            call_id: "call_123",
            arguments: '{"path":"README.md"}',
          },
          { type: "function_call_output", call_id: "call_123", output: "contents" },
        ],
        tools: [
          {
            type: "namespace",
            name: "workspace",
            tools: [
              {
                type: "function",
                name: "read/file",
                description: "Read a file",
                parameters: { type: "object" },
              },
            ],
          },
          { type: "web_search", external_web_access: false },
        ],
        tool_choice: { type: "function", name: "read/file", namespace: "workspace" },
        parallel_tool_calls: true,
        max_output_tokens: 512,
      },
      "bridge-model",
    );

    const tools = translated.chatBody.tools as Array<Record<string, unknown>>;
    const fn = tools[0]!.function as Record<string, unknown>;
    const encoded = fn.name as string;
    expect(encoded).toMatch(/^kc_/u);
    expect(translated.toolNames.get(encoded)).toEqual({ name: "read/file", namespace: "workspace" });
    expect(translated.chatBody.messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Follow the tool protocol exactly"),
      }),
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: encoded, arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_123", content: "contents" },
    ]);
    expect((translated.chatBody.messages as Array<Record<string, unknown>>)[0]?.content)
      .toContain("Use tools when needed.");
    expect(translated.chatBody.tool_choice).toEqual({
      type: "function",
      function: { name: encoded },
    });
    expect(tools).toHaveLength(1);
  });

  it("omits provider-executed search that the fixed Chat upstream cannot emulate", () => {
    const translated = translateResponsesRequest({
      model: "bridge-model",
      stream: true,
      input: "search",
      tools: [{ type: "web_search", external_web_access: true }],
    }, "bridge-model");
    expect(translated.chatBody.tools).toBeUndefined();
    expect(translated.toolNames.size).toBe(0);
  });

  it("coalesces instructions and developer/system items into one leading system message", () => {
    const translated = translateResponsesRequest({
      model: "bridge-model",
      stream: true,
      instructions: "Primary Codex instructions.",
      input: [
        { type: "message", role: "developer", content: "Developer instructions." },
        { type: "message", role: "user", content: "First user message." },
        { type: "message", role: "system", content: "Later system instructions." },
        { type: "message", role: "user", content: "Second user message." },
      ],
      tools: [{
        type: "function",
        name: "exec_command",
        description: "Run a command.",
        parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      }],
    }, "bridge-model");

    const messages = translated.chatBody.messages as Array<Record<string, unknown>>;
    expect(messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
    expect(messages[0]?.content).toEqual(expect.stringContaining("Follow the tool protocol exactly"));
    expect(messages[0]?.content).toContain("Primary Codex instructions.");
    expect(messages[0]?.content).toContain("Developer instructions.");
    expect(messages[0]?.content).toContain("Later system instructions.");
  });

  it("wraps a Responses custom tool as a correlated Chat function", () => {
    const translated = translateResponsesRequest({
      model: "bridge-model",
      stream: true,
      input: [
        { type: "custom_tool_call", name: "apply_patch", call_id: "call_patch", input: "*** Begin Patch" },
        { type: "custom_tool_call_output", call_id: "call_patch", output: "Done!" },
      ],
      tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
      tool_choice: { type: "custom", name: "apply_patch" },
    }, "bridge-model");
    const tools = translated.chatBody.tools as Array<Record<string, unknown>>;
    const fn = tools[0]!.function as Record<string, unknown>;
    expect(translated.toolNames.get(fn.name as string)).toEqual({
      name: "apply_patch",
      kind: "custom",
    });
    expect(translated.chatBody.messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Follow the tool protocol exactly"),
      }),
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_patch",
          type: "function",
          function: {
            name: fn.name,
            arguments: JSON.stringify({ input: "*** Begin Patch" }),
          },
        }],
      },
      { role: "tool", tool_call_id: "call_patch", content: "Done!" },
    ]);
    expect(translated.chatBody.tool_choice).toEqual({
      type: "function",
      function: { name: fn.name },
    });
  });

  it("uses the narrow reversible exec to exec_command compatibility alias", () => {
    const translated = translateResponsesRequest({
      model: "bridge-model",
      stream: true,
      input: "run pwd",
      tools: [{ type: "custom", name: "exec", description: "Run code-mode tools" }],
    }, "bridge-model");
    const tools = translated.chatBody.tools as Array<Record<string, unknown>>;
    const fn = tools[0]!.function as Record<string, unknown>;
    expect(fn.name).toBe("exec_command");
    expect(fn.parameters).toMatchObject({
      required: ["cmd"],
      additionalProperties: false,
    });
    expect(translated.toolNames.get("exec_command")).toEqual({
      name: "exec",
      kind: "custom",
    });
    expect(translated.chatBody.messages).toEqual([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("Follow the tool protocol exactly"),
      }),
      { role: "user", content: "run pwd" },
    ]);
  });

  it("rejects non-streaming or cross-model traffic", () => {
    expect(() => translateResponsesRequest({
      model: "other-model",
      stream: true,
      input: "hello",
    }, "bridge-model")).toThrow(/different model/u);
    expect(() => translateResponsesRequest({
      model: "bridge-model",
      stream: false,
      input: "hello",
    }, "bridge-model")).toThrow(/must use Responses streaming/u);
  });
});
