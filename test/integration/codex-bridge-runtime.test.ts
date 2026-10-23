import { afterAll, describe, expect, it } from "vitest";

import {
  runCodexBridgeCanary,
  runCodexCanaryProcess,
  type CodexCanaryProcessResult,
} from "../../src/probes/codex-bridge-canary.js";
import {
  prepareCodexModelCatalog,
  removeManagedCodexModelCatalog,
} from "../../src/codex/model-catalog.js";
import {
  createTestWorkspace,
  testCatalogOptions,
  type TestWorkspace,
} from "../helpers.js";

const enabled = process.env.KRUTRIM_RUN_INSTALLED_CODEX_TEST === "1";
const model = "Qwen3.6-35B-A3B";
const apiKey = "local-fake-upstream-key";
const marker = "KRUTRIM_CONNECT_FULL_CODEX_CANARY_OK";

function chatSse(chunks: Record<string, unknown>[]): Response {
  const source = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("") + "data: [DONE]\n\n";
  return new Response(source, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): Record<string, unknown> {
  return {
    id: "chatcmpl_local_canary",
    object: "chat.completion.chunk",
    created: 1_786_622_000,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

describe.skipIf(!enabled)("installed Codex against the local bridge protocol", () => {
  let workspace: TestWorkspace;

  afterAll(async () => {
    await workspace?.cleanup();
  });

  it("completes a direct shell function call and continuation without a live upstream", async () => {
    workspace = await createTestWorkspace();
    const catalog = await prepareCodexModelCatalog(workspace.paths, {
      model,
      apiKey,
      mode: "bridge",
      ...testCatalogOptions,
    });
    let processResult: CodexCanaryProcessResult | undefined;
    let requestCount = 0;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role?: string; content?: unknown }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      const continuation = body.messages.some((message) => message.role === "tool");
      if (continuation) {
        return chatSse([
          chunk({ role: "assistant", content: marker }, null),
          chunk({}, "stop"),
        ]);
      }
      const shellTool = body.tools?.find((tool) =>
        tool.function?.name === "exec_command" || tool.function?.name === "shell_command"
      );
      if (shellTool === undefined) {
        throw new Error("The direct shell function was not advertised to the bridge upstream.");
      }
      if (!JSON.stringify(body.messages).includes("Call the exec_command function exactly once")) {
        throw new Error("The installed Codex request did not contain the deterministic canary instruction.");
      }
      const shellName = shellTool.function?.name as "exec_command" | "shell_command";
      return chatSse([
        chunk({
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call_local_exec",
            type: "function",
            function: {
              name: shellName,
              arguments: JSON.stringify(
                shellName === "exec_command" ? { cmd: "pwd" } : { command: "pwd" },
              ),
            },
          }],
        }, null),
        chunk({}, "tool_calls"),
      ]);
    };

    try {
      const result = await runCodexBridgeCanary({
        model,
        apiKey,
        modelCatalogPath: catalog.path,
        cwd: workspace.root,
        fetchImpl: fetchImpl as typeof fetch,
        processRunner: async (request) => {
          processResult = await runCodexCanaryProcess(request);
          return processResult;
        },
      });
      expect(
        result,
        JSON.stringify({
          result,
          requestCount,
          processResult,
        }),
      ).toMatchObject({ status: "pass" });
    } finally {
      if (catalog.created) {
        await removeManagedCodexModelCatalog(
          workspace.paths,
          catalog.path,
          catalog.sha256,
        );
      }
    }
  }, 30_000);
});
