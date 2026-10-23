# krutrimconnect

Connect Codex and OpenCode to Krutrim Cloud with guarded credentials and
reversible configuration changes.

## Install

KrutrimConnect is distributed as self-contained **GitHub Release archives**.
Each contains the CLI, production dependencies, and a private Node.js runtime.
Users do **not** need Node.js, npm, or an npm registry account. Install Codex or
OpenCode separately, then configure it with your existing Krutrim Cloud API key.

**Public release preparation:** version `0.1.0` targets
[`ola-krutrim/krutrimconnect`](https://github.com/ola-krutrim/krutrimconnect).
The command below becomes usable after that repository and its stable release
assets are published. A draft release is not an anonymous installation endpoint.

### macOS and Linux

```bash
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://raw.githubusercontent.com/ola-krutrim/krutrimconnect/main/install.sh \
  -o /tmp/krutrimconnect-install.sh && sh /tmp/krutrimconnect-install.sh
```

For a reproducible install, fetch `install.sh` from an approved `vX.Y.Z` tag
instead of `main` and set `KRUTRIM_CONNECT_VERSION=X.Y.Z`. Only published stable
releases are selected by default; prereleases require an exact version.

The installer verifies the archive's SHA-256 checksum and metadata, installs under
`~/.local/share/krutrimconnect`, and creates `~/.local/bin/krutrimconnect`.
It never uses `sudo`. It prints the PATH command if needed; set
`KRUTRIM_CONNECT_MODIFY_PATH=1` to opt into a persistent bash/zsh PATH entry.
Use `KRUTRIM_CONNECT_INSTALL_DIR` and `KRUTRIM_CONNECT_BIN_DIR` for custom absolute,
non-overlapping directories. Run `sh install.sh --help` for all options.

Supported release targets are macOS Apple Silicon, macOS Intel, and Linux x64
(glibc). Native Windows and Linux musl/Alpine installs are not supported.
Linux keychain access requires a functioning Secret Service backend.

### Development/source installation

```bash
git clone https://github.com/ola-krutrim/krutrimconnect.git
cd krutrimconnect
npm ci
npm run build
npm link
```

Source development still uses Node.js and npm. npm publication is disabled for this release;
existing npm/GitHub Packages installations retain their legacy upgrade path.
Do not delete an existing npm installation while a harness still references it:
disconnect the harnesses, remove the legacy package, install the release, then
reconnect. The installer refuses to overwrite an unrelated launcher and warns
when another executable shadows the new one on PATH.

Existing installs keep using `~/.config/krutrim-connect`, the existing keychain
service, and `KRUTRIM_CONNECT_*` environment variables. Installation does not sign
you in, collect a key, or modify harness settings.

## Upgrade

```bash
krutrimconnect upgrade --check
krutrimconnect upgrade
```

For internal release downloads, prefix either command with
`KRUTRIM_CONNECT_GITHUB_AUTH=1` (requires an authenticated `gh`).

GitHub-release installations check GitHub Releases and install an exact newer
version without npm. The installer atomically switches the current version and
retains older release directories: existing credential helpers and running bridge
processes may still reference them. Restart coding-tool sessions after upgrading;
reconnect harnesses when you want their stored helpers to reference the new runtime.
Credentials and harness configuration are not rewritten by the installer.

Legacy public npm installs follow `latest`; legacy GitHub Packages installs follow
the `internal` tag. Updates never downgrade automatically or invoke `sudo`.

## Krutrim Cloud

Store one Krutrim model API key for the selected KrutrimConnect application
home. Interactive input is masked.

```bash
krutrimconnect login
krutrimconnect auth status
krutrimconnect models list
krutrimconnect models show Qwen3.6-35B-A3B
```

`models list` is live by default: it fetches the authenticated model registry
and `GET /v1/models` (no inference), lists only the models currently available
for use, and shows publisher, modality, context length, and INR pricing from
the registry. Results are cached privately for one hour (`--refresh`
refetches); `--all` includes unavailable/unlisted models. Without a stored key
or network access it falls back to the bundled snapshot; `--offline` forces
snapshot-only mode.

Noninteractive input must be selected explicitly; `KRUTRIM_API_KEY` is never
consumed implicitly.

```bash
export KRUTRIM_API_KEY
krutrimconnect login --from-env

printf '%s' "$KRUTRIM_API_KEY" | krutrimconnect login --stdin
krutrimconnect auth status --json
```

By default, `login` first verifies that an invalid bearer is rejected and then
validates the supplied key with Krutrim's authenticated `GET /v1/models`
endpoint. This performs no inference. A failed check leaves the existing
credential untouched. Use `--skip-validation` only when deliberately accepting
an unvalidated offline/internal setup.

`logout` removes accessible local keychain and fallback copies; it does not
revoke the Krutrim KMS key. Disconnect Codex and OpenCode before logout, or
pass `--disconnect` to do both in one step (add `--force` only after reviewing
drift, to rescue-snapshot externally changed harness configs first).

```bash
krutrimconnect logout
krutrimconnect logout --disconnect
```

Run one Chat Completions request. It may incur inference charges.

```bash
printf 'Write a two-line welcome message.\n' | \
  krutrimconnect chat \
    --model Qwen3.6-35B-A3B \
    --accept-inference-charges
```

## Codex

```bash
krutrimconnect codex on --model '<exact-model-id>'
krutrimconnect codex off
```

`codex on` checks the exact model before changing configuration. It selects a
native Responses route when available, otherwise a private local bridge. It
creates a snapshot before editing Codex configuration; `codex off` restores it.

## OpenCode

```bash
krutrimconnect opencode on --model '<exact-model-id>'
opencode
krutrimconnect opencode off
```

After `opencode on`, launch OpenCode normally with `opencode`. KrutrimConnect
stores only an instance-bound local bridge token in its private `0600` runtime
directory and places a file reference in OpenCode configuration. The Krutrim
API key remains in the configured OS credential backend. The compatibility
launcher `krutrimconnect opencode run` remains available for older sessions.

## Status and diagnostics

```bash
krutrimconnect status
krutrimconnect doctor
krutrimconnect doctor --model '<exact-model-id>'
```

## Uninstall

```bash
krutrimconnect uninstall
```

`uninstall` disconnects Codex and OpenCode (restoring their exact pre-connect
configurations), stops any managed bridge, removes every accessible local
Krutrim credential copy, and then removes the managed release installation and
launcher (or the npm package for a legacy install). Remote key revocation is not performed. Use `--keep-package` to
deactivate without removing the package, and `--json` for a machine-readable
result.

`status` and `doctor` never print API keys. Normal activation performs required
model compatibility qualification internally and reports before any potentially
billable checks.

## Development

```bash
npm run check
npm test
npm run build
npm run verify:package
# With an official standalone Node runtime:
npm run pack:release
npm run verify:release
```

See [docs/](docs/) for architecture, conformance, release, and security
details.

## Krutrim Cloud Terms and Privacy

Use of Krutrim Cloud through Krutrim Connect is subject to the applicable
Krutrim Cloud [Terms & Conditions](https://www.olakrutrim.com/terms-and-conditions)
and [Privacy Policy](https://www.olakrutrim.com/privacy-policy). The applicable
Terms & Conditions and Privacy Policy govern use of Krutrim Cloud and the
processing of Personal Data, as applicable. Any additional policies or
documentation apply to the extent expressly incorporated into or otherwise
applicable under the relevant Terms.

The revised [Terms](docs/legal/TERMS_AND_CONDITIONS.md) and
[Privacy Policy](docs/legal/PRIVACY_POLICY.md) supplied for this release are
retained for review; their inclusion here does not replace the applicable
published policies.

## API Keys

Krutrim Connect uses your existing Krutrim Cloud API key to configure supported
tools for access to Krutrim Cloud. You are responsible for maintaining the
confidentiality and security of your credentials. Follow the published
[Model API Keys guidance](https://docs.cloud.olakrutrim.com/basics/key-management-system/model-api-keys).

The CLI stores the key in the configured OS keychain. The explicit POSIX file
fallback is plaintext with restricted file permissions. The key is read for
Krutrim requests and sent to fixed Krutrim HTTPS endpoints; it is not written
to managed harness configuration. Loopback bridges use instance-bound derived
tokens. Codex native qualification may pass the real key to an isolated Codex
subprocess environment. Activation may make billable inference requests.
See [SECURITY.md](SECURITY.md) for the supported boundary and details.

## Third-Party Tools

Krutrim Connect may support integration with third-party coding or AI tools.
References to third-party names, products or trademarks are made solely to
identify compatibility or integration. Unless expressly stated, such references
do not imply affiliation, endorsement, sponsorship or partnership. Users remain
responsible for complying with applicable third-party terms and licence conditions.

## AI-Generated Output

Krutrim Connect may enable supported tools to generate code or other content
using Krutrim Cloud models. Outputs may not be accurate, complete or suitable
for a particular purpose. Users are responsible for reviewing, testing and
validating Outputs before use, distribution or deployment, and for ensuring
that their Inputs and use of Outputs comply with applicable law and applicable
third-party or model-specific terms. This section is subject to the applicable
Krutrim Cloud Terms & Conditions.

## License

The public-release source is prepared under the Apache License 2.0, subject to
closure of the confirmations recorded in the [release review](docs/legal/RELEASE_REVIEW.md).
See [LICENSE](LICENSE) for the complete licence terms, [NOTICE](NOTICE) for
attributions, and [licence scope](docs/legal/LICENSE_SCOPE.md) for the boundary
between source code, Cloud services, models and third-party components.
