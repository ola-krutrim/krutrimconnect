import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const INSTALL_SCRIPT = fileURLToPath(new URL("../install.sh", import.meta.url));
const CLI_SOURCE = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const INSTALLER_BADGE = fileURLToPath(
  new URL("../assets/installer-badge.png", import.meta.url),
);

interface InstallerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Fixture {
  env: NodeJS.ProcessEnv;
  mockBin: string;
  npmLog: string;
  prefixBin: string;
  cleanup(): Promise<void>;
}

async function executable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents, { mode: 0o755 });
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "krutrimconnect-installer-"));
  const mockBin = path.join(root, "mock-bin");
  const prefix = path.join(root, "npm-prefix");
  const prefixBin = path.join(prefix, "bin");
  const npmLog = path.join(root, "npm.log");
  await mkdir(mockBin, { recursive: true });
  await mkdir(prefixBin, { recursive: true });

  await writeFile(npmLog, "");

  return {
    env: {
      PATH: [mockBin, prefixBin, "/usr/bin", "/bin"].join(":"),
      CI: "1",
      TERM: "dumb",
      NPM_LOG: npmLog,
      FAKE_NPM_PREFIX: prefix,
    },
    mockBin,
    npmLog,
    prefixBin,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function runInstaller(env: NodeJS.ProcessEnv, args: string[] = []): Promise<InstallerResult> {
  return await new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn("/bin/sh", [INSTALL_SCRIPT, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

async function runInstallerInPty(env: NodeJS.ProcessEnv, installerArgs: string[] = ["--preview"]): Promise<InstallerResult> {
  const args = process.platform === "darwin"
    ? ["-q", "/dev/null", "/bin/sh", INSTALL_SCRIPT, ...installerArgs]
    : ["-q", "-e", "-c", ["/bin/sh", INSTALL_SCRIPT, ...installerArgs].map(shellQuote).join(" "), "/dev/null"];
  return await new Promise((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn("/usr/bin/script", args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

describe.runIf(process.platform !== "win32")("install.sh", () => {
  it("is valid POSIX shell syntax", async () => {
    const result = await new Promise<InstallerResult>((resolve, reject) => {
      const stderr: Buffer[] = [];
      const child = spawn("/bin/sh", ["-n", INSTALL_SCRIPT], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({ code, stdout: "", stderr: Buffer.concat(stderr).toString("utf8") });
      });
    });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("previews without Node, npm, or installation prerequisites", async () => {
    const result = await runInstaller({
      PATH: "/nonexistent",
      TERM: "dumb",
      CI: "1",
      KRUTRIM_CONNECT_CHANNEL: "not-an-install-channel",
    }, ["--preview"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Banner preview only; no installation performed.");
    expect(result.stdout).toContain("READY TO BUILD ON INDIA'S AI CLOUD");
    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("Downloading");
    expect(result.stdout).not.toContain("Get started:");
  });

  it.each([
    ["Apple_Terminal", "0"],
    ["Apple_Terminal", "1"],
    ["vscode", "1"],
    ["WarpTerminal", "1"],
  ])("previews the real banner without invoking npm (%s, no animation=%s)", { timeout: 15_000 }, async (terminal, noAnimation) => {
    const fixture = await createFixture();
    try {
      const env = {
        ...fixture.env,
        CI: "",
        TERM: "xterm-256color",
        TERM_PROGRAM: terminal,
        KRUTRIM_CONNECT_NO_ANIMATION: noAnimation,
      };
      const installed = await runInstallerInPty(env);
      expect(installed.code).toBe(0);
      const calls = await readFile(fixture.npmLog, "utf8");
      const preview = await runInstallerInPty({ ...env, FAKE_NODE_CHECK_STATUS: "99" }, ["--preview"]);
      expect(preview.code).toBe(0);
      expect(preview.stderr).toBe("");
      const banner = preview.stdout.replaceAll("\r", "")
        .split("-> Banner preview only; no installation performed.\n")[1];
      expect(banner).toBeDefined();
      expect(banner).toContain("\u001b[0;38;5;15;48;5;35m");
      expect(installed.stdout.replaceAll("\r", "")).toContain(banner);
      expect(await readFile(fixture.npmLog, "utf8")).toBe(calls);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects extra preview arguments without installing", async () => {
    const result = await runInstaller({ PATH: "/nonexistent" }, ["--preview", "unexpected"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("sh install.sh --preview");
  });

  it("embeds the checked-in PNG without changing its bytes", async () => {
    const installer = await readFile(INSTALL_SCRIPT, "utf8");
    const chunks = Array.from(
      installer.matchAll(/^INSTALLER_BADGE_PNG_[1-9]='([^']+)'$/gm),
      (match) => match[1],
    );
    expect(chunks).toHaveLength(4);
    expect(Buffer.from(chunks.join(""), "base64")).toEqual(
      await readFile(INSTALLER_BADGE),
    );
  });

  it("mentions every visible CLI command in the completion screen", async () => {
    const [installer, cliSource] = await Promise.all([
      readFile(INSTALL_SCRIPT, "utf8"),
      readFile(CLI_SOURCE, "utf8"),
    ]);
    const completion = installer.match(/print_completion\(\) \{([\s\S]*?)\n\}/)?.[1];
    expect(completion, "print_completion() not found in install.sh").toBeDefined();

    // Commander groups assigned to variables, e.g. `const models = program.command("models")`.
    const hiddenGroups = new Set<string>();
    const groupPattern =
      /const\s+(\w+)\s*=\s*program\s*\.command\(\s*"([^"]+)"\s*(?:,\s*(\{[^}]*\}))?\s*\)/g;
    const groupVariables = new Set<string>(["program"]);
    for (const [, variable, , options] of cliSource.matchAll(groupPattern)) {
      if (variable === undefined) continue;
      groupVariables.add(variable);
      if (options?.includes("hidden: true")) {
        hiddenGroups.add(variable);
      }
    }

    // Every visible registration, e.g. `models.command("show <model>")`.
    const visibleCommandTokens = new Set<string>();
    const registrationPattern =
      /(\w+)\s*\.command\(\s*"([^"]+)"\s*(?:,\s*(\{[^}]*\}))?\s*\)/g;
    for (const [, receiver, name, options] of cliSource.matchAll(registrationPattern)) {
      if (receiver === undefined || name === undefined) continue;
      if (!groupVariables.has(receiver) || hiddenGroups.has(receiver)) continue;
      if (options?.includes("hidden: true")) continue;
      const token = name.split(" ")[0];
      if (token === undefined || token.startsWith("_")) continue;
      visibleCommandTokens.add(token);
    }

    // Guard against the extraction silently matching nothing.
    expect(visibleCommandTokens).toContain("login");
    expect(visibleCommandTokens).toContain("uninstall");
    expect(visibleCommandTokens.size).toBeGreaterThanOrEqual(15);

    for (const token of visibleCommandTokens) {
      expect(
        completion,
        `CLI command "${token}" is not mentioned in install.sh print_completion(); update the completion screen when adding commands`,
      ).toMatch(new RegExp(`\\b${token}\\b`));
    }
  });

  it("renders every animation frame when stdout is a TTY", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    try {
      const result = await runInstallerInPty({
        ...fixture.env,
        CI: "",
        TERM: "xterm-256color",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("·       ·");
      expect(result.stdout).toContain("·   ·   ·");
      expect(result.stdout).toContain("✦   ✦   ✦");
      expect(result.stdout).not.toContain("कृ");
      expect(result.stdout).toContain("████████████");
      expect(result.stdout).toContain("\u001b[0;38;5;35m");
      expect(result.stdout).toContain("\u001b[0;38;5;35;48;5;35m");
      expect(result.stdout).toContain("\u001b[0;38;5;15;48;5;35m");
      expect(result.stdout).not.toContain("▗▟██████████████▙▖");
      expect(result.stdout).toContain("✓ 01 PACKAGE");
      expect(result.stdout).toContain("✓ 02 CLI");
      expect(result.stdout).toContain("✓ 03 READY");
      expect(result.stdout).toContain("─────────");
      expect(result.stdout).toContain("READY TO BUILD ON INDIA'S AI CLOUD");
      expect(result.stdout).toContain("Installed successfully");
      expect(result.stdout).toContain("Next:");
      expect(result.stdout).toContain("\u001b[7A");
      expect(result.stdout).toContain("\u001b[2K");
      expect(result.stdout).toContain("KrutrimConnect");
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ["vscode", "1"],
    ["vscode", "0"],
    ["Apple_Terminal", "1"],
    ["Apple_Terminal", "0"],
  ])("keeps the logo compact without changing the rail or text (%s, no animation=%s)", { timeout: 15_000 }, async (terminal, noAnimation) => {
    const fixture = await createFixture();
    try {
      const result = await runInstallerInPty({
        ...fixture.env,
        CI: "",
        TERM: "xterm-256color",
        TERM_PROGRAM: terminal,
        KRUTRIM_CONNECT_NO_ANIMATION: noAnimation,
      });
      expect(result.code).toBe(0);
      const output = result.stdout.replaceAll("\r", "");
      const badgeRows = output.split("\n").filter((line) =>
        /\u001b\[(?:0;)?(?:38|48);5;35m/.test(line)
        || line.includes("\u001b[0;38;5;35;48;5;35m"),
      );
      expect(badgeRows).toHaveLength(12);
      for (const row of badgeRows) {
        const plain = row.replace(/\u001b\[[0-9;]*m/g, "");
        // The existing rail spans columns 10..47; center the 24-cell logo over it.
        expect(plain.startsWith(" ".repeat(17))).toBe(true);
        expect(Array.from(plain)).toHaveLength(41);
        expect(plain).not.toMatch(/[▟▙▗▖▐▌▜▛▝▘]/);
        if (terminal !== "Apple_Terminal") {
          expect(plain).toMatch(/[▀▄]/);
        }
      }
      expect(badgeRows.join("\n")).toContain("\u001b[0;38;5;15;48;5;35m");
      expect(output).toContain([
        "          \u001b[38;5;22m───────────\u001b[38;5;41m────────────────\u001b[38;5;22m───────────\u001b[0m",
        "",
        "                      \u001b[1;39mKrutrimConnect\u001b[0m",
        "            \u001b[1;38;5;84mREADY TO BUILD ON INDIA'S AI CLOUD\u001b[0m",
        "",
        "         \u001b[1;38;5;84m✓\u001b[0m \u001b[1;39mInstalled successfully\u001b[0m  \u001b[38;5;29m·  Next:\u001b[0m \u001b[1;38;5;84mlogin\u001b[0m",
      ].join("\n"));
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["0", "1"])("preserves identical artwork with Apple-specific solid fills (no animation=%s)", { timeout: 15_000 }, async (noAnimation) => {
    const fixture = await createFixture();
    try {
      const results = await Promise.all(
        ["Apple_Terminal", "vscode", "WarpTerminal"].map((terminal) =>
          runInstallerInPty({
            ...fixture.env,
            CI: "",
            TERM: "xterm-256color",
            TERM_PROGRAM: terminal,
            KRUTRIM_CONNECT_NO_ANIMATION: noAnimation,
          }),
        ),
      );
      for (const result of results) {
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("\u001b[0;38;5;15;48;5;35m");
      }
      const apple = results[0]!.stdout;
      const vscode = results[1]!.stdout;
      const warp = results[2]!.stdout;
      expect(apple).toContain("\u001b[0;48;5;35m ");
      expect(apple).toContain("\u001b[0;48;5;15m ");
      expect(apple).not.toMatch(/\u001b\[0;38;5;(35|15);48;5;\1m▀/);
      expect(apple).toContain("\u001b[0;7;38;5;35;49m▀");
      expect(apple).toContain("\u001b[0;38;5;35;48;5;256m▀");
      expect(apple).not.toContain("\u001b[0;7;38;5;35;49m▄");
      expect(vscode).not.toContain("48;5;256m");
      expect(warp).not.toContain("48;5;256m");
      // Normalize equivalent Apple cell encodings before comparing output.
      const canonicalApple = apple
        .replace(/\u001b\[0;7;38;5;35;49m(▀+)/g,
          (_, cells: string) => "\u001b[0;38;5;35m" + "▄".repeat(cells.length))
        .replaceAll("\u001b[0;38;5;35;48;5;256m", "\u001b[0;38;5;35m")
        .replace(/\u001b\[0;48;5;(35|15)m( +)/g,
          (_, color: string, cells: string) => `\u001b[0;38;5;${color};48;5;${color}m` + "▀".repeat(cells.length));
      expect(canonicalApple).toBe(vscode);
      expect(warp).toBe(vscode);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the ANSI badge as the default on image-capable terminals", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    try {
      const result = await runInstallerInPty({
        ...fixture.env,
        CI: "",
        TERM: "xterm-256color",
        TERM_PROGRAM: "iTerm.app",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("\u001b]1337;File=");
      expect(result.stdout).toContain("\u001b[0;38;5;35m");
    } finally {
      await fixture.cleanup();
    }
  });

  it("renders the embedded PNG through the iTerm protocol when supported", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    try {
      const result = await runInstallerInPty({
        ...fixture.env,
        CI: "",
        TERM: "xterm-256color",
        TERM_PROGRAM: "iTerm.app",
        KRUTRIM_CONNECT_INLINE_IMAGE: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "\u001b]1337;File=inline=1;width=24;height=12;preserveAspectRatio=1:",
      );
      expect(result.stdout).toContain("iVBORw0KGgo");
      expect(result.stdout).not.toContain("▄████████████████████▄");
      expect(result.stdout).toContain("Installed successfully");
    } finally {
      await fixture.cleanup();
    }
  });

  it("renders the chunked PNG through the Kitty protocol when supported", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    try {
      const result = await runInstallerInPty({
        ...fixture.env,
        CI: "",
        TERM: "xterm-kitty",
        KITTY_WINDOW_ID: "1",
        KRUTRIM_CONNECT_INLINE_IMAGE: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "\u001b_Ga=T,f=100,c=24,r=12,q=2,m=1;",
      );
      expect(result.stdout).toContain("\u001b_Gm=0,q=2;");
      expect(result.stdout).not.toContain("\u001b]1337;File=");
      expect(result.stdout).toContain("Installed successfully");
    } finally {
      await fixture.cleanup();
    }
  });

  it("uses the ANSI fallback inside terminal multiplexers", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    try {
      const result = await runInstallerInPty({
        ...fixture.env,
        CI: "",
        TERM: "xterm-kitty",
        KITTY_WINDOW_ID: "1",
        TMUX: "/tmp/krutrimconnect-test-tmux",
        KRUTRIM_CONNECT_INLINE_IMAGE: "1",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("\u001b_G");
      expect(result.stdout).toContain("\u001b[0;38;5;35m");
    } finally {
      await fixture.cleanup();
    }
  });

  it("supports help without requiring Node.js or npm", async () => {
    const result = await runInstaller({ PATH: "/usr/bin:/bin" }, ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("KRUTRIM_CONNECT_VERSION=1.2.3");
    expect(result.stdout).toContain("KRUTRIM_CONNECT_GITHUB_AUTH=1");
    expect(result.stdout).toContain("KRUTRIM_CONNECT_INLINE_IMAGE=1");
    expect(result.stdout).toContain("Public latest resolves only to a stable release");
    expect(result.stdout).toContain("No system Node.js or npm is required");
  });
});
