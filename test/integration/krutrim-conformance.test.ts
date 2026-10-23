import { describe, expect, it } from "vitest";

import { krutrimProvider } from "../../src/providers/krutrim.js";
import { runKrutrimCodexProbe } from "../../src/probes/krutrim-responses.js";

const apiKey = process.env.KRUTRIM_API_KEY?.trim();
const model = process.env.KRUTRIM_PROBE_MODEL?.trim();
const billableOptIn = process.env.KRUTRIM_ALLOW_BILLABLE_PROBES === "1";

describe.skipIf(!(apiKey && model && billableOptIn))("Krutrim Responses/tool-call conformance", () => {
  it("passes the model-bound Codex core protocol probe", async () => {
    const report = await runKrutrimCodexProbe({
      provider: krutrimProvider,
      model: model!,
      apiKey: apiKey!,
    });

    expect(report.outcome, JSON.stringify(report.checks)).toBe("passed");
  });
});
