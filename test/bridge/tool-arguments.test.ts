import { describe, expect, it } from "vitest";

import { normalizeChatToolArguments } from "../../src/bridge/tool-arguments.js";

describe("Chat tool argument normalization", () => {
  it("preserves standard JSON function arguments", () => {
    const source = '{"cmd":"pwd","yield_time_ms":1000}';
    expect(normalizeChatToolArguments(source, "exec_command")).toBe(source);
  });

  it("converts Gemma wrapped tool arguments into canonical JSON", () => {
    const source =
      '<|tool_call>call:exec_command{cmd:<|"|>pwd<|"|>,options:{timeout:1000,tty:false},tags:[<|"|>one<|"|>,<|"|>two<|"|>]}<tool_call|>';
    expect(JSON.parse(normalizeChatToolArguments(source, "exec_command"))).toEqual({
      cmd: "pwd",
      options: { timeout: 1000, tty: false },
      tags: ["one", "two"],
    });
  });

  it("rejects a wrapped call for a different tool", () => {
    expect(() => normalizeChatToolArguments(
      '<|tool_call>call:write_stdin{session_id:1,chars:<|"|><|"|>}<tool_call|>',
      "exec_command",
    )).toThrow(/different function/u);
  });

  it("rejects duplicate keys and trailing content", () => {
    expect(() => normalizeChatToolArguments(
      '<|tool_call>call:exec_command{cmd:<|"|>pwd<|"|>,cmd:<|"|>id<|"|>}<tool_call|>',
      "exec_command",
    )).toThrow(/duplicate key/u);
    expect(() => normalizeChatToolArguments(
      '<|tool_call>call:exec_command{cmd:<|"|>pwd<|"|>}<tool_call|>trailing',
      "exec_command",
    )).toThrow(/malformed/u);
  });
});
