import { describe, expect, it } from "vitest";

import { consumeBoundedSse, readBoundedSse } from "../../src/probes/sse.js";

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("bounded SSE reader", () => {
  it("handles fragmented CRLF frames, comments, and multiline data", async () => {
    const encoder = new TextEncoder();
    const source =
      ": keepalive\r\nevent: response.created\r\ndata: {\"type\":\r\ndata: \"response.created\"}\r\n\r\n";
    const bytes = encoder.encode(source);
    const chunks = [bytes.slice(0, 5), bytes.slice(5, 23), bytes.slice(23, 49), bytes.slice(49)];

    await expect(readBoundedSse(responseFromChunks(chunks))).resolves.toEqual([
      {
        event: "response.created",
        data: "{\"type\":\n\"response.created\"}",
      },
    ]);
  });

  it("rejects an oversized total stream", async () => {
    const response = responseFromChunks([new TextEncoder().encode("data: 1234567890\n\n")]);
    await expect(readBoundedSse(response, { maxTotalBytes: 8 })).rejects.toThrow(/exceeded 8 bytes/u);
  });

  it("rejects an oversized individual event", async () => {
    const response = responseFromChunks([new TextEncoder().encode("data: 1234567890\n\n")]);
    await expect(readBoundedSse(response, { maxEventBytes: 4 })).rejects.toThrow(/larger than 4 bytes/u);
  });

  it("rejects more than the configured number of events", async () => {
    const response = responseFromChunks([new TextEncoder().encode("data: one\n\ndata: two\n\n")]);
    await expect(readBoundedSse(response, { maxEvents: 1 })).rejects.toThrow(/exceeded 1 SSE events/u);
  });

  it("rejects invalid UTF-8", async () => {
    const response = responseFromChunks([new Uint8Array([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff])]);
    await expect(readBoundedSse(response)).rejects.toThrow();
  });

  it("delivers events incrementally through the bounded consumer", async () => {
    const seen: string[] = [];
    const response = responseFromChunks([
      new TextEncoder().encode("data: one\n\ndata: two\n\n"),
    ]);

    await consumeBoundedSse(response, (event) => seen.push(event.data));

    expect(seen).toEqual(["one", "two"]);
  });
});
