import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflows = new URL("../../.github/workflows/", import.meta.url);
const readWorkflow = (name: string) => readFileSync(new URL(name, workflows), "utf8");

describe("public branch workflow policy", () => {
  it("runs CI on hosted runners only for the public repository with read-only, non-persisted credentials", () => {
    const source = readWorkflow("ci.yml");
    expect(source).toMatch(/^    runs-on: ubuntu-22\.04$/mu);
    const guard = source.match(/^    if: >-\n((?:      .+\n)+)/mu)?.[1]?.trim().replace(/\s+/gu, " ");
    expect(guard).toBe("github.repository == 'ola-krutrim/krutrimconnect' && github.event.repository.private == false");
    expect(source).toMatch(/^    timeout-minutes: 30$/mu);
    expect(source).toMatch(/^permissions:\n  contents: read\n/mu);
    expect(source).not.toMatch(/:\s*write\b|write-all|secrets\.|pull_request_target/u);
    expect(source.match(/^\s*permissions:/gmu)).toHaveLength(1);
    expect(source).toMatch(/uses: actions\/checkout@v4\n        with:\n          persist-credentials: false\n/u);
    expect(source).toContain("NPM_CONFIG_USERCONFIG=");
    expect(source).toContain("NPM_CONFIG_GLOBALCONFIG=");
    expect(source).toContain('node-version: ["20.17.0", "22.x"]');
    expect(source).toContain("node-version: ${{ matrix.node-version }}");
    expect(source).toContain('  push:\n    paths-ignore:\n      - "catalog/**"');
    expect(source).toMatch(/^  pull_request:/mu);
    expect(source).toContain("  workflow_dispatch: {}");
    for (const command of ["npm ci", "npm run check", "npm run check:installer", "npm test", "npm run build", "npm run verify:package"]) {
      expect(source).toContain(`- run: ${command}`);
    }
  });

  it("restricts hosted catalogue writes to trusted scheduled or manual main runs", () => {
    const source = readWorkflow("refresh-catalog.yml");
    expect(source).toMatch(/^    runs-on: ubuntu-22\.04$/mu);
    expect(source).toMatch(/^permissions:\n  contents: read\n\njobs:/mu);
    expect(source).toMatch(/^    permissions:\n      contents: write\n/mu);
    expect(source.match(/:\s*write\b/gu)).toHaveLength(1);
    expect(source).not.toMatch(/write-all|pull_request|workflow_run/u);
    const triggers = source.split("\npermissions:")[0]!.match(/^  [a-z_]+:/gmu);
    expect(triggers).toEqual(["  schedule:", "  workflow_dispatch:"]);
    expect(source).toContain('cron: "30 3 * * *"');
    const guard = source.match(/^    if: >-\n((?:      .+\n)+)/mu)?.[1]?.trim().replace(/\s+/gu, " ");
    expect(guard).toBe("github.repository == 'ola-krutrim/krutrimconnect' && github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')");
    expect(source).toMatch(/uses: actions\/checkout@v4\n        with:\n          ref: main\n          persist-credentials: false\n/u);
    const [setup, refreshAndCommit] = source.split("      - name: Refresh catalogue from live endpoints\n");
    const [refresh, commit] = refreshAndCommit!.split("      - name: Commit when the catalogue changed\n");
    expect(setup).not.toMatch(/secrets\.|github\.token/u);
    expect(refresh).toContain("KRUTRIM_API_KEY: ${{ secrets.KRUTRIM_CATALOG_API_KEY }}");
    expect(refresh).toContain("run: node scripts/refresh-catalog.mjs");
    expect(commit).not.toContain("KRUTRIM_CATALOG_API_KEY");
    expect(commit).toContain("        env:\n          GH_TOKEN: ${{ github.token }}");
    expect(commit).toContain("git diff --quiet -- catalog/krutrim-live.json");
    expect(commit).toContain("git add catalog/krutrim-live.json");
    expect(commit).not.toMatch(/git add (?:\.|-A|--all)|--force|git config.*(?:token|extraheader|credential)/u);
    expect(commit).toContain("git -c credential.helper= \\\n            -c 'credential.helper=!f() { printf \"%s\\n\" \"username=x-access-token\" \"password=$GH_TOKEN\"; }; f' \\\n            push origin HEAD:refs/heads/main");
  });

  it("authenticates catalogue pushes without storing the token or invoking user credential helpers", () => {
    const source = readWorkflow("refresh-catalog.yml");
    const push = source.match(/^          git -c credential\.helper=[\s\S]+$/mu)?.[0];
    expect(push).toBeDefined();
    const directory = mkdtempSync(join(tmpdir(), "public-workflow-policy-"));
    try {
      const env = {
        PATH: process.env.PATH,
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GH_TOKEN: "workflow-test-token",
      };
      execFileSync("bash", ["--noprofile", "--norc", "-n"], { input: push, env, cwd: directory });
      // Exercise Git's real helper protocol offline with a synthetic token; never push.
      const result = execFileSync("bash", ["--noprofile", "--norc", "-euc", push!.replace("push origin HEAD:refs/heads/main", "credential fill")], {
        input: "protocol=https\nhost=github.com\n\n",
        env,
        cwd: directory,
        encoding: "utf8",
      });
      expect(result).toContain("username=x-access-token\n");
      expect(result).toContain("password=workflow-test-token\n");
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps self-hosted runners out of every other workflow", () => {
    const files = readdirSync(workflows).filter((name) => /\.ya?ml$/u.test(name) && name !== "ci.yml");
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const activeSource = readWorkflow(name).replace(/^\s*#.*$/gmu, "");
      expect(activeSource, name).not.toMatch(/self-hosted/iu);
    }
  });

  it("does not expose an internal npm publication workflow", () => {
    expect(existsSync(new URL("internal-package.yml", workflows))).toBe(false);
    expect(existsSync(new URL("internal-package.yaml", workflows))).toBe(false);
  });
});
