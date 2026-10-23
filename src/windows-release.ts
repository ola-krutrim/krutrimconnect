/** Windows release activation uses regular launchers and private ACLs, without symlink privileges. */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRuntimePaths } from "./paths.js";
import type { ReleaseInstallContext } from "./release-install.js";

const repository = "ola-krutrim/krutrimconnect";
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-next\.(0|[1-9]\d*))?$/u;
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
function fail(message: string): never { throw new Error(message); }
function ps(script: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; " + script, "utf16le").toString("base64")], {
    env: { ...process.env, PSModulePath: path.join(path.dirname(powershell), "Modules"), ...env }, encoding: "utf8", timeout: 30_000, windowsHide: true,
  });
}
function noLinks(target: string): void {
  let item = path.resolve(target);
  while (true) {
    if (fs.existsSync(item) && fs.lstatSync(item).isSymbolicLink()) fail("Refusing a linked Windows release path.");
    const parent = path.dirname(item);
    if (item === parent) break;
    item = parent;
  }
}
function safeDirectory(target: string): string {
  if (!path.isAbsolute(target) || path.resolve(target) !== target || target === path.parse(target).root ||
      target.toLowerCase() === os.homedir().toLowerCase() || !/^[A-Za-z]:\\/u.test(target) || /[\r\n"%!]/u.test(target)) {
    fail("Use an absolute local Windows directory without shell expansion characters.");
  }
  noLinks(target);
  return target;
}
const aclCheck = `
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($sid,'S-1-5-18','S-1-5-32-544')
foreach($p in ($env:KC_ACL_PATHS | ConvertFrom-Json)) {
  $attributes=[IO.File]::GetAttributes($p)
  if($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a reparse point in a release tree.' }
  $acl=if($attributes -band [IO.FileAttributes]::Directory) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }
  $owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if($trusted -notcontains $owner) { throw 'Foreign installation owner.' }
  foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value -and
      (([int64]$rule.FileSystemRights -band 852310) -ne 0)) { throw 'Installation is writable by another account.' }
  }
}`;
function privatePaths(paths: string[]): void {
  const unique = [...new Set(paths)];
  for (let index = 0; index < unique.length; index += 40) ps(aclCheck, { KC_ACL_PATHS: JSON.stringify(unique.slice(index, index + 40)) });
}
function privateTrees(roots: string[]): void {
  ps(aclCheck.replace("($env:KC_ACL_PATHS | ConvertFrom-Json)", "@(($env:KC_ACL_PATHS | ConvertFrom-Json) | ForEach-Object { $_; Get-ChildItem -LiteralPath $_ -Recurse -Force | Select-Object -ExpandProperty FullName })"), { KC_ACL_PATHS: JSON.stringify(roots) });
}
function createPrivate(target: string): void {
  safeDirectory(target);
  if (fs.existsSync(target)) { privatePaths([target]); return; }
  fs.mkdirSync(target, { recursive: true });
  ps(`$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    foreach($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
      $identity=[Security.Principal.SecurityIdentifier]::new($id)
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($env:KC_PRIVATE_PATH,$acl)`, { KC_PRIVATE_PATH: target });
  privatePaths([target]);
}
function regular(target: string, directory = false): void {
  noLinks(target);
  const stat = fs.lstatSync(target);
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail("Invalid Windows release file type.");
}
function json(target: string): Record<string, unknown> {
  regular(target);
  if (fs.statSync(target).size > 16 * 1024) fail("Release metadata is too large.");
  const data: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
  if (data === null || typeof data !== "object" || Array.isArray(data)) fail("Invalid Windows release metadata.");
  return data as Record<string, unknown>;
}
function identity(value: Record<string, unknown>): void {
  if (value.schemaVersion !== 1 || value.distribution !== "github-release" || value.repository !== repository) fail("Invalid Windows release identity.");
}
function tree(root: string, expectedVersion?: string): string {
  regular(root, true);
  const meta = json(path.join(root, "release.json")); identity(meta);
  const pkg = json(path.join(root, "package.json"));
  if (typeof meta.version !== "string" || !versionPattern.test(meta.version) ||
      (expectedVersion !== undefined && meta.version !== expectedVersion) || meta.platform !== "win32" || meta.arch !== "x64" ||
      pkg.name !== "krutrimconnect" || pkg.version !== meta.version) fail("Windows release target/version mismatch.");
  for (const dir of ["bin", "dist", "node_modules", "schemas", "catalog"]) regular(path.join(root, dir), true);
  for (const file of ["bin/node.exe", "bin/krutrimconnect.cmd", "dist/cli.js", "dist/windows-release.js", "install.ps1"]) regular(path.join(root, file));
  return meta.version;
}
function launcher(_installDir: string, version: string): string {
  // Keep the batch file ASCII. %~dp0 expands Unicode user-profile paths in CMD;
  // an explicitly validated junction reaches the separate installation root.
  return `@echo off\r\n@setlocal DisableDelayedExpansion\r\n"%~dp0.krutrimconnect\\releases\\${version}\\bin\\node.exe" "%~dp0.krutrimconnect\\releases\\${version}\\dist\\cli.js" %*\r\n`;
}
function managedJunction(binDir: string, installDir: string): void {
  const link = path.join(binDir,".krutrimconnect");
  if (!fs.lstatSync(link).isSymbolicLink() || fs.realpathSync(link) !== fs.realpathSync(installDir)) fail("Refusing an unrelated Windows installation junction.");
}
function atomic(target: string, value: string | Buffer): void {
  const temporary = target + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, value, { flag: "wx" });
  try { fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}
function copyPayload(source: string, destination: string): void {
  fs.mkdirSync(destination,{recursive:true});
  for (const entry of fs.readdirSync(source,{withFileTypes:true})) {
    const from=path.join(source,entry.name), to=path.join(destination,entry.name);
    if(entry.isDirectory()) copyPayload(from,to);
    else if(entry.isFile()) fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
    else fail("Release payload contains a link or special file.");
  }
}
function compare(a: string, b: string): number {
  const left = a.split(/\.|-next\./u).map(Number), right = b.split(/\.|-next\./u).map(Number);
  for (let i = 0; i < 3; i++) { if (left[i] !== right[i]) return left[i]! - right[i]!; }
  if (left.length !== right.length) return left.length === 3 ? 1 : -1;
  return (left[3] ?? 0) - (right[3] ?? 0);
}
export function detectWindowsRelease(packageUrl: URL): ReleaseInstallContext | undefined {
  const packageDir = path.dirname(fileURLToPath(packageUrl));
  const installDir = path.dirname(path.dirname(packageDir));
  if (!fs.existsSync(path.join(packageDir, "release.json"))) {
    if (path.basename(path.dirname(packageDir)) === "releases" || fs.existsSync(path.join(installDir, "install.json"))) fail("Missing Windows release identity.");
    return undefined;
  }
  safeDirectory(installDir); regular(installDir, true);
  const marker = json(path.join(installDir, "install.json")); identity(marker);
  if (typeof marker.installDir !== "string" || fs.realpathSync(marker.installDir) !== fs.realpathSync(installDir) || typeof marker.binDir !== "string" || path.dirname(packageDir) !== path.join(installDir, "releases")) fail("Invalid Windows installation roots.");
  const binDir = safeDirectory(marker.binDir);
  const currentFile = path.join(installDir, "current.json");
  const current = json(currentFile);
  if (typeof current.version !== "string" || !versionPattern.test(current.version)) fail("Invalid current Windows release.");
  const activeDir = path.join(installDir, "releases", current.version);
  tree(activeDir, current.version);
  const version = tree(packageDir, path.basename(packageDir));
  const command = path.join(binDir, "krutrimconnect.cmd"); regular(command);
  managedJunction(binDir,installDir);
  if (fs.readFileSync(command, "utf8") !== launcher(installDir, current.version)) fail("Refusing an unrelated Windows launcher.");
  privatePaths([installDir, binDir, currentFile, command, path.join(installDir, "install.json"), packageDir, activeDir]);
  privateTrees([...new Set([packageDir, activeDir])]);
  return { distribution: "github-release", repository, installDir, binDir, packageDir, version };
}
export function activateWindowsRelease(payload: string, installDir: string, binDir: string, version: string, digest: string): void {
  if (process.platform !== "win32" || !versionPattern.test(version) || !/^[a-f0-9]{64}$/u.test(digest)) fail("Invalid Windows installation request.");
  safeDirectory(installDir); safeDirectory(binDir);
  if (installDir === binDir || installDir.startsWith(binDir + path.sep) || binDir.startsWith(installDir + path.sep)) fail("Installation and launcher directories must be separate.");
  tree(payload, version);
  createPrivate(installDir); createPrivate(binDir);
  if (!fs.readdirSync(installDir).every(name => ["install.json", "current.json", "releases"].includes(name))) fail("Unmanaged Windows installation directory or installation busy.");
  const lock = path.join(installDir, ".install-lock"); fs.mkdirSync(lock);
  const markerFile = path.join(installDir, "install.json"), currentFile = path.join(installDir, "current.json");
  const command = path.join(binDir, "krutrimconnect.cmd");
  let previousMarker: Buffer | undefined, previousCurrent: Buffer | undefined, previousCommand: Buffer | undefined;
  let createdDestination = false, activated = false, createdJunction = false;
  const junction = path.join(binDir,".krutrimconnect");
  const destination = path.join(installDir, "releases", version);
  try {
    if (fs.existsSync(markerFile)) {
      const current = json(currentFile);
      if (typeof current.version !== "string" || !versionPattern.test(current.version)) fail("Invalid current version.");
      const existing = detectWindowsRelease(pathToFileURL(path.join(installDir, "releases", current.version, "package.json")));
      if (existing?.binDir !== binDir) fail("Changed Windows installation roots.");
      if (compare(version, current.version) < 0) fail("Refusing to downgrade KrutrimConnect.");
      previousMarker = fs.readFileSync(markerFile); previousCurrent = fs.readFileSync(currentFile); previousCommand = fs.readFileSync(command);
    } else if (fs.existsSync(currentFile) || fs.existsSync(path.join(installDir, "releases")) || fs.existsSync(command) || fs.existsSync(junction)) fail("Refusing to overwrite unmanaged Windows files.");
    if (fs.existsSync(destination)) {
      tree(destination, version);
      if (fs.readFileSync(path.join(destination, ".archive-sha256"), "utf8") !== digest) fail("Existing release differs; refusing to overwrite immutable files.");
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".staging-"));
      try {
        copyPayload(payload, staging);
        fs.writeFileSync(path.join(staging, ".archive-sha256"), digest);
        fs.renameSync(staging, destination); createdDestination = true;
      } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
    }
    const executable = path.join(destination,"bin/node.exe");
    if (!fs.existsSync(executable)) fail("Missing copied Windows runtime; bin contains: " + fs.readdirSync(path.join(destination,"bin")).join(","));
    try {
      if (execFileSync(executable, [path.join(destination,"dist/cli.js"),"--version"], {encoding:"utf8",cwd:destination}).trim() !== version) fail("Installed Windows CLI version mismatch.");
    } catch (error) {
      throw new Error("Windows runtime verification failed (file exists: " + fs.existsSync(executable) + ", cwd: " + process.cwd() + "): " + String(error));
    }
    if (!fs.existsSync(junction)) { fs.symlinkSync(installDir,junction,"junction"); createdJunction=true; }
    managedJunction(binDir,installDir);
    activated = true;
    atomic(markerFile, JSON.stringify({ schemaVersion: 1, distribution: "github-release", repository, installDir, binDir }) + "\n");
    atomic(currentFile, JSON.stringify({ version }) + "\n"); atomic(command, launcher(installDir, version));
    detectWindowsRelease(pathToFileURL(path.join(destination, "package.json")));
  } catch (error) {
    if (createdJunction) fs.rmdirSync(junction);
    if (activated) for (const [file, previous] of [[markerFile, previousMarker], [currentFile, previousCurrent], [command, previousCommand]] as const) {
      if (previous === undefined) fs.rmSync(file, { force: true }); else atomic(file, previous);
    }
    if (createdDestination) {
      fs.rmSync(destination, { recursive: true, force: true });
      const releases = path.dirname(destination);
      if (previousMarker === undefined && fs.readdirSync(releases).length === 0) fs.rmdirSync(releases);
    }
    throw error;
  } finally { fs.rmdirSync(lock); }
  console.log(`Installed KrutrimConnect v${version}. Add ${binDir} to your user PATH and open a new terminal.`);
}
export function upgradeWindowsRelease(context: ReleaseInstallContext, version: string): void {
  if (!versionPattern.test(version)) fail("Invalid upgrade version.");
  const current = detectWindowsRelease(pathToFileURL(path.join(context.packageDir, "package.json")));
  if (current === undefined || JSON.stringify(current) !== JSON.stringify(context)) fail("Invalid Windows release context.");
  const active = json(path.join(context.installDir, "current.json"));
  if (typeof active.version !== "string" || compare(version, active.version) < 0) fail("Refusing to downgrade KrutrimConnect.");
  execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(context.packageDir, "install.ps1")], {
    env: { ...process.env, KRUTRIM_CONNECT_VERSION: version, KRUTRIM_CONNECT_INSTALL_DIR: context.installDir, KRUTRIM_CONNECT_BIN_DIR: context.binDir },
    stdio: "pipe", timeout: 300_000, windowsHide: true,
  });
  const installed = detectWindowsRelease(pathToFileURL(path.join(context.installDir, "releases", version, "package.json")));
  if (installed?.version !== version) fail("Windows upgrade verification failed.");
}
export async function removeWindowsRelease(context: ReleaseInstallContext): Promise<void> {
  const validated = detectWindowsRelease(pathToFileURL(path.join(context.packageDir, "package.json")));
  if (validated === undefined || JSON.stringify(validated) !== JSON.stringify(context)) fail("Invalid Windows release context.");
  const releases = path.join(context.installDir, "releases");
  const trees = fs.readdirSync(releases).map(name => {
    if (!versionPattern.test(name)) fail("Unmanaged Windows release directory.");
    const root = path.join(releases, name); tree(root, name); return root;
  });
  privateTrees(trees);
  const lock = path.join(context.installDir, ".install-lock"); fs.mkdirSync(lock);
  // Windows locks node.exe while this CLI is running. A separate system PowerShell
  // process waits for this PID before deleting only the prevalidated release trees.
  const plan = { pid: process.pid, trees, installDir: context.installDir, binDir: context.binDir };
  const encodedPlan = Buffer.from(JSON.stringify(plan)).toString("base64");
  const cleanup = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPlan}')) | ConvertFrom-Json
    $status=Join-Path $p.installDir '.install-lock/status.txt'
    try {
      [IO.File]::WriteAllText($status,'Waiting for CLI process to exit.')
      Wait-Process -Id $p.pid -ErrorAction SilentlyContinue
      [IO.File]::WriteAllText($status,'Removing release executables.')
      $deadline=[DateTime]::UtcNow.AddSeconds(30)
      while($true) {
        try {
          foreach($tree in $p.trees) { if(Test-Path -LiteralPath $tree) { Remove-Item -LiteralPath $tree -Recurse -Force } }
          break
        } catch { if([DateTime]::UtcNow -ge $deadline) { throw }; Start-Sleep -Milliseconds 250 }
      }
      Remove-Item -LiteralPath (Join-Path $p.installDir 'releases')
      Remove-Item -LiteralPath (Join-Path $p.installDir 'install.json')
      Remove-Item -LiteralPath (Join-Path $p.installDir 'current.json')
      Remove-Item -LiteralPath (Join-Path $p.installDir '.install-lock') -Recurse -Force
      if(-not (Get-ChildItem -LiteralPath $p.installDir -Force)) { Remove-Item -LiteralPath $p.installDir }
    } catch { [IO.File]::WriteAllText($status,($_ | Out-String)); exit 1 }`;
  const appHome = resolveRuntimePaths().appHome;
  fs.mkdirSync(appHome, {recursive:true});
  const logFile = path.join(appHome, "windows-uninstall-" + process.pid + "-" + randomUUID() + ".log");
  const errorFile = logFile + ".err";
  fs.closeSync(fs.openSync(logFile,"wx",0o600));
  fs.closeSync(fs.openSync(errorFile,"wx",0o600));
  // Start-Process creates an independent Windows process with normal console
  // initialization and an independent lifetime after the CLI process exits.
  const pidFile = path.join(lock,"worker.pid");
  const launch = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
    $worker=Start-Process -FilePath $env:KC_CLEANUP_SHELL -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$env:KC_CLEANUP_BODY) -WindowStyle Hidden -WorkingDirectory $env:KC_CLEANUP_WORKDIR -RedirectStandardOutput $env:KC_CLEANUP_LOG -RedirectStandardError $env:KC_CLEANUP_ERROR -PassThru
    [IO.File]::WriteAllText($env:KC_CLEANUP_PID,[string]$worker.Id)`;
  let workerPid: number | undefined;
  try {
    // Do not capture this launcher's pipes: Windows can inherit them into the
    // waiting worker, preventing EOF until the very CLI we're removing exits.
    execFileSync(powershell,["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(launch,"utf16le").toString("base64")], {
      env: {...process.env, PSModulePath:path.join(path.dirname(powershell),"Modules"),
        KC_CLEANUP_SHELL:powershell, KC_CLEANUP_BODY:Buffer.from(cleanup,"utf16le").toString("base64"),
        KC_CLEANUP_WORKDIR:os.tmpdir(), KC_CLEANUP_LOG:logFile, KC_CLEANUP_ERROR:errorFile, KC_CLEANUP_PID:pidFile},
      stdio:"ignore", windowsHide:true, timeout:30_000,
    });
    workerPid=Number(fs.readFileSync(pidFile,"utf8").trim());
    if(!Number.isSafeInteger(workerPid) || workerPid <= 0) fail("Invalid Windows cleanup worker identity.");
    const deadline = Date.now() + 15_000;
    while (!fs.existsSync(path.join(lock,"status.txt"))) {
      let alive = true;
      try { process.kill(workerPid,0); } catch { alive = false; }
      if (!alive || Date.now() >= deadline) {
        throw new Error("Windows cleanup worker did not start: " + fs.readFileSync(errorFile,"utf8").slice(-8192));
      }
      await new Promise(resolve => setTimeout(resolve,50));
    }
  } catch (error) {
    if(workerPid !== undefined && Number.isSafeInteger(workerPid) && workerPid > 0) try {process.kill(workerPid);} catch {}
    fs.rmSync(lock,{recursive:true,force:true}); throw error;
  }
  fs.unlinkSync(path.join(context.binDir, "krutrimconnect.cmd"));
  managedJunction(context.binDir,context.installDir);
  fs.rmdirSync(path.join(context.binDir,".krutrimconnect"));
  console.log("Windows package cleanup will finish after this command exits. Close older KrutrimConnect sessions before uninstalling.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "install") {
  const [, , , payload, installDir, binDir, version, digest] = process.argv;
  if (!payload || !installDir || !binDir || !version || !digest) fail("Missing Windows installation arguments.");
  activateWindowsRelease(payload!, installDir!, binDir!, version!, digest!);
}
