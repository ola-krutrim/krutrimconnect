# KrutrimConnect user guide

KrutrimConnect configures Codex and OpenCode to use Krutrim Cloud. You need a
Krutrim Cloud model API key and a separately installed coding tool.

## Installation and PATH

Follow the [README installation command](../README.md#install). The release
installer verifies its download and installs the CLI and its own Node runtime.
It does not require npm, sudo or a GitHub account for published public releases.

The launcher is placed in `~/.local/bin`. If your shell cannot find it, run:

```sh
export PATH="$HOME/.local/bin:$PATH"
krutrimconnect --version
```

The installer prints the exact PATH advice. Set `KRUTRIM_CONNECT_MODIFY_PATH=1`
when running it to opt into a persistent bash/zsh PATH entry.

Supported release platforms are macOS arm64, macOS x64 and Linux x64/glibc.
Native Windows and Alpine/musl are unsupported. Linux keychain storage requires
a functioning Secret Service backend.

## Credentials

```sh
krutrimconnect login
krutrimconnect auth status
```

Interactive key entry is masked. Login validates the key without inference before
replacing an existing credential. The OS keychain is the default storage backend.
An explicitly selected POSIX file fallback stores plaintext with restricted file
permissions; see [security guidance](../SECURITY.md).

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

For older internal or npm installations, disconnect tools and uninstall the old
installation before installing the public release. Public 0.1.x releases cannot
automatically replace an internal 0.1.12 install or an unrelated launcher.
