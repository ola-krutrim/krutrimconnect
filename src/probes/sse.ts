export interface SseEvent {
  event?: string;
  data: string;
}

export interface SseLimits {
  maxTotalBytes?: number;
  maxEventBytes?: number;
  maxEvents?: number;
}

const DEFAULT_TOTAL_BYTES = 1024 * 1024;
const DEFAULT_EVENT_BYTES = 64 * 1024;
const DEFAULT_EVENTS = 512;

export async function consumeBoundedSse(
  response: Response,
  onEvent: (event: SseEvent) => void,
  limits: SseLimits = {},
): Promise<void> {
  if (response.body === null) {
    throw new Error("Responses stream did not include a body.");
  }
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_TOTAL_BYTES;
  const maxEventBytes = limits.maxEventBytes ?? DEFAULT_EVENT_BYTES;
  const maxEvents = limits.maxEvents ?? DEFAULT_EVENTS;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let eventCount = 0;
  let buffer = "";
  let totalBytes = 0;
  let eventName: string | undefined;
  let dataLines: string[] = [];

  const currentEventBytes = (): number =>
    Buffer.byteLength(dataLines.join("\n"), "utf8") +
    (eventName === undefined ? 0 : Buffer.byteLength(eventName, "utf8"));

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      eventName = undefined;
      return;
    }
    if (eventCount >= maxEvents) {
      throw new Error(`Responses stream exceeded ${maxEvents} SSE events.`);
    }
    const event: SseEvent = { data: dataLines.join("\n") };
    if (eventName !== undefined) {
      event.event = eventName;
    }
    eventCount += 1;
    onEvent(event);
    eventName = undefined;
    dataLines = [];
  };

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) {
      dispatch();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      eventName = value;
    } else if (field === "data") {
      dataLines.push(value);
    }
    if (currentEventBytes() > maxEventBytes) {
      throw new Error(`Responses stream contained an SSE event larger than ${maxEventBytes} bytes.`);
    }
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw new Error(`Responses stream exceeded ${maxTotalBytes} bytes.`);
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
      if (Buffer.byteLength(buffer, "utf8") > maxEventBytes) {
        throw new Error(`Responses stream contained an unterminated line larger than ${maxEventBytes} bytes.`);
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      consumeLine(buffer);
    }
    dispatch();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function readBoundedSse(
  response: Response,
  limits: SseLimits = {},
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  await consumeBoundedSse(response, (event) => events.push(event), limits);
  return events;
}
