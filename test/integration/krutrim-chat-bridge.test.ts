import { describe, expect, it } from "vitest";

import { krutrimProvider } from "../../src/providers/krutrim.js";
import { runKrutrimChatBridgeProbe } from "../../src/probes/krutrim-chat-tools.js";

const apiKey = process.env.KRUTRIM_API_KEY?.trim();
const model = process.env.KRUTRIM_BRIDGE_PROBE_MODEL?.trim();
const billableOptIn = process.env.KRUTRIM_ALLOW_BILLABLE_BRIDGE_PROBES === "1";

describe.skipIf(!(apiKey && model && billableOptIn))("Krutrim Chat bridge feasibility", () => {
  it("establishes at least a buffered function-call bridge mode", async () => {
    const report = await runKrutrimChatBridgeProbe({
      provider: krutrimProvider,
      model: model!,
      apiKey: apiKey!,
    });

    expect(
      ["streaming-compatible", "buffered-compatible"],
      JSON.stringify(report.checks),
    ).toContain(report.outcome);
  });
});
