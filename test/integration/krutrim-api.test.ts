import { describe, expect, it } from "vitest";

import { validateKrutrimApiKey } from "../../src/auth.js";
import { KRUTRIM_BASE_URL } from "../../src/providers/krutrim.js";
import { validateApiKey } from "../../src/secrets/manager.js";

const apiKey = process.env.KRUTRIM_API_KEY;

describe.skipIf(!apiKey)("Krutrim API contract", () => {
  it("validates the supplied key through the non-inference model catalogue", async () => {
    validateApiKey(apiKey!);
    await expect(validateKrutrimApiKey(apiKey!)).resolves.toMatchObject({
      status: "validated",
    });
  });

  it("distinguishes the supplied credential from an invalid bearer token", async () => {
    validateApiKey(apiKey!);
    const request = async (credential: string): Promise<Response> => {
      try {
        return await fetch(`${KRUTRIM_BASE_URL}/chat/completions`, {
          method: "POST",
          redirect: "manual",
          headers: {
            Authorization: `Bearer ${credential}`,
            "Content-Type": "application/json",
          },
          body: "{}",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error("Krutrim integration request failed before a safe response was received.");
      }
    };

    const invalidResponse = await request("krutrim-connect-intentionally-invalid");
    const invalidStatus = invalidResponse.status;
    await invalidResponse.body?.cancel().catch(() => undefined);
    expect([401, 403]).toContain(invalidStatus);

    // Send the real credential only after the invalid-token control proves
    // this route authenticates before body validation.
    const validResponse = await request(apiKey!);

    // Both requests are intentionally model-free, so they cannot generate
    // output. Requiring different auth/schema responses prevents a WAF or a
    // body-first validator from making an invalid key look valid.
    const validStatus = validResponse.status;
    await validResponse.body?.cancel().catch(() => undefined);
    expect([400, 422]).toContain(validStatus);
  });
});
