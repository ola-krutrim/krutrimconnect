import { InferenceError } from "../errors.js";
import { isJsonRecord, type JsonRecord } from "./translate.js";

const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_DEPTH = 64;
const MAX_ITEMS = 10_000;
const GEMMA_PREFIX = "<|tool_call>call:";
const GEMMA_SUFFIX = "<tool_call|>";
const GEMMA_QUOTE = '<|"|>';
const SAFE_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;

class GemmaToolArgumentsParser {
  readonly #source: string;
  #index = 0;
  #items = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(expectedToolName: string): JsonRecord {
    this.#expect(GEMMA_PREFIX);
    const objectStart = this.#source.indexOf("{", this.#index);
    if (objectStart < 0) {
      this.#fail();
    }
    const toolName = this.#source.slice(this.#index, objectStart);
    if (!SAFE_TOOL_NAME.test(toolName) || toolName !== expectedToolName) {
      throw new InferenceError("Krutrim's wrapped tool arguments named a different function.");
    }
    this.#index = objectStart;
    const value = this.#parseObject(0);
    this.#skipWhitespace();
    this.#expect(GEMMA_SUFFIX);
    this.#skipWhitespace();
    if (this.#index !== this.#source.length) {
      this.#fail();
    }
    return value;
  }

  #parseValue(depth: number): unknown {
    if (depth > MAX_DEPTH) {
      throw new InferenceError("Krutrim's wrapped tool arguments exceeded the nesting limit.");
    }
    this.#countItem();
    this.#skipWhitespace();
    if (this.#source.startsWith(GEMMA_QUOTE, this.#index)) {
      return this.#parseGemmaString();
    }
    const current = this.#source[this.#index];
    if (current === '"') {
      return this.#parseJsonString();
    }
    if (current === "{") {
      return this.#parseObject(depth + 1);
    }
    if (current === "[") {
      return this.#parseArray(depth + 1);
    }
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.#source.startsWith(literal, this.#index)) {
        this.#index += literal.length;
        return value;
      }
    }
    const number = this.#source.slice(this.#index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u)?.[0];
    if (number !== undefined) {
      this.#index += number.length;
      const parsed = Number(number);
      if (!Number.isFinite(parsed)) {
        this.#fail();
      }
      return parsed;
    }
    this.#fail();
  }

  #parseObject(depth: number): JsonRecord {
    this.#expect("{");
    const result: JsonRecord = {};
    this.#skipWhitespace();
    if (this.#consume("}")) {
      return result;
    }
    while (true) {
      this.#countItem();
      this.#skipWhitespace();
      const key = this.#source.startsWith(GEMMA_QUOTE, this.#index)
        ? this.#parseGemmaString()
        : this.#source[this.#index] === '"'
          ? this.#parseJsonString()
          : this.#parseIdentifier();
      if (Object.hasOwn(result, key)) {
        throw new InferenceError("Krutrim's wrapped tool arguments contained a duplicate key.");
      }
      this.#skipWhitespace();
      this.#expect(":");
      result[key] = this.#parseValue(depth);
      this.#skipWhitespace();
      if (this.#consume("}")) {
        return result;
      }
      this.#expect(",");
    }
  }

  #parseArray(depth: number): unknown[] {
    this.#expect("[");
    const result: unknown[] = [];
    this.#skipWhitespace();
    if (this.#consume("]")) {
      return result;
    }
    while (true) {
      result.push(this.#parseValue(depth));
      this.#skipWhitespace();
      if (this.#consume("]")) {
        return result;
      }
      this.#expect(",");
    }
  }

  #parseIdentifier(): string {
    const value = this.#source.slice(this.#index).match(/^[A-Za-z_][A-Za-z0-9_-]*/u)?.[0];
    if (value === undefined) {
      this.#fail();
    }
    this.#index += value.length;
    return value;
  }

  #parseGemmaString(): string {
    this.#expect(GEMMA_QUOTE);
    const end = this.#source.indexOf(GEMMA_QUOTE, this.#index);
    if (end < 0) {
      this.#fail();
    }
    const raw = this.#source.slice(this.#index, end);
    this.#index = end + GEMMA_QUOTE.length;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      return raw;
    }
  }

  #parseJsonString(): string {
    const start = this.#index;
    this.#index += 1;
    let escaped = false;
    while (this.#index < this.#source.length) {
      const current = this.#source[this.#index++]!;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        try {
          return JSON.parse(this.#source.slice(start, this.#index)) as string;
        } catch {
          this.#fail();
        }
      }
    }
    this.#fail();
  }

  #skipWhitespace(): void {
    while (/\s/u.test(this.#source[this.#index] ?? "")) {
      this.#index += 1;
    }
  }

  #consume(value: string): boolean {
    if (!this.#source.startsWith(value, this.#index)) {
      return false;
    }
    this.#index += value.length;
    return true;
  }

  #expect(value: string): void {
    if (!this.#consume(value)) {
      this.#fail();
    }
  }

  #countItem(): void {
    this.#items += 1;
    if (this.#items > MAX_ITEMS) {
      throw new InferenceError("Krutrim's wrapped tool arguments exceeded the item limit.");
    }
  }

  #fail(): never {
    throw new InferenceError("Krutrim returned malformed wrapped tool arguments.");
  }
}

export function normalizeChatToolArguments(source: string, expectedToolName: string): string {
  if (Buffer.byteLength(source, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new InferenceError("Krutrim returned oversized function-call arguments.");
  }
  try {
    const parsed = JSON.parse(source) as unknown;
    if (!isJsonRecord(parsed)) {
      throw new InferenceError("Krutrim function-call arguments must be a JSON object.");
    }
    return source;
  } catch (error) {
    if (error instanceof InferenceError) {
      throw error;
    }
  }
  const parsed = new GemmaToolArgumentsParser(source).parse(expectedToolName);
  return JSON.stringify(parsed);
}
