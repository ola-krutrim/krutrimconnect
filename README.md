# KrutrimConnect

Connect Codex and OpenCode to Krutrim Cloud models using your Krutrim Cloud API key.
KrutrimConnect handles sign-in, model selection and tool configuration, and lets you
restore your previous configuration when you disconnect.

## Install

### macOS and Linux

```sh
(
  set -eu
  connect_installer="$(mktemp)"
  trap 'rm -f "$connect_installer"' EXIT
  curl --proto '=https' --proto-redir '=https' -fsSL \
    https://raw.githubusercontent.com/ola-krutrim/krutrimconnect/main/install.sh \
    -o "$connect_installer"
  sh "$connect_installer"
)
```

The installer downloads the latest stable release, verifies its checksum and
installs KrutrimConnect with its own runtime. No Node.js, npm, sudo or GitHub
account is required. Install Codex or OpenCode separately.

Supported platforms: macOS Apple Silicon, macOS Intel, Linux x64 with glibc,
Alpine Linux x64 with musl, and Windows x64.

On Alpine, install the system libraries and download tools before running the installer:

```sh
apk add --no-cache ca-certificates curl libstdc++
```

The installer selects the matching glibc or musl archive automatically. Linux
keychain storage requires `secret-tool` and a running Secret Service backend.
For headless Linux setup, see [credential storage](docs/user-guide.md#credentials).

If your shell cannot find the command, add the launcher directory to your PATH:

```sh
export PATH="$HOME/.local/bin:$PATH"
krutrimconnect --version
```

Follow the installer's instructions to make the PATH change persistent.
You can also download archives from [GitHub Releases](https://github.com/ola-krutrim/krutrimconnect/releases/latest).

### Windows (PowerShell)

Run in PowerShell 5.1 or later:

```powershell
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/ola-krutrim/krutrimconnect/main/install.ps1" -OutFile "$env:TEMP\krutrimconnect-install.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\krutrimconnect-install.ps1"
$env:Path = "$env:LOCALAPPDATA\KrutrimConnect\bin;$env:Path"
krutrimconnect --version
```

Windows installs per user under `%LOCALAPPDATA%\KrutrimConnect`, with no
administrator access, Node.js or npm required. Add its `bin` directory to your
user PATH for future terminals, or set `$env:KRUTRIM_CONNECT_MODIFY_PATH = "1"`
before running the installer to let it update your user PATH. Credentials use
Windows Credential Manager. Native Windows ARM64 and x86 packages are not available.

## Get started

### 1. Sign in

[Create or manage a Krutrim Cloud model API key](https://docs.cloud.olakrutrim.com/basics/key-management-system/model-api-keys), then run:

```sh
krutrimconnect login
krutrimconnect auth status
```

Paste your API key at the masked prompt. Login validates it without inference
and stores it in your OS keychain. Do not pass keys as command-line arguments.
For automated input, use `login --from-env` to read `KRUTRIM_API_KEY`, or
`login --stdin` to read from a secret manager's output.

### 2. Choose a model

```sh
krutrimconnect models list
krutrimconnect models show MODEL_ID
```

Replace `MODEL_ID` with an exact model ID from the catalogue. Use
`models list --refresh` for a fresh catalogue or `models list --offline` for the
bundled snapshot. Listing models does not perform inference. A listed model may
not support every capability required by your coding tool.

### 3. Connect your coding tool

Run the command for the tool you use:

```sh
# Codex
krutrimconnect codex on --model MODEL_ID

# OpenCode
krutrimconnect opencode on --model MODEL_ID
```

Activation checks the selected model's compatibility and may incur inference
charges. Restart your coding tool after connecting, then use it normally.

To disconnect and restore the saved configuration:

```sh
krutrimconnect codex off
krutrimconnect opencode off
```

## Commands

| Command | What it does |
| --- | --- |
| `login` | Validate and securely store your Krutrim Cloud API key. |
| `auth status` | Show local credential status without displaying the key. |
| `logout` | Remove accessible local credentials. Use `--disconnect` to restore connected tools first. |
| `models list` | List catalogue models, with live lookup and snapshot fallback. |
| `models show MODEL_ID` | Show model details from the bundled catalogue. |
| `codex on --model MODEL_ID` | Configure Codex to use the selected Krutrim model. |
| `codex off` | Restore Codex's saved configuration. |
| `status` | Show the Codex connection state. |
| `opencode on --model MODEL_ID` | Configure OpenCode to use the selected Krutrim model. |
| `opencode off` | Restore OpenCode's saved configuration. |
| `opencode status` | Show the OpenCode connection state. |
| `opencode run [args...]` | Launch OpenCode, forwarding its arguments. |
| `chat --model MODEL_ID --accept-inference-charges` | Send a potentially billable prompt directly to Krutrim; prompts interactively or reads standard input. |
| `doctor` | Check configuration, credentials, reachability and recorded capabilities without inference. |
| `upgrade --check` | Check whether a newer stable release is available. |
| `upgrade` | Download and install the latest stable release. |
| `uninstall` | Restore managed tool configuration, remove accessible local credentials and remove KrutrimConnect. |
| `--version` | Print the installed version. |
| `--help` | Show command help. |
| `help [command]` | Show help for a particular command. |

Every command starts with `krutrimconnect`. Use `krutrimconnect COMMAND --help`
for all options, including JSON output where supported. Model listing supports
`--query`, `--publisher`, `--modality` and `--all` filters.

## Upgrade or remove

```sh
krutrimconnect upgrade --check
krutrimconnect upgrade
```

Restart coding-tool sessions after upgrading. Reconnect tools to update their
stored runtime references. Older runtimes are retained for existing sessions.

```sh
# Disconnect tools and remove credentials, keeping the CLI
krutrimconnect logout --disconnect

# Remove KrutrimConnect and its managed connections and credentials
krutrimconnect uninstall
```

On Windows, close older KrutrimConnect sessions before uninstalling; executable
cleanup finishes after the uninstall command exits.

Logout and uninstall remove local credentials; they do not revoke your Cloud API
key. Revoke or rotate the key in Krutrim Cloud when needed.

## Troubleshooting

Run `krutrimconnect doctor` and the relevant connection status command. To inspect
recorded capabilities for a particular model, run `krutrimconnect doctor --model MODEL_ID`.
If configuration was changed outside KrutrimConnect, review reported changes
before restoring it.

See the [user guide](docs/user-guide.md) for credential storage, setup and recovery.
[Report an issue](https://github.com/ola-krutrim/krutrimconnect/issues) with redacted
diagnostics. For vulnerabilities, follow [security guidance](SECURITY.md).

## Terms and licence

Source code: [Apache 2.0](LICENSE), with [notices](NOTICE) and [licence scope](docs/legal/LICENSE_SCOPE.md).
Krutrim Cloud use is governed by its [Terms & Conditions](https://www.olakrutrim.com/terms-and-conditions)
and [Privacy Policy](https://www.olakrutrim.com/privacy-policy). Review and test AI-generated output before use.
See [user notices](docs/legal/USER_NOTICES.md).
