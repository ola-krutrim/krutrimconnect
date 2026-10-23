import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCodexToml } from "../src/config/codex-toml.js";
import {
  reachedStrictCodexTerminalGate,
  rebaseCodexConfigPaths,
  runDoctor,
  validateWithOfficialSchema,
} from "../src/doctor.js";
import { createTestWorkspace, supportedProvider, type TestWorkspace } from "./helpers.js";

const workspaces: TestWorkspace[] = [];

async function workspace(): Promise<TestWorkspace> {
  const created = await createTestWorkspace();
  workspaces.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(async (item) => await item.cleanup()));
});

describe("doctor endpoint checks", () => {
  it("checks the documented route without credentials or redirect following", async () => {
    const test = await workspace();
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(null, { status: 401 });
    }) as typeof fetch;

    const report = await runDoctor({
      paths: test.paths,
      provider: supportedProvider,
      harness: test.harness,
      secrets: { read: async () => "present-but-never-sent" },
      fetchImpl,
      codexConfigValidator: async () => ({ status: "pass", message: "test fixture" }),
    });

    expect(report.ok).toBe(true);
    expect(requestedUrl).toBe("https://cloud.olakrutrim.com/v1/chat/completions");
    expect(requestedInit?.method).toBe("HEAD");
    expect(requestedInit?.redirect).toBe("manual");
    expect(requestedInit?.headers).toBeUndefined();
  });

  it("accepts an exact-model bridge capability override without inference", async () => {
    const test = await workspace();
    const report = await runDoctor({
      paths: test.paths,
      provider: supportedProvider,
      harness: test.harness,
      secrets: { read: async () => "present-but-never-sent" },
      model: "bridge-model",
      capabilityOverride: supportedProvider.capabilities,
      capabilityScopeMessage: "bridge evidence selected",
      fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch,
      codexConfigValidator: async () => ({ status: "pass", message: "test fixture" }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual({
      name: "capability-scope",
      status: "pass",
      message: "bridge evidence selected",
    });
  });

  it.each([404, 500, 503])("fails when the documented route returns HTTP %i", async (status) => {
    const test = await workspace();
    const report = await runDoctor({
      paths: test.paths,
      provider: supportedProvider,
      harness: test.harness,
      secrets: { read: async () => "present-but-never-sent" },
      fetchImpl: (async () => new Response(null, { status })) as typeof fetch,
      codexConfigValidator: async () => ({ status: "pass", message: "test fixture" }),
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "endpoint-reachability", status: "fail" }),
    );
  });

  it("fails when the installed Codex loader rejects configuration", async () => {
    const test = await workspace();
    const report = await runDoctor({
      paths: test.paths,
      provider: supportedProvider,
      harness: test.harness,
      secrets: { read: async () => "present-but-never-sent" },
      fetchImpl: (async () => new Response(null, { status: 401 })) as typeof fetch,
      codexConfigValidator: async () => ({
        status: "fail",
        message: "installed Codex rejected the config",
      }),
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual({
      name: "codex-native-loader",
      status: "fail",
      message: "installed Codex rejected the config",
    });
  });

  it.each([
    'model = 123\n',
    'model_provider = 123\n',
    'definitely_unknown_key = true\n',
  ])("rejects schema-invalid Codex config: %s", async (source) => {
    const validation = await validateWithOfficialSchema(Buffer.from(source), true);
    expect(validation.status).toBe("fail");
  });

  it("accepts the contingent managed provider mapping in the official schema", async () => {
    const source = `model = "Krutrim-2"
model_provider = "krutrim"

[model_providers.krutrim]
name = "Krutrim Cloud"
base_url = "https://cloud.olakrutrim.com/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.krutrim.auth]
command = "/absolute/node"
args = ["/absolute/krutrimconnect.js", "_credential", "read"]
timeout_ms = 60000
refresh_interval_ms = 0
`;
    const validation = await validateWithOfficialSchema(Buffer.from(source), true);
    expect(validation).toMatchObject({ status: "pass" });
  });

  it("rebases schema-declared relative paths for the isolated Codex loader", async () => {
    const test = await workspace();
    const source = `model_instructions_file = "../shared/instructions.md"
developer_instructions = "leave-this-relative-looking-value-alone"

[sandbox_workspace_write]
writable_roots = ["../project", "/already-absolute"]

[profiles.local]
model_catalog_json = "models.json"

[model_providers.other]
name = "Other"
base_url = "https://example.invalid/v1"
wire_api = "responses"

[model_providers.other.auth]
command = "token-helper"
cwd = "helpers"

[agents.reviewer]
description = "Reviewer"
config_file = "agents/reviewer.toml"
`;
    const base = path.dirname(test.paths.codexConfig);
    const rebased = parseCodexToml(await rebaseCodexConfigPaths(source, test.paths.codexConfig));

    expect(rebased).toMatchObject({
      model_instructions_file: path.resolve(base, "../shared/instructions.md"),
      developer_instructions: "leave-this-relative-looking-value-alone",
      sandbox_workspace_write: {
        writable_roots: [path.resolve(base, "../project"), "/already-absolute"],
      },
      profiles: { local: { model_catalog_json: path.resolve(base, "models.json") } },
      model_providers: { other: { auth: { cwd: path.resolve(base, "helpers") } } },
      agents: { reviewer: { config_file: path.resolve(base, "agents/reviewer.toml") } },
    });
  });

  it("requires the exact non-TTY sentinel for strict Codex runtime success", () => {
    expect(
      reachedStrictCodexTerminalGate({
        code: 1,
        signal: null,
        stdout: "",
        stderr: "Error: stdin is not a terminal\n",
      }),
    ).toBe(true);

    for (const result of [
      { code: 0, signal: null, stdout: "", stderr: "" },
      { code: 0, signal: null, stdout: "", stderr: "Error: stdin is not a terminal\n" },
      {
        code: 1,
        signal: null,
        stdout: "session started\n",
        stderr: "Error: stdin is not a terminal\n",
      },
      { code: null, signal: "SIGTERM" as const, stdout: "", stderr: "Error: stdin is not a terminal\n" },
    ]) {
      expect(reachedStrictCodexTerminalGate(result)).toBe(false);
    }
  });
});
