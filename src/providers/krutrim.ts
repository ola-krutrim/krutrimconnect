import { ConfigurationError } from "../errors.js";
import type { ProviderAdapter } from "./types.js";

export const KRUTRIM_BASE_URL = "https://cloud.olakrutrim.com/v1";

function validateModelId(value: string): string {
  if (value.length === 0) {
    throw new ConfigurationError("A non-empty model id is required.");
  }
  if (value !== value.trim()) {
    throw new ConfigurationError("The model id must not contain surrounding whitespace.");
  }
  if (value.length > 256) {
    throw new ConfigurationError("The model id is longer than 256 characters.");
  }
  if (/\p{Cc}/u.test(value)) {
    throw new ConfigurationError("The model id must not contain control characters.");
  }
  return value;
}

export const krutrimProvider: ProviderAdapter = {
  id: "krutrim",
  displayName: "Krutrim Cloud",
  baseUrl: KRUTRIM_BASE_URL,
  authentication: {
    scheme: "bearer",
    source: "credential-helper",
  },
  capabilities: {
    responsesApi: {
      support: "unknown",
      evidence: "unknown",
      detail: "Krutrim's public docs currently document Chat Completions, not /v1/responses.",
    },
    streaming: {
      support: "unknown",
      evidence: "unknown",
      detail:
        "Chat Completions token streaming is documented, but Codex-compatible Responses SSE and streamed tool-call deltas are not.",
    },
    toolCalling: {
      support: "unknown",
      evidence: "unknown",
      detail: "No public tool/function-calling contract was found.",
    },
    structuredOutput: {
      support: "unknown",
      evidence: "unknown",
      detail: "No public JSON schema or structured-output contract was found.",
    },
    modelListing: {
      support: "unknown",
      evidence: "unknown",
      detail: "No public GET /v1/models contract was found.",
    },
  },
  resolveModel(requestedModel) {
    return { id: validateModelId(requestedModel), source: "explicit" };
  },
  capabilitiesFor() {
    return this.capabilities;
  },
};
