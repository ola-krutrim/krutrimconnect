import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, realpathSync, linkSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const builderPath = new URL("../../scripts/build-release.mjs", import.meta.url).href;
const roots: string[] = [];
function temporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "release-artifact-test-"));
  roots.push(root);
  return root;
}
function fixture() {
  const root = temporaryRoot();
  for (const dir of ["dist", "schemas", "catalog", "licenses", "docs/legal"]) mkdirSync(path.join(root, dir), { recursive: true });
  const manifest = {
    name: "krutrimconnect", version: "1.2.3", type: "module",
    scripts: { prepack: "exit 99", install: "exit 98" }, dependencies: {}, devDependencies: {},
  };
  const lock = {
    name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { "": { ...manifest, hasInstallScript: true } },
  };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  writeFileSync(path.join(root, "dist/cli.js"), "console.log('1.2.3');\n");
  for (const file of ["schemas/config.json", "catalog/models.json", "LICENSE", "NOTICE", "licenses/MIT-legacy.txt", "docs/legal/PRIVACY_POLICY.md", "docs/legal/TERMS_AND_CONDITIONS.md", "docs/legal/LICENSE_SCOPE.md", "docs/legal/RELEASE_REVIEW.md", "README.md", "SECURITY.md", "install.sh"]) {
    writeFileSync(path.join(root, file), `fixture ${file}\n`);
  }
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["add", "package.json", "package-lock.json", "schemas", "catalog", "LICENSE", "NOTICE", "licenses/MIT-legacy.txt", "docs/legal/PRIVACY_POLICY.md", "docs/legal/TERMS_AND_CONDITIONS.md", "docs/legal/LICENSE_SCOPE.md", "docs/legal/RELEASE_REVIEW.md", "README.md", "SECURITY.md", "install.sh"], { cwd: root });
  return root;
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.runIf(process.platform === "darwin" || process.platform === "linux")("release artifact builder", () => {
  it("rejects runtimes linked to non-system libraries before copying them", async () => {
    const { assertPortableRuntime, stageRuntime } = await import(builderPath);
    const mac = (libraries: string) => ({ platform: "darwin", inspect: () => `/runtime/node:\n${libraries}\n` });
    expect(() => assertPortableRuntime(mac("\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)"))).not.toThrow();
    for (const library of ["@rpath/libnode.147.dylib", "/opt/homebrew/lib/libicuuc.dylib", "/tmp/extra.dylib"]) {
      expect(() => assertPortableRuntime(mac(`\t${library} (compatibility version 1.0.0)`))).toThrow(/standalone|non-system/iu);
    }
    const linux = (libraries: string) => ({ platform: "linux", inspect: () => libraries });
    expect(() => assertPortableRuntime(linux(
      "linux-vdso.so.1 (0x123)\nlibstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0x123)\nlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x123)\n/lib64/ld-linux-x86-64.so.2 (0x123)\n",
    ))).not.toThrow();
    for (const line of ["libnode.so.127 => /usr/lib/libnode.so.127 (0x123)", "libstdc++.so.6 => /opt/custom/libstdc++.so.6 (0x123)", "libc.so.6 => not found", ""]) {
      expect(() => assertPortableRuntime(linux(line))).toThrow(/standalone|non-system/iu);
    }
    const stage = temporaryRoot();
    expect(() => stageRuntime(stage, "fixture license", () => { throw new Error("non-system runtime"); })).toThrow("non-system runtime");
    expect(existsSync(path.join(stage, "bin/node"))).toBe(false);
  });

  it("accepts only an absolute output override and rejects cross-build CLI arguments before building", async () => {
    const { parseBuildArguments } = await import(builderPath);
    const root = temporaryRoot();
    expect(parseBuildArguments([], root)).toEqual({ repositoryRoot: root, output: path.join(root, "release") });
    const output = path.join(root, "release output");
    expect(parseBuildArguments(["--output", output], root)).toEqual({ repositoryRoot: root, output });
    for (const args of [["--output"], ["--output", "relative"], ["--arch", "x64"], ["--platform", "linux"], ["--output", output, "--output", output]]) {
      expect(() => parseBuildArguments(args, root)).toThrow(/usage|absolute/iu);
    }
    const result = spawnSync(process.execPath, [new URL(builderPath).pathname, "--platform", "linux"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage/iu);
    expect(result.stdout).toBe("");
  });

  it("orchestrates a complete artifact and verifies the normalized staging tree before packing", async () => {
    const { buildRelease } = await import(builderPath);
    const root = fixture();
    const output = path.join(temporaryRoot(), "artifacts");
    const calls: string[] = [];
    let stagingDirectory = "";
    const operations = {
      loadLicense: () => { calls.push("license"); return "fixture license"; },
      install: (stage: string) => {
        stagingDirectory = stage;
        calls.push("install");
        mkdirSync(path.join(stage, "node_modules/.bin"), { recursive: true });
        writeFileSync(path.join(stage, "node_modules/fixture.js"), "fixture production dependency");
      },
      runtime: (stage: string, license: string) => {
        calls.push("runtime");
        expect(license).toBe("fixture license");
        mkdirSync(path.join(stage, "bin"));
        writeFileSync(path.join(stage, "bin/node"), "fixture runtime");
        writeFileSync(path.join(stage, "bin/krutrimconnect"), "fixture launcher");
        writeFileSync(path.join(stage, "THIRD_PARTY_NOTICES"), license);
      },
      verify: (stage: string) => {
        calls.push("smoke");
        expect(stage).not.toBe(stagingDirectory);
        expect(existsSync(path.join(stage, "node_modules/.bin"))).toBe(false);
        expect(existsSync(path.join(stage, "package-lock.json"))).toBe(false);
        for (const file of ["LICENSE", "NOTICE", "licenses/MIT-legacy.txt", "docs/legal/PRIVACY_POLICY.md", "docs/legal/TERMS_AND_CONDITIONS.md", "docs/legal/LICENSE_SCOPE.md", "docs/legal/RELEASE_REVIEW.md"]) {
          expect(existsSync(path.join(stage, file)), file).toBe(true);
        }
        expect(JSON.parse(readFileSync(path.join(stage, "release.json"), "utf8"))).toMatchObject({
          schemaVersion: 1, version: "1.2.3", platform: process.platform, arch: process.arch,
          distribution: "github-release", repository: "ola-krutrim/krutrimconnect", nodeVersion: process.versions.node,
        });
      },
    };
    const result = buildRelease({ repositoryRoot: root, output }, operations);
    expect(calls).toEqual(["license", "install", "runtime", "smoke"]);
    expect(existsSync(result.archive)).toBe(true);
    expect(existsSync(path.dirname(stagingDirectory))).toBe(false);
    const failedOutput = path.join(temporaryRoot(), "failed");
    expect(() => buildRelease({ repositoryRoot: root, output: failedOutput }, {
      ...operations, verify: () => { throw new Error("smoke refused"); },
    })).toThrow("smoke refused");
    expect(existsSync(failedOutput)).toBe(false);
    expect(existsSync(path.dirname(stagingDirectory))).toBe(false);
  });

  it("smokes version, offline models, and native imports with no inherited credentials", async () => {
    const { smokeRelease } = await import(builderPath);
    const root = temporaryRoot();
    const stage = path.join(root, "stage");
    mkdirSync(path.join(stage, "bin"), { recursive: true });
    symlinkSync(process.execPath, path.join(stage, "bin/node"));
    writeFileSync(path.join(stage, "bin/krutrimconnect"), `#!/bin/sh\nexec '${process.execPath}' '${stage}/fixture.cjs' "$@"\n`, { mode: 0o755 });
    writeFileSync(path.join(stage, "fixture.cjs"),
      `require('node:fs').appendFileSync('${stage}/calls.jsonl', JSON.stringify({args:process.argv.slice(2),env:process.env})+'\\n');\n` +
      "console.log(process.argv[2] === '--version' ? '1.2.3' : 'MODEL gpt-oss-20b');\n");
    for (const name of ["@napi-rs/keyring", "fs-native-extensions"]) {
      const dir = path.join(stage, "node_modules", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }));
      writeFileSync(path.join(dir, "index.js"), `import {appendFileSync} from 'node:fs'; appendFileSync('${stage}/imports.txt', '${name}\\n');\n`);
    }
    smokeRelease(stage, root, { metadata: { version: "1.2.3" } });
    const calls = readFileSync(path.join(stage, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.map((call) => call.args)).toEqual([["--version"], ["models", "list", "--offline"]]);
    expect(calls[0].env.KRUTRIM_API_KEY).toBeUndefined();
    expect(calls[0].env.NODE_OPTIONS).toBeUndefined();
    expect(calls[0].env.PATH).toBe("/usr/bin:/bin");
    expect(readFileSync(path.join(stage, "imports.txt"), "utf8")).toBe("@napi-rs/keyring\nfs-native-extensions\n");
    expect(() => smokeRelease(stage, root, { metadata: { version: "9.9.9" } })).toThrow(/version/iu);
    writeFileSync(path.join(stage, "node_modules/fs-native-extensions/index.js"), "throw new Error('native ABI mismatch');\n");
    expect(() => smokeRelease(stage, root, { metadata: { version: "1.2.3" } })).toThrow(/native ABI mismatch/iu);
  });

  it("packs a flat checksummed archive of regular files, resolving only internal dependency links", async () => {
    const { packRelease } = await import(builderPath);
    const root = temporaryRoot();
    const stage = path.join(root, "stage");
    mkdirSync(path.join(stage, "node_modules/example"), { recursive: true });
    mkdirSync(path.join(stage, "node_modules/.bin"));
    writeFileSync(path.join(stage, "node_modules/example/index.js"), "export default 1;\n");
    symlinkSync("index.js", path.join(stage, "node_modules/example/linked.js"));
    linkSync(path.join(stage, "node_modules/example/index.js"), path.join(stage, "node_modules/example/hard.js"));
    symlinkSync("../example/index.js", path.join(stage, "node_modules/.bin/example"));
    const identity = { filename: "krutrimconnect-1.2.3-darwin-arm64.tar.gz" };
    const output = path.join(root, "output");
    const result = packRelease(stage, output, identity);
    const expectedHash = createHash("sha256").update(readFileSync(result.archive)).digest("hex");
    expect(readFileSync(result.checksum, "utf8")).toBe(`${expectedHash}  ${identity.filename}\n`);
    const listing = execFileSync("tar", ["-tvzf", result.archive], { encoding: "utf8" }).trim().split("\n");
    expect(listing.every((line) => ["d", "-"].includes(line[0] ?? ""))).toBe(true);
    expect(listing.join("\n")).not.toContain(".bin");
    const extracted = path.join(root, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", result.archive, "-C", extracted]);
    expect(readFileSync(path.join(extracted, "node_modules/example/linked.js"), "utf8")).toBe("export default 1;\n");
    expect(statSync(path.join(extracted, "node_modules/example/hard.js")).nlink).toBe(1);
    expect(() => packRelease(stage, output, identity)).toThrow(/overwrite/iu);
    symlinkSync(path.join(root, "outside-secret"), path.join(stage, "node_modules/example/escape"));
    writeFileSync(path.join(root, "outside-secret"), "do not copy");
    expect(() => packRelease(stage, path.join(root, "other-output"), identity)).toThrow(/outside/iu);
    expect(() => packRelease(stage, "relative", identity)).toThrow(/absolute/iu);
  });

  it("runs production dependency install scripts in isolated npm ci without development packages", async () => {
    const { prepareRelease, installProduction } = await import(builderPath);
    const root = fixture();
    const workspace = temporaryRoot();
    const dependency = path.join(workspace, "package");
    mkdirSync(dependency);
    writeFileSync(path.join(dependency, "package.json"), JSON.stringify({
      name: "fixture-native", version: "1.0.0",
      scripts: { install: "node install.cjs" },
    }));
    writeFileSync(path.join(dependency, "install.cjs"),
      "require('node:fs').writeFileSync('installed.json', JSON.stringify({node:process.versions.node,home:process.env.HOME,key:process.env.KRUTRIM_API_KEY}));\n");
    const tarball = path.join(workspace, "fixture.tgz");
    execFileSync("tar", ["-czf", tarball, "-C", workspace, "package"]);
    const resolved = `file:${tarball}`;
    const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    manifest.dependencies = { "fixture-native": resolved };
    manifest.devDependencies = { "fixture-dev": resolved };
    writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
    writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({
      name: manifest.name, version: manifest.version, lockfileVersion: 3,
      packages: {
        "": { ...manifest, hasInstallScript: true },
        "node_modules/fixture-native": { version: "1.0.0", resolved, integrity, hasInstallScript: true },
        "node_modules/fixture-dev": { version: "1.0.0", resolved, integrity, dev: true },
      },
    }));
    writeFileSync(path.join(root, ".npmrc"), "ignore-scripts=true\n");
    const stage = path.join(workspace, "stage");
    prepareRelease(root, stage);
    installProduction(stage, workspace);
    const installed = JSON.parse(readFileSync(path.join(stage, "node_modules/fixture-native/installed.json"), "utf8"));
    expect(installed.node).toBe(process.versions.node);
    expect(realpathSync(installed.home)).toBe(realpathSync(path.join(workspace, "home")));
    expect(installed.key).toBeUndefined();
    expect(existsSync(path.join(stage, "node_modules/fixture-dev"))).toBe(false);
    expect(existsSync(path.join(stage, ".npmrc"))).toBe(false);
  }, 30_000);

  it("requires the exact upstream runtime license over verified HTTPS", async () => {
    const { loadNodeLicense } = await import(builderPath);
    const license = "Node.js is licensed for use as follows:\nCopyright Node.js contributors\nPermission is hereby granted, free of charge\n";
    let invocation: string[] = [];
    expect(loadNodeLicense((command: string, args: string[]) => {
      invocation = [command, ...args];
      return license;
    })).toBe(license);
    expect(invocation[0]).toBe("curl");
    expect(invocation).toContain(`https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`);
    expect(invocation).toContain("--disable");
    expect(invocation).toContain("=https");
    expect(invocation).not.toContain("--insecure");
    expect(() => loadNodeLicense(() => "<html>access denied</html>")).toThrow(/license/iu);
    expect(() => loadNodeLicense(() => { throw new Error("TLS unavailable"); })).toThrow(/license.*TLS/iu);
  });

  it("fails closed on mismatched, missing, or linked distribution inputs", async () => {
    const { prepareRelease } = await import(builderPath);
    const cases: Array<{ mutate: (root: string) => void; error: RegExp }> = [
      { mutate: (root) => {
        const file = path.join(root, "package-lock.json");
        const lock = JSON.parse(readFileSync(file, "utf8"));
        lock.packages[""].version = "9.9.9";
        writeFileSync(file, JSON.stringify(lock));
      }, error: /lock/iu },
      { mutate: (root) => rmSync(path.join(root, "dist/cli.js")), error: /dist.*build/iu },
      { mutate: (root) => execFileSync("git", ["rm", "--cached", "README.md"], { cwd: root }), error: /tracked.*README/iu },
      { mutate: (root) => {
        const secret = path.join(temporaryRoot(), "secret");
        writeFileSync(secret, "not a distribution input");
        rmSync(path.join(root, "README.md"));
        symlinkSync(secret, path.join(root, "README.md"));
      }, error: /symbolic|symlink/iu },
      { mutate: (root) => {
        const nested = path.join(root, "schemas/nested");
        mkdirSync(nested);
        writeFileSync(path.join(nested, "config.json"), "{}");
        execFileSync("git", ["add", "schemas/nested/config.json"], { cwd: root });
        const outside = temporaryRoot();
        writeFileSync(path.join(outside, "config.json"), "must not read");
        rmSync(nested, { recursive: true });
        symlinkSync(outside, nested);
      }, error: /symbolic|symlink/iu },
      { mutate: (root) => symlinkSync(root, path.join(root, "dist/loop")), error: /symbolic|symlink/iu },
    ];
    for (const { mutate, error } of cases) {
      const root = fixture();
      mutate(root);
      expect(() => prepareRelease(root, path.join(temporaryRoot(), "stage"))).toThrow(error);
    }
  });

  it("launches the copied Node runtime through relative installer symlink chains", async () => {
    const { stageRuntime } = await import(builderPath);
    const root = temporaryRoot();
    const stage = path.join(root, "releases/1.2.3");
    mkdirSync(path.join(stage, "dist"), { recursive: true });
    writeFileSync(path.join(stage, "dist/cli.js"), "console.log(JSON.stringify({execPath:process.execPath,args:process.argv.slice(2)}));\n");
    stageRuntime(stage, "Node.js is licensed for use as follows:\nCopyright Node.js contributors\nPermission is hereby granted, free of charge\n", () => {});
    symlinkSync("releases/1.2.3", path.join(root, "current"));
    mkdirSync(path.join(root, "user bin"));
    const command = path.join(root, "user bin/krutrimconnect");
    symlinkSync("../current/bin/krutrimconnect", command);
    const bundledNode = path.join(stage, "bin/node");
    expect(readFileSync(bundledNode).equals(readFileSync(process.execPath))).toBe(true);
    // Exercise shell resolution independently of a developer's shared-library Node build.
    writeFileSync(bundledNode, '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n');
    const result = execFileSync(command, ["with spaces", "--version"], {
      cwd: os.tmpdir(), encoding: "utf8", env: { PATH: "/usr/bin:/bin" },
    }).trim().split("\n");
    expect(result).toEqual([
      realpathSync(bundledNode), `${realpathSync(stage)}/bin/../dist/cli.js`, "with spaces", "--version",
    ]);
    expect(readFileSync(path.join(stage, "licenses/Node-LICENSE"), "utf8")).toContain("Node.js contributors");
    expect(readFileSync(path.join(stage, "THIRD_PARTY_NOTICES"), "utf8")).toContain(process.versions.node);
    expect(existsSync(path.join(stage, "bin/npm"))).toBe(false);
  });

  it("stages only distribution inputs with a matching scripts-free npm manifest", async () => {
    const { prepareRelease } = await import(builderPath);
    const root = fixture();
    const stage = path.join(temporaryRoot(), "stage");
    writeFileSync(path.join(root, "catalog/internal-notes.md"), "must not ship");
    writeFileSync(path.join(root, "dist/internal-notes.md"), "must not read or ship");
    writeFileSync(path.join(root, "dist/.env"), "SECRET=must-not-read");
    writeFileSync(path.join(root, ".env"), "SECRET=must-not-read");
    const identity = prepareRelease(root, stage);
    expect(identity.filename).toMatch(/^krutrimconnect-1\.2\.3-(darwin|linux)-(arm64|x64)\.tar\.gz$/u);
    expect(JSON.parse(readFileSync(path.join(stage, "package.json"), "utf8")).scripts).toBeUndefined();
    expect(JSON.parse(readFileSync(path.join(stage, "package-lock.json"), "utf8")).packages[""].hasInstallScript).toBeUndefined();
    expect(readFileSync(path.join(stage, "dist/cli.js"), "utf8")).toContain("1.2.3");
    expect(readFileSync(path.join(stage, "README.md"), "utf8")).toBe("fixture README.md\n");
    expect(existsSync(path.join(stage, "catalog/internal-notes.md"))).toBe(false);
    expect(existsSync(path.join(stage, "dist/internal-notes.md"))).toBe(false);
    expect(existsSync(path.join(stage, "dist/.env"))).toBe(false);
    expect(existsSync(path.join(stage, ".env"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts.install).toBe("exit 98");
  });
});
