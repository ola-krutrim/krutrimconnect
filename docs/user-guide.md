# KrutrimConnect user guide

KrutrimConnect configures Codex and OpenCode to use Krutrim Cloud. You need a
Krutrim Cloud model API key and a separately installed coding tool.

## Installation and PATH

Follow the [README installation instructions](../README.md#install) for your platform. The release
installer verifies its download and installs the CLI and its own Node runtime.
It does not require npm, sudo or a GitHub account for published public releases.

On macOS and Linux, the launcher is placed in `~/.local/bin`. If your shell cannot find it, run:

```sh
export PATH="$HOME/.local/bin:$PATH"
krutrimconnect --version
```

The installer prints the exact PATH advice. Set `KRUTRIM_CONNECT_MODIFY_PATH=1`
when running it to opt into a persistent bash/zsh PATH entry.

Supported release platforms are macOS arm64/x64, Linux x64/glibc, Alpine Linux
x64/musl and Windows x64. On Alpine, install `ca-certificates`, `curl` and
`libstdc++` with `apk` before running the shell installer; no system Node or npm
is needed. Linux keychain storage requires `secret-tool` and a functioning Secret
Service backend. A desktop keyring must be running and unlocked; installing the
client utility alone does not provide a credential store.

On Windows, use the PowerShell installer from the README. The launcher is
`%LOCALAPPDATA%\KrutrimConnect\bin\krutrimconnect.cmd`. Add that directory to your
user PATH and open a new terminal. `KRUTRIM_CONNECT_MODIFY_PATH=1` opts into a
persistent user PATH update. The installation uses private Windows ACLs and
Windows Credential Manager. Custom absolute local installation and launcher
roots can be selected with `KRUTRIM_CONNECT_INSTALL_DIR` and
`KRUTRIM_CONNECT_BIN_DIR`. The roots must be separate directories.
Windows ARM64/x86 and Alpine ARM64 release archives are not provided.

## Credentials

```sh
krutrimconnect login
krutrimconnect auth status
```

Interactive key entry is masked. Login validates the key without inference before
replacing an existing credential. The OS keychain is the default storage backend.
An explicitly selected POSIX file fallback stores plaintext with restricted file
permissions; see [security guidance](../SECURITY.md). On headless Linux where
Secret Service is unavailable, explicitly opt into this fallback with
`krutrimconnect login --allow-file-fallback`. Windows requires Credential Manager
and does not allow the plaintext fallback.

For automated input, explicitly choose one method:

```sh
krutrimconnect login --from-env
# Or pipe the key from your approved secret manager:
# secret-manager-command | krutrimconnect login --stdin
```

`--from-env` reads `KRUTRIM_API_KEY`; ordinary commands do not implicitly use an
ambient environment key. Never put an API key in command-line arguments, issues
or diagnostic reports.

Disconnect connected tools before replacing the key. To disconnect and remove
accessible local credentials together:

```sh
krutrimconnect logout --disconnect
```

Logout does not revoke the Cloud API key. Revoke or rotate it in Krutrim Cloud
when needed.

## Models and connections

```sh
krutrimconnect models list --refresh
krutrimconnect models show MODEL_ID
krutrimconnect codex on --model MODEL_ID
krutrimconnect opencode on --model MODEL_ID
```

Use the exact model ID. Listing models does not perform inference. Catalogue
availability alone does not establish coding-tool compatibility. Activation
qualifies the selected model and may make billable inference requests. It fails
without changing configuration when required capabilities cannot be established.

After activation, restart Codex or launch OpenCode normally with `opencode`.
To restore the saved configuration:

```sh
krutrimconnect codex off
krutrimconnect opencode off
```

## Troubleshooting

```sh
krutrimconnect status
krutrimconnect doctor
krutrimconnect doctor --model MODEL_ID
```

If activation fails, check the exact model, API-key validation and diagnostics.
A model may be listed while lacking the capabilities required by a coding tool.

If configuration has changed outside KrutrimConnect, review the drift reported
by status/doctor before forcing restoration. Keep your configuration backups.
Do not delete configuration or credential-helper paths to bypass ownership checks.

Use `krutrimconnect --help` or `krutrimconnect COMMAND --help` for options.
[Report an issue](https://github.com/ola-krutrim/krutrimconnect/issues) with
redacted diagnostics. Follow [SECURITY.md](../SECURITY.md) for vulnerabilities.

## Upgrade and removal

```sh
krutrimconnect upgrade --check
krutrimconnect upgrade
```

Upgrades use newer published stable GitHub Releases. Drafts are not offered as
updates. Restart coding-tool sessions after upgrading; reconnect tools to move
stored helper references to the new runtime. Older version paths are retained
because running sessions may still reference them.

```sh
krutrimconnect uninstall
```

Uninstall restores managed tool configuration, stops managed bridges, removes
accessible local credentials and deletes the owned installation. It does not
revoke the Cloud key. Use `--keep-package` to deactivate while keeping the CLI.

On Windows, close older CLI sessions before uninstalling. The launcher is removed
immediately; a separate cleanup process removes the executable after the uninstall
command exits. Unrelated files in the launcher directory are preserved.
