import { randomUUID } from "node:crypto";

import { InferenceError } from "../errors.js";
import { consumeBoundedSse } from "../probes/sse.js";
import { normalizeChatToolArguments } from "./tool-arguments.js";
import {
  isJsonRecord,
  type JsonRecord,
  type ResponseToolIdentity,
} from "./translate.js";

export interface ResponsesSseWriter {
  write(event: string, data: JsonRecord): void;
}

export interface ChatStreamObservation {
  stage?: "tool-added" | "stream-complete";
  chunkCount: number;
  reasoningDeltaCount: number;
  textDeltaCount: number;
  toolCallCount: number;
  toolCallFragmentCount: number;
  finishReasons: string[];
  toolClasses?: string[];
  argumentShapes?: string[];
}

interface ToolState {
  chatIndex: number;
  outputIndex: number;
  itemId: string;
  callId: string;
  chatName: string;
  identity: ResponseToolIdentity;
  arguments: string;
}

function responseId(): string {
  return `resp_${randomUUID().replaceAll("-", "")}`;
}

function itemId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function baseResponse(id: string, model: string, status: string, output: JsonRecord[]): JsonRecord {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    model,
    output,
    parallel_tool_calls: true,
  };
}

function toolItem(tool: ToolState, status: "in_progress" | "completed"): JsonRecord {
  if (tool.identity.kind === "custom") {
    return {
      id: tool.itemId,
      type: "custom_tool_call",
      status,
      call_id: tool.callId,
      name: tool.identity.name,
      input: customToolInput(tool),
    };
  }
  return {
    id: tool.itemId,
    type: "function_call",
    status,
    call_id: tool.callId,
    name: tool.identity.name,
    arguments: tool.arguments,
    ...(tool.identity.namespace === undefined ? {} : { namespace: tool.identity.namespace }),
  };
}

function customToolInput(tool: ToolState): string {
  const argumentsJson = tool.arguments;
  if (argumentsJson.length === 0) {
    return "";
  }
  let value: unknown;
  try {
    value = JSON.parse(argumentsJson) as unknown;
  } catch (error) {
    throw new InferenceError("Krutrim returned malformed wrapped custom-tool input.", { cause: error });
  }
  if (isJsonRecord(value) && typeof value.input === "string") {
    return value.input;
  }
  if (tool.identity.name === "exec" && isJsonRecord(value) && typeof value.cmd === "string") {
    const allowed = new Set([
      "cmd",
      "workdir",
      "yield_time_ms",
      "max_output_tokens",
      "shell",
      "login",
      "tty",
      "sandbox_permissions",
      "justification",
      "prefix_rule",
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
      throw new InferenceError("Krutrim returned unsupported exec_command fields.");
    }
    return `const result = await tools.exec_command(${JSON.stringify(value)});\ntext(result);`;
  }
  throw new InferenceError("Krutrim returned a custom tool call without the required input string.");
}

function messageItem(id: string, text: string, status: "in_progress" | "completed"): JsonRecord {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: [
      {
        type: "output_text",
        text,
        annotations: [],
      },
    ],
  };
}

function usage(value: unknown): JsonRecord | undefined {
  if (!isJsonRecord(value)) {
    return undefined;
  }
  const input = typeof value.prompt_tokens === "number" ? value.prompt_tokens : 0;
  const output = typeof value.completion_tokens === "number" ? value.completion_tokens : 0;
  const total = typeof value.total_tokens === "number" ? value.total_tokens : input + output;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: total,
  };
}

function toolClass(tool: ToolState): string {
  if (tool.identity.kind === "custom") {
    return "custom";
  }
  if (tool.identity.name === "exec_command" || tool.identity.name === "shell_command") {
    return "shell";
  }
  if (tool.identity.name === "write_stdin") {
    return "shell-continuation";
  }
  return tool.identity.namespace === undefined ? "function" : "namespace-function";
}

function argumentShape(source: string): string {
  if (source.length === 0) {
    return "empty";
  }
  try {
    const value = JSON.parse(source) as unknown;
    if (value === null) {
      return "null";
    }
    if (Array.isArray(value)) {
      return "array";
    }
    return typeof value === "object" ? "object" : typeof value;
  } catch {
    return "invalid-json";
  }
}

export async function translateChatCompletionStream(
  upstream: Response,
  model: string,
  toolNames: Map<string, ResponseToolIdentity>,
  writer: ResponsesSseWriter,
  onObservation?: (observation: ChatStreamObservation) => void,
): Promise<void> {
  const id = responseId();
  const completedOutput: JsonRecord[] = [];
  const tools = new Map<number, ToolState>();
  let nextOutputIndex = 0;
  let textId: string | undefined;
  let textOutputIndex: number | undefined;
  let text = "";
  let finalUsage: JsonRecord | undefined;
  let sawDone = false;
  let chunkCount = 0;
  let reasoningDeltaCount = 0;
  let textDeltaCount = 0;
  let toolCallFragmentCount = 0;
  const finishReasons = new Set<string>();
  const observe = (stage: NonNullable<ChatStreamObservation["stage"]>): void => {
    onObservation?.({
      stage,
      chunkCount,
      reasoningDeltaCount,
      textDeltaCount,
      toolCallCount: tools.size,
      toolCallFragmentCount,
      finishReasons: [...finishReasons].sort(),
      toolClasses: [...tools.values()].map(toolClass),
      argumentShapes: [...tools.values()].map((tool) => argumentShape(tool.arguments)),
    });
  };

  writer.write("response.created", {
    type: "response.created",
    response: baseResponse(id, model, "in_progress", []),
  });

  await consumeBoundedSse(
    upstream,
    (event) => {
      if (event.data === "[DONE]") {
        sawDone = true;
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(event.data) as unknown;
      } catch (error) {
        throw new InferenceError("Krutrim returned malformed Chat Completions SSE JSON.", {
          cause: error,
        });
      }
      if (!isJsonRecord(payload)) {
        throw new InferenceError("Krutrim returned a malformed Chat Completions SSE event.");
      }
      chunkCount += 1;
      finalUsage = usage(payload.usage) ?? finalUsage;
      if (!Array.isArray(payload.choices)) {
        return;
      }
      for (const choice of payload.choices) {
        if (!isJsonRecord(choice) || !isJsonRecord(choice.delta)) {
          continue;
        }
        if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
          finishReasons.add(choice.finish_reason);
        }
        const delta = choice.delta;
        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content.length > 0
        ) {
          reasoningDeltaCount += 1;
        }
        if (typeof delta.content === "string" && delta.content.length > 0) {
          textDeltaCount += 1;
          if (textId === undefined) {
            textId = itemId("msg");
            textOutputIndex = nextOutputIndex++;
            writer.write("response.output_item.added", {
              type: "response.output_item.added",
              response_id: id,
              output_index: textOutputIndex,
              item: messageItem(textId, "", "in_progress"),
            });
            writer.write("response.content_part.added", {
              type: "response.content_part.added",
              response_id: id,
              item_id: textId,
              output_index: textOutputIndex,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            });
          }
          text += delta.content;
          writer.write("response.output_text.delta", {
            type: "response.output_text.delta",
            response_id: id,
            item_id: textId,
            output_index: textOutputIndex,
            content_index: 0,
            delta: delta.content,
          });
        }
        if (!Array.isArray(delta.tool_calls)) {
          continue;
        }
        for (const rawCall of delta.tool_calls) {
          toolCallFragmentCount += 1;
          if (!isJsonRecord(rawCall) || !Number.isSafeInteger(rawCall.index)) {
            throw new InferenceError("Krutrim returned a malformed streamed Chat tool call.");
          }
          const index = rawCall.index as number;
          let state = tools.get(index);
          const fn = isJsonRecord(rawCall.function) ? rawCall.function : undefined;
          if (state === undefined) {
            if (
              typeof rawCall.id !== "string" ||
              typeof fn?.name !== "string" ||
              !toolNames.has(fn.name)
            ) {
              const name = typeof fn?.name === "string" ? fn.name : "[missing]";
              throw new InferenceError(
                `Krutrim streamed a tool call without a recognized id and name ` +
                `(id=${typeof rawCall.id === "string" ? "present" : "missing"}, name=${name}).`,
              );
            }
            state = {
              chatIndex: index,
              outputIndex: nextOutputIndex++,
              itemId: itemId(toolNames.get(fn.name)?.kind === "custom" ? "ct" : "fc"),
              callId: rawCall.id,
              chatName: fn.name,
              identity: toolNames.get(fn.name)!,
              arguments: "",
            };
            tools.set(index, state);
            observe("tool-added");
            writer.write("response.output_item.added", {
              type: "response.output_item.added",
              response_id: id,
              output_index: state.outputIndex,
              item: toolItem(state, "in_progress"),
            });
          }
          if (typeof rawCall.id === "string" && rawCall.id !== state.callId) {
            throw new InferenceError("Krutrim changed a streamed Chat tool_call id.");
          }
          if (typeof fn?.name === "string" && fn.name !== state.chatName) {
            throw new InferenceError("Krutrim changed a streamed Chat tool name.");
          }
          if (typeof fn?.arguments === "string" && fn.arguments.length > 0) {
            state.arguments += fn.arguments;
            if (Buffer.byteLength(state.arguments, "utf8") > 256 * 1024) {
              throw new InferenceError("Krutrim streamed oversized function-call arguments.");
            }
          }
        }
      }
    },
    { maxTotalBytes: 16 * 1024 * 1024, maxEventBytes: 512 * 1024, maxEvents: 100_000 },
  );

  if (!sawDone) {
    throw new InferenceError("Krutrim Chat Completions stream ended without [DONE].");
  }
  if (textId !== undefined && textOutputIndex !== undefined) {
    writer.write("response.output_text.done", {
      type: "response.output_text.done",
      response_id: id,
      item_id: textId,
      output_index: textOutputIndex,
      content_index: 0,
      text,
    });
    writer.write("response.content_part.done", {
      type: "response.content_part.done",
      response_id: id,
      item_id: textId,
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: "output_text", text, annotations: [] },
    });
    const item = messageItem(textId, text, "completed");
    completedOutput[textOutputIndex] = item;
    writer.write("response.output_item.done", {
      type: "response.output_item.done",
      response_id: id,
      output_index: textOutputIndex,
      item,
    });
  }
  for (const state of [...tools.values()].sort((left, right) => left.outputIndex - right.outputIndex)) {
    state.arguments = normalizeChatToolArguments(state.arguments, state.chatName);
    if (state.identity.kind === "custom") {
      const input = customToolInput(state);
      writer.write("response.custom_tool_call_input.delta", {
        type: "response.custom_tool_call_input.delta",
        response_id: id,
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: input,
      });
      writer.write("response.custom_tool_call_input.done", {
        type: "response.custom_tool_call_input.done",
        response_id: id,
        item_id: state.itemId,
        output_index: state.outputIndex,
        input,
      });
    } else {
      writer.write("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        response_id: id,
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: state.arguments,
      });
      writer.write("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        response_id: id,
        item_id: state.itemId,
        output_index: state.outputIndex,
        arguments: state.arguments,
      });
    }
    const item = toolItem(state, "completed");
    completedOutput[state.outputIndex] = item;
    writer.write("response.output_item.done", {
      type: "response.output_item.done",
      response_id: id,
      output_index: state.outputIndex,
      item,
    });
  }
  observe("stream-complete");
  if (completedOutput.filter(Boolean).length === 0) {
    throw new InferenceError(
      "Krutrim Chat Completions completed without assistant text or a tool call.",
    );
  }
  const completed = baseResponse(id, model, "completed", completedOutput);
  if (finalUsage !== undefined) {
    completed.usage = finalUsage;
  }
  writer.write("response.completed", { type: "response.completed", response: completed });
}
