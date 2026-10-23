import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packRelease } from './build-release.mjs';
import { releaseIdentity } from './release-artifact-policy.mjs';

assert.equal(process.platform, 'win32');
const repo = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'))).version;
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'krutrimconnect-windows-')));
const installDir = path.join(root, 'user app हिन्दी'), binDir = path.join(root, 'user bin हिन्दी');
const assets = path.join(repo, 'release');
const publicInstall = process.argv.includes('--public');
const hostPath=process.env.PATH ?? process.env.Path ?? '';
const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
  KRUTRIM_CONNECT_HOME: path.join(root, 'state'), KRUTRIM_CONNECT_INSTALL_DIR: installDir,
  KRUTRIM_CONNECT_BIN_DIR: binDir, KRUTRIM_CONNECT_ASSET_DIR: assets, KRUTRIM_CONNECT_VERSION: version,
};
for(const key of Object.keys(env)) if(key.toLowerCase()==='path') delete env[key];
env.PATH=hostPath;
// No credentials or inference. Credential Manager operations use a unique, fake test account below.
const systemRoot=process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
const powershell=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
const ps = (script, extra = {}) => execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
const cli = (v, args) => execFileSync(path.join(installDir, 'releases', v, 'bin/node.exe'), [path.join(installDir, 'releases', v, 'dist/cli.js'), ...args], { env, encoding: 'utf8', timeout: 30_000 });
try {
  let installer = path.join(repo,'install.ps1');
  if(publicInstall) {
    const response=await fetch('https://raw.githubusercontent.com/ola-krutrim/krutrimconnect/main/install.ps1');
    assert.equal(response.ok,true);
    const bytes=Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes,fs.readFileSync(installer));
    installer=path.join(root,'public-install.ps1'); fs.writeFileSync(installer,bytes);
  }
  ps(installer, publicInstall ? {KRUTRIM_CONNECT_ASSET_DIR:'',KRUTRIM_CONNECT_VERSION:'latest',PATH: [path.join(systemRoot,'System32'),systemRoot,path.dirname(powershell)].join(';')} : {});
  assert.equal(cli(version, ['--version']).trim(), version);
  assert.match(cli(version, ['models', 'list', '--offline']), /gpt-oss-20b/);
  if(publicInstall) assert.match(cli(version,['upgrade','--check']),/already up to date/);
  const cmd = spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `""${path.join(binDir, 'krutrimconnect.cmd')}" --version"`], { env, encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(cmd.status, 0, cmd.stderr); assert.equal(cmd.stdout.trim(), version);
  const active = path.join(installDir, 'releases', version);
  const run = (code, extra = {}) => execFileSync(path.join(active, 'bin/node.exe'), ['--input-type=module', '-e', code], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 120_000 });
  const url = name => JSON.stringify(new URL(`file:///${active.replaceAll('\\','/')}/dist/${name}.js`).href);
  run(`
    const {createRequire}=await import('node:module');
    const require=createRequire(${JSON.stringify(path.join(active,'package.json'))});
    require('fs-native-extensions');
    const {AsyncEntry}=require('@napi-rs/keyring');
    const entry=new AsyncEntry('krutrimconnect-ci', ${JSON.stringify('fixture-' + path.basename(root))});
    try { await entry.setPassword('fake-test-value'); if(await entry.getPassword()!=='fake-test-value') throw Error('credential roundtrip'); }
    finally { await entry.deleteCredential(); }
  `);
  const npmTool=path.join(root,'npm tool'); fs.mkdirSync(path.join(npmTool,'node_modules','fixture'),{recursive:true});
  fs.writeFileSync(path.join(npmTool,'node_modules','fixture','tool.js'), '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  fs.writeFileSync(path.join(npmTool,'codex.cmd'), '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\fixture\\tool.js" %*\r\n');
  run(`const {toolInvocation}=await import(${url('tool-invocation')});
    const {execFileSync}=await import('node:child_process');
    const values=['with spaces','a&b','%PATH%','"quoted"'];
    const invoke=toolInvocation(${JSON.stringify(path.join(npmTool,'codex.cmd'))},values);
    const actual=JSON.parse(execFileSync(invoke.command,invoke.args,{encoding:'utf8'}));
    if(JSON.stringify(actual)!==JSON.stringify(values)) throw Error('Windows npm shim argument corruption');`);
  // Build a test-only next version and exercise the real upgrade installer.
  const next = version.replace(/\.(\d+)$/, (_, value) => '.' + (Number(value) + 1));
  const fixture = path.join(root, 'next');
  const copy=(source,target)=>{fs.mkdirSync(target,{recursive:true}); for(const entry of fs.readdirSync(source,{withFileTypes:true})) { const from=path.join(source,entry.name),to=path.join(target,entry.name); if(entry.isDirectory()) copy(from,to); else fs.copyFileSync(from,to); }};
  copy(active,fixture);
  fs.rmSync(path.join(fixture, '.archive-sha256'));
  for (const name of ['package.json','release.json']) {
    const value=JSON.parse(fs.readFileSync(path.join(fixture,name)));
    fs.writeFileSync(path.join(fixture,name), JSON.stringify({...value,version:next}));
  }
  // The test CLI reports the synthetic version through package.json, as the real CLI does.
  const fixtureAssets=path.join(root,'assets');
  packRelease(fixture,fixtureAssets,releaseIdentity(next));
  const preload=path.join(root,'fixture-latest.mjs');
  fs.writeFileSync(preload, `globalThis.fetch=async url=>{if(String(url)!=='https://api.github.com/repos/ola-krutrim/krutrimconnect/releases/latest') throw Error('Unexpected test network'); return new Response(JSON.stringify({tag_name:'v${next}',draft:false,prerelease:false}));};`);
  const upgraded=spawnSync(process.env.ComSpec,['/d','/s','/c',`""${path.join(binDir,'krutrimconnect.cmd')}" upgrade"`],{
    env:{...env,KRUTRIM_CONNECT_ASSET_DIR:fixtureAssets,NODE_OPTIONS:`--import=${JSON.stringify(pathToFileURL(preload).href)}`},
    encoding:'utf8',windowsVerbatimArguments:true,timeout:180000,
  });
  assert.equal(upgraded.status,0,upgraded.stdout+'\n'+upgraded.stderr);
  assert.equal(cli(next,['--version']).trim(),next); assert.equal(cli(version,['--version']).trim(),version);
  assert.equal(JSON.parse(fs.readFileSync(path.join(installDir,'current.json'))).version,next);
  fs.writeFileSync(path.join(binDir,'unrelated.txt'),'keep');
  // Malformed ownership metadata must fail before any files are removed.
  const marker=path.join(installDir,'install.json'), saved=fs.readFileSync(marker);
  fs.writeFileSync(marker,JSON.stringify({schemaVersion:1,distribution:'github-release',repository:'other/repo',installDir,binDir}));
  assert.throws(()=>run(`const api=await import(${url('release-install')}); await api.detectReleaseInstall(new URL(${JSON.stringify(new URL(`file:///${active.replaceAll('\\','/')}/package.json`).href)}));`));
  fs.writeFileSync(marker,saved);
  // Use injected disconnected harness/credential backends to avoid real user state.
  const uninstallCode=`const api=await import(${url('uninstall')});
    const {readInstalledPackageMetadata}=await import(${url('upgrade')});
    const harness={status:async()=>({state:'disconnected'}),disable:async()=>({changed:false,configPath:'fixture'})};
    const result=await api.uninstallKrutrimConnect({metadata:await readInstalledPackageMetadata(),codex:harness,opencode:harness,
      stopBridges:async()=>false,removeCredential:async()=>({changed:false,removedBackends:[],missingBackends:[],removedBackendRecord:false}),removeGlobalPackage:api.removeGlobalPackageWithNpm});
    if(!result.packageRemoved) throw Error('uninstall failed');`;
  await new Promise((resolve,reject)=>{
    const child=spawn(path.join(active,'bin/node.exe'),['--input-type=module','-e',uninstallCode],{env,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',data=>{output+=data;}); child.stderr.on('data',data=>{output+=data;});
    child.once('error',reject); child.once('close',code=>code===0?resolve():reject(Error(output)));
  });
  const deadline=Date.now()+60000;
  while(fs.existsSync(installDir)&&Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,250));
  if(fs.existsSync(installDir)) assert.fail('Windows deferred executable cleanup failed: '+(fs.existsSync(path.join(installDir,'.install-lock/status.txt')) ? fs.readFileSync(path.join(installDir,'.install-lock/status.txt'),'utf8') : fs.readdirSync(installDir).join(',')));
  assert.equal(fs.readFileSync(path.join(binDir,'unrelated.txt'),'utf8'),'keep');
  assert.equal(fs.existsSync(path.join(binDir,'krutrimconnect.cmd')),false);
  console.log('Windows x64 archive: install, CMD launcher, offline CLI, native imports, Credential Manager roundtrip, upgrade, retained runtime, ownership rejection and deferred uninstall passed.');
} finally { fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:200}); }
