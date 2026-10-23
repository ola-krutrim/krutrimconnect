import { createHash } from "node:crypto";

import { ConfigurationError } from "../errors.js";

export type JsonRecord = Record<string, unknown>;

export interface ResponseToolIdentity {
  name: string;
  namespace?: string;
  kind?: "custom";
}

export interface TranslatedResponsesRequest {
  chatBody: JsonRecord;
  toolNames: Map<string, ResponseToolIdentity>;
}

const CODEX_TOOL_PROTOCOL_GUIDANCE =
  "Follow the tool protocol exactly. When the user explicitly requests an available tool action, " +
  "call the matching function instead of answering directly. Preserve required argument values. " +
  "After a tool result is supplied, use that result and do not repeat the same call unless it is explicitly requested again.";

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    throw new ConfigurationError("A Responses message contained unsupported content.");
  }
  const parts: string[] = [];
  for (const part of value) {
    if (!isRecord(part)) {
      throw new ConfigurationError("A Responses message contained malformed content.");
    }
    if (
      (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
      continue;
    }
    if (part.type === "refusal" && typeof part.refusal === "string") {
      parts.push(part.refusal);
      continue;
    }
    throw new ConfigurationError(`The local bridge does not support Responses content type '${String(part.type)}'.`);
  }
  return parts.join("");
}

function safeToolName(name: string, namespace: string | undefined, index: number): string {
  if (namespace === undefined && /^[A-Za-z0-9_-]{1,64}$/u.test(name)) {
    return name;
  }
  const readable = `${namespace ?? "tool"}_${name}`
    .replace(/[^A-Za-z0-9_-]/gu, "_")
    .slice(0, 42);
  const suffix = createHash("sha256")
    .update(namespace ?? "")
    .update("\0")
    .update(name)
    .digest("hex")
    .slice(0, 10);
  return `kc_${index}_${readable}_${suffix}`.slice(0, 64);
}

function addFunctionTool(
  source: JsonRecord,
  namespace: string | undefined,
  index: number,
  chatTools: JsonRecord[],
  toolNames: Map<string, ResponseToolIdentity>,
): void {
  if (typeof source.name !== "string" || source.name.length === 0) {
    throw new ConfigurationError("A Responses function tool is missing its name.");
  }
  const encoded = safeToolName(source.name, namespace, index);
  if (toolNames.has(encoded)) {
    throw new ConfigurationError("Responses tools produced a duplicate bridge tool name.");
  }
  toolNames.set(encoded, {
    name: source.name,
    ...(namespace === undefined ? {} : { namespace }),
  });
  const fn: JsonRecord = {
    name: encoded,
    parameters: isRecord(source.parameters)
      ? source.parameters
      : { type: "object", properties: {} },
  };
  if (typeof source.description === "string") {
    fn.description = source.description;
  }
  if (typeof source.strict === "boolean") {
    fn.strict = source.strict;
  }
  chatTools.push({ type: "function", function: fn });
}

function addCustomTool(
  source: JsonRecord,
  index: number,
  chatTools: JsonRecord[],
  toolNames: Map<string, ResponseToolIdentity>,
): void {
  if (typeof source.name !== "string" || source.name.length === 0) {
    throw new ConfigurationError("A Responses custom tool is missing its name.");
  }
  // gpt-oss follows its Chat tool-call training and emits exec_command for
  // Codex's code-mode custom tool named exec. Keep this one exact alias
  // reversible; all other tool identities remain strict.
  const encoded = source.name === "exec"
    ? "exec_command"
    : safeToolName(source.name, undefined, index);
  if (toolNames.has(encoded)) {
    throw new ConfigurationError("Responses tools produced a duplicate bridge tool name.");
  }
  toolNames.set(encoded, { name: source.name, kind: "custom" });
  const description = typeof source.description === "string"
    ? `${source.description}\nReturn the custom tool's complete raw input in the required input string.`
    : "Return the custom tool's complete raw input in the required input string.";
  const execParameters: JsonRecord = {
    type: "object",
    properties: {
      cmd: { type: "string" },
      workdir: { type: "string" },
      yield_time_ms: { type: "integer" },
      max_output_tokens: { type: "integer" },
      shell: { type: "string" },
      login: { type: "boolean" },
      tty: { type: "boolean" },
      sandbox_permissions: { type: "string", enum: ["use_default", "require_escalated"] },
      justification: { type: "string" },
      prefix_rule: { type: "array", items: { type: "string" } },
    },
    required: ["cmd"],
    additionalProperties: false,
  };
  chatTools.push({
    type: "function",
    function: {
      name: encoded,
      description: source.name === "exec"
        ? `${description}\nUse the exec_command argument schema; the bridge converts it to Codex code-mode input.`
        : description,
      parameters: source.name === "exec" ? execParameters : {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "The exact complete raw input for the custom tool.",
          },
        },
        required: ["input"],
        additionalProperties: false,
      },
    },
  });
}

function translateTools(value: unknown): {
  chatTools: JsonRecord[];
  toolNames: Map<string, ResponseToolIdentity>;
} {
  const chatTools: JsonRecord[] = [];
  const toolNames = new Map<string, ResponseToolIdentity>();
  if (value === undefined) {
    return { chatTools, toolNames };
  }
  if (!Array.isArray(value)) {
    throw new ConfigurationError("Responses tools must be an array.");
  }
  let index = 0;
  for (const tool of value) {
    if (!isRecord(tool)) {
      throw new ConfigurationError("A Responses tool is malformed.");
    }
    if (tool.type === "function") {
      addFunctionTool(tool, undefined, index++, chatTools, toolNames);
      continue;
    }
    if (tool.type === "custom") {
      addCustomTool(tool, index++, chatTools, toolNames);
      continue;
    }
    if (tool.type === "namespace") {
      if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
        throw new ConfigurationError("A Responses namespace tool is malformed.");
      }
      for (const nested of tool.tools) {
        if (!isRecord(nested) || nested.type !== "function") {
          throw new ConfigurationError("The local bridge supports only function tools inside namespaces.");
        }
        addFunctionTool(nested, tool.name, index++, chatTools, toolNames);
      }
      continue;
    }
    if (tool.type === "web_search" || tool.type === "web_search_preview") {
      // Search is provider-executed in Responses, but the fixed Chat upstream
      // has no equivalent. Do not advertise it to the model or fail otherwise
      // valid Codex coding traffic merely because Codex included the optional
      // declaration. The managed model catalogue also marks search unsupported.
      continue;
    }
    throw new ConfigurationError(
      `The local bridge cannot safely emulate Responses tool type '${String(tool.type)}'.`,
    );
  }
  return { chatTools, toolNames };
}

function encodedToolName(
  toolNames: Map<string, ResponseToolIdentity>,
  name: string,
  namespace: string | undefined,
  kind: "function" | "custom" = "function",
): string {
  for (const [encoded, identity] of toolNames) {
    if (
      identity.name === name &&
      identity.namespace === namespace &&
      (kind === "custom" ? identity.kind === "custom" : identity.kind !== "custom")
    ) {
      return encoded;
    }
  }
  throw new ConfigurationError(`A function call refers to undeclared tool '${name}'.`);
}

function translateInput(
  value: unknown,
  instructions: unknown,
  toolNames: Map<string, ResponseToolIdentity>,
): JsonRecord[] {
  const messages: JsonRecord[] = [];
  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }
  if (typeof value === "string") {
    messages.push({ role: "user", content: value });
    return messages;
  }
  if (!Array.isArray(value)) {
    throw new ConfigurationError("Responses input must be a string or an array of input items.");
  }

  let pendingCalls: JsonRecord[] = [];
  const flushCalls = (): void => {
    if (pendingCalls.length > 0) {
      messages.push({ role: "assistant", content: null, tool_calls: pendingCalls });
      pendingCalls = [];
    }
  };

  for (const item of value) {
    if (!isRecord(item)) {
      throw new ConfigurationError("A Responses input item is malformed.");
    }
    if (item.type === "reasoning") {
      continue;
    }
    if (item.type === "function_call") {
      if (
        typeof item.name !== "string" ||
        typeof item.arguments !== "string" ||
        typeof item.call_id !== "string"
      ) {
        throw new ConfigurationError("A Responses function_call item is malformed.");
      }
      const namespace = typeof item.namespace === "string" ? item.namespace : undefined;
      pendingCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: encodedToolName(toolNames, item.name, namespace),
          arguments: item.arguments,
        },
      });
      continue;
    }
    if (item.type === "custom_tool_call") {
      if (
        typeof item.name !== "string" ||
        typeof item.input !== "string" ||
        typeof item.call_id !== "string"
      ) {
        throw new ConfigurationError("A Responses custom_tool_call item is malformed.");
      }
      pendingCalls.push({
        id: item.call_id,
        type: "function",
        function: {
          name: encodedToolName(toolNames, item.name, undefined, "custom"),
          arguments: JSON.stringify({ input: item.input }),
        },
      });
      continue;
    }
    flushCalls();
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string") {
        throw new ConfigurationError("A Responses function_call_output item is missing call_id.");
      }
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      });
      continue;
    }
    if (item.type === "message" || typeof item.role === "string") {
      const role = item.role === "developer" ? "system" : item.role;
      if (role !== "system" && role !== "user" && role !== "assistant") {
        throw new ConfigurationError(`The local bridge does not support message role '${String(item.role)}'.`);
      }
      messages.push({ role, content: textContent(item.content) });
      continue;
    }
    throw new ConfigurationError(`The local bridge does not support Responses input type '${String(item.type)}'.`);
  }
  flushCalls();
  return messages;
}

function translateToolChoice(
  value: unknown,
  toolNames: Map<string, ResponseToolIdentity>,
): unknown {
  if (value === undefined || typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    throw new ConfigurationError("Responses tool_choice is malformed.");
  }
  if (value.type === "function" && typeof value.name === "string") {
    const namespace = typeof value.namespace === "string" ? value.namespace : undefined;
    return {
      type: "function",
      function: { name: encodedToolName(toolNames, value.name, namespace) },
    };
  }
  if (value.type === "custom" && typeof value.name === "string") {
    return {
      type: "function",
      function: { name: encodedToolName(toolNames, value.name, undefined, "custom") },
    };
  }
  throw new ConfigurationError("The local bridge does not support this Responses tool_choice.");
}

function coalesceSystemMessages(
  messages: JsonRecord[],
  includeToolGuidance: boolean,
): JsonRecord[] {
  const systemContent: string[] = includeToolGuidance ? [CODEX_TOOL_PROTOCOL_GUIDANCE] : [];
  const conversation: JsonRecord[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content !== "string") {
        throw new ConfigurationError("A translated system message has invalid content.");
      }
      if (message.content.length > 0) {
        systemContent.push(message.content);
      }
      continue;
    }
    conversation.push(message);
  }
  return systemContent.length === 0
    ? conversation
    : [{ role: "system", content: systemContent.join("\n\n") }, ...conversation];
}

export function translateResponsesRequest(
  value: unknown,
  expectedModel: string,
): TranslatedResponsesRequest {
  if (!isRecord(value)) {
    throw new ConfigurationError("Responses request body must be a JSON object.");
  }
  if (value.model !== expectedModel) {
    throw new ConfigurationError("The local bridge is bound to a different model.");
  }
  if (value.stream !== true) {
    throw new ConfigurationError("Codex bridge requests must use Responses streaming.");
  }
  const { chatTools, toolNames } = translateTools(value.tools);
  const messages = coalesceSystemMessages(
    translateInput(value.input, value.instructions, toolNames),
    chatTools.length > 0,
  );
  const chatBody: JsonRecord = {
    model: expectedModel,
    messages,
    stream: true,
  };
  if (chatTools.length > 0) {
    chatBody.tools = chatTools;
  }
  const toolChoice = translateToolChoice(value.tool_choice, toolNames);
  if (toolChoice !== undefined && chatTools.length > 0) {
    chatBody.tool_choice = toolChoice;
  }
  if (typeof value.parallel_tool_calls === "boolean") {
    chatBody.parallel_tool_calls = value.parallel_tool_calls;
  }
  if (Number.isSafeInteger(value.max_output_tokens) && (value.max_output_tokens as number) > 0) {
    chatBody.max_tokens = value.max_output_tokens;
  }
  if (typeof value.temperature === "number") {
    chatBody.temperature = value.temperature;
  }
  if (typeof value.top_p === "number") {
    chatBody.top_p = value.top_p;
  }
  return { chatBody, toolNames };
}

export function isJsonRecord(value: unknown): value is JsonRecord {
  return isRecord(value);
}
