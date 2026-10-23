# KrutrimConnect per-user Windows x64 installer. No Node.js, npm or administrator access required.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
# PowerShell 7 may launch Windows PowerShell with incompatible module paths.
$env:PSModulePath = $PSHOME + '\Modules'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repository = 'ola-krutrim/krutrimconnect'
$version = $env:KRUTRIM_CONNECT_VERSION
if (-not $version) { $version = 'latest' }
if ($version -ne 'latest' -and $version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-next\.(0|[1-9][0-9]*))?$') { throw 'Invalid release version.' }
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem) { throw 'This installer requires Windows x64.' }
$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw 'Native Windows ARM64 and x86 packages are not available.' }
if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required.' }
$root = Join-Path $env:LOCALAPPDATA 'KrutrimConnect'
$installDir = $env:KRUTRIM_CONNECT_INSTALL_DIR
if (-not $installDir) { $installDir = Join-Path $root 'app' }
$binDir = $env:KRUTRIM_CONNECT_BIN_DIR
if (-not $binDir) { $binDir = Join-Path $root 'bin' }
if ($version -eq 'latest') {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/latest" -Headers @{ Accept='application/vnd.github+json' } -TimeoutSec 30
    if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'Invalid latest stable release.' }
    $version = $release.tag_name.Substring(1)
}
$archive = "krutrimconnect-$version-win32-x64.zip"
$work = Join-Path ([IO.Path]::GetTempPath()) ('krutrimconnect-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    foreach ($id in @($sid.Value,'S-1-5-18','S-1-5-32-544')) {
        $identity = [Security.Principal.SecurityIdentifier]::new($id)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    [IO.Directory]::SetAccessControl($work,$acl)
    foreach ($asset in @($archive,"$archive.sha256")) {
        $destination = Join-Path $work $asset
        if ($env:KRUTRIM_CONNECT_ASSET_DIR) {
            Copy-Item -LiteralPath (Join-Path $env:KRUTRIM_CONNECT_ASSET_DIR $asset) -Destination $destination
        } else {
            Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repository/releases/download/v$version/$asset" -OutFile $destination -TimeoutSec 300
        }
    }
    $checksum = [IO.File]::ReadAllText((Join-Path $work "$archive.sha256")).TrimEnd([char[]]"`r`n")
    if ($checksum -notmatch ('^([a-f0-9]{64})  ' + [Regex]::Escape($archive) + '$')) { throw 'Invalid release checksum.' }
    $expected = $Matches[1]
    if ((Get-FileHash -LiteralPath (Join-Path $work $archive) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Release checksum verification failed.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $payload = Join-Path $work 'payload'
    New-Item -ItemType Directory -Path $payload | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead((Join-Path $work $archive))
    try {
        $total = 0L
        $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\','/')
            if (-not $name -or $name.StartsWith('/') -or $name -match '(^|/)\.\.(/|$)|:|[\x00-\x1f]' -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Unsafe release archive entry.' }
            $destination = [IO.Path]::GetFullPath((Join-Path $payload $name))
            if (-not $destination.StartsWith($payload + '\',[StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($destination.TrimEnd('\'))) { throw 'Unsafe or duplicate archive path.' }
            $total += $entry.Length
            if ($total -gt 536870912) { throw 'Release archive exceeds the extraction limit.' }
            if ($name.EndsWith('/')) { New-Item -ItemType Directory -Path $destination -Force | Out-Null; continue }
            New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$destination,$false)
        }
    } finally { $zip.Dispose() }
    foreach ($file in @('bin/node.exe','dist/windows-release.js','dist/cli.js','release.json','package.json','install.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $payload $file) -PathType Leaf)) { throw "Missing release file: $file" }
    }
    & (Join-Path $payload 'bin/node.exe') (Join-Path $payload 'dist/windows-release.js') install $payload $installDir $binDir $version $expected
    if ($LASTEXITCODE -ne 0) { throw 'Windows release activation failed.' }
    $env:PATH = $binDir + ';' + $env:PATH
    if ($env:KRUTRIM_CONNECT_MODIFY_PATH -eq '1') {
        $userPath = [Environment]::GetEnvironmentVariable('Path','User')
        if (($userPath -split ';') -notcontains $binDir) { [Environment]::SetEnvironmentVariable('Path',($binDir + ';' + $userPath),'User') }
    }
    Write-Host 'Ready. Run: krutrimconnect login'
} finally { Remove-Item -LiteralPath $work -Recurse -Force }
