import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_STDIN_API_KEY_BYTES,
  readApiKeyInput,
  KRUTRIM_MODELS_URL,
  validateKrutrimApiKey,
  selectApiKeyInputSource,
} from "../src/auth.js";

describe("credential input selection", () => {
  it("uses the masked prompt by default on an interactive terminal", () => {
    expect(selectApiKeyInputSource({
      fromEnv: false,
      stdin: false,
      inputIsTTY: true,
    })).toBe("prompt");
  });

  it("requires explicit, mutually exclusive noninteractive input", () => {
    expect(selectApiKeyInputSource({
      fromEnv: true,
      stdin: false,
      inputIsTTY: false,
    })).toBe("environment");
    expect(selectApiKeyInputSource({
      fromEnv: false,
      stdin: true,
      inputIsTTY: false,
    })).toBe("stdin");
    expect(() => selectApiKeyInputSource({
      fromEnv: true,
      stdin: true,
      inputIsTTY: false,
    })).toThrow(/only one/u);
    expect(() => selectApiKeyInputSource({
      fromEnv: false,
      stdin: false,
      inputIsTTY: false,
    })).toThrow(/requires a terminal/u);
    expect(() => selectApiKeyInputSource({
      fromEnv: false,
      stdin: true,
      inputIsTTY: true,
    })).toThrow(/requires piped input/u);
  });

  it("reads a bounded UTF-8 key and removes only one shell line ending", async () => {
    await expect(readApiKeyInput(Readable.from(["not-a-real-key\r\n"])))
      .resolves.toBe("not-a-real-key");
    await expect(readApiKeyInput(Readable.from(["not-a-real-key\n\n"])))
      .resolves.toBe("not-a-real-key\n");
  });

  it("rejects invalid UTF-8 and oversized input", async () => {
    await expect(readApiKeyInput(Readable.from([Buffer.from([0xff])])))
      .rejects.toThrow(/valid UTF-8/u);
    await expect(readApiKeyInput(Readable.from([
      Buffer.alloc(MAX_STDIN_API_KEY_BYTES + 1, 0x61),
    ]))).rejects.toThrow(/exceeds/u);
  });
});


describe("Krutrim credential validation", () => {
  const apiKey = "candidate-key-never-logged";
  const observedAt = new Date("2026-08-27T00:00:00.000Z");

  it("rejects malformed keys before making a network request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(validateKrutrimApiKey(" key-with-whitespace ", { fetchImpl }))
      .rejects.toThrow(/invalid format/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an invalid-token rejection before accepting a candidate key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer krutrim-connect-intentionally-invalid") {
        return new Response(null, { status: 401 });
      }
      expect(authorization).toBe(`Bearer ${apiKey}`);
      return Response.json({ object: "list", data: [] });
    });

    await expect(validateKrutrimApiKey(apiKey, {
      fetchImpl,
      now: () => observedAt,
    })).resolves.toEqual({
      status: "validated",
      method: "authenticated-model-catalogue-v1",
      endpoint: KRUTRIM_MODELS_URL,
      validatedAt: observedAt.toISOString(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchImpl.mock.calls) {
      expect(input).toBe("https://cloud.olakrutrim.com/v1/models");
      expect(init).toMatchObject({ method: "GET", redirect: "manual" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("fails closed when the endpoint accepts the invalid-token control", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ object: "list", data: [] }));

    await expect(validateKrutrimApiKey(apiKey, { fetchImpl }))
      .rejects.toThrow(/invalid-token control \(HTTP 200\)/u);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("rejects an unauthorized candidate with HTTP %i", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status }));

    await expect(validateKrutrimApiKey(apiKey, { fetchImpl }))
      .rejects.toThrow(
        "Krutrim rejected the API key. It may be invalid, expired, or revoked. Your existing saved credential was not changed.",
      );
  });

  it.each([302, 429, 500])("does not store on unexpected HTTP %i", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status }));

    await expect(validateKrutrimApiKey(apiKey, { fetchImpl }))
      .rejects.toThrow(new RegExp(`could not validate.*HTTP ${status}`, "u"));
  });

  it("rejects non-JSON, malformed JSON, and unexpected catalogue shapes", async () => {
    const candidates = [
      new Response("Access denied", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
      new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
      Response.json({ object: "not-a-list", data: [] }),
    ];
    for (const candidate of candidates) {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 401 }))
        .mockResolvedValueOnce(candidate);
      await expect(validateKrutrimApiKey(apiKey, { fetchImpl })).rejects.toThrow();
    }
  });

  it("rejects oversized and unreachable validation responses without exposing the key", async () => {
    const oversized = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(4 * 1024 * 1024 + 1),
        },
      }));
    await expect(validateKrutrimApiKey(apiKey, { fetchImpl: oversized }))
      .rejects.not.toThrow(apiKey);

    const unreachable = vi.fn<typeof fetch>(async () => {
      throw new Error(`network error with ${apiKey}`);
    });
    await expect(validateKrutrimApiKey(apiKey, { fetchImpl: unreachable }))
      .rejects.not.toThrow(apiKey);
  });
});
