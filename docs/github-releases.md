# GitHub Release distribution

## Public release identity

The initial public release is `krutrimconnect` version `0.1.0`, targeting
`https://github.com/ola-krutrim/krutrimconnect`. Users install the compiled CLI,
production dependencies and a private Node runtime from GitHub Release archives.
No user Node/npm installation or registry account is needed. npm publication is
disabled by `private: true` in package.json; npm remains an internal build tool.

Publish a fresh source snapshot into the new repository. Do not transfer the old
repository history, internal branches or existing version tags. The old internal
repository is preserved separately. The new v0.1.0 tag must identify the exact
reviewed public-source commit; it must not reuse the old repository's v0.1.0.

## Build and verify

Build on the actual target OS/architecture using an official portable Node
runtime. The hosted release workflow uses Node 22. Native dependencies cannot be
copied between platforms. The builder downloads and retains the exact Node
licence and refuses runtimes with non-system shared-library dependencies.

```bash
npm ci
npm run check
npm test
npm run check:installer
npm run pack:release
npm run verify:release
```

The builder requires its inputs to be tracked in Git. Archives contain LICENSE,
NOTICE, the prior MIT notice, revised policy copies and licence scope, plus the
compiled CLI, production dependencies and their notices, schemas, catalogue,
installer and bundled runtime. Raw legal-review DOCX/XLSX files, developer
configuration, internal review evidence and credentials are excluded.

Expected output in gitignored `release/`:

- `krutrimconnect-0.1.0-OS-ARCH.tar.gz`
- `krutrimconnect-0.1.0-OS-ARCH.tar.gz.sha256`

Supported release targets are macOS arm64, macOS x64 and Linux x64/glibc.
Linux requires compatible system libraries and a functioning Secret Service
backend for keychain access. Windows and Alpine/musl are unsupported.

Use `node scripts/verify-release.mjs --assets ABSOLUTE_DIRECTORY` to exercise a
downloaded archive in isolated paths. It verifies checksum/metadata, install,
version/help, offline catalogue, native imports, a test-only upgrade, retained
old runtime and uninstall with injected disconnected harness/credential backends.
It uses no system Node/npm on PATH and never accesses real credentials or runs
live inference. It does not establish live coding-tool/model compatibility.

## Draft release workflow

The full `.github/workflows/release.yml` must first exist on the new repository's
default branch for manual dispatch discovery. Run it from the reviewed version
tag with these inputs:

```bash
gh workflow run release.yml --repo ola-krutrim/krutrimconnect --ref v0.1.0 \
  -f version=0.1.0 -f 'confirmation=release v0.1.0'
```

The workflow validates repository/tag/version identity, runs quality checks,
builds and lifecycle-tests each native target, verifies checksums, and uploads
seven assets to a draft: installer plus three archives and three checksums.
It never publishes to npm or replaces an existing GitHub Release.
The draft is not available for anonymous installation or stable upgrade discovery.

Before publishing, resolve the open confirmations in
[legal release review](legal/RELEASE_REVIEW.md), review the source snapshot and
notices, confirm minimum supported OS versions and run exact-model acceptance
with installed Codex/OpenCode. Download and check each target's actual draft
assets. SHA-256 verifies a match to the supplied checksum, not release-account
identity; release signing/attestations are separate supply-chain controls.
Publish the reviewed draft, retain immutable versioned bytes, and verify
anonymous installer/archive download and hosted-release upgrade behavior.

## Public CI and catalogue updates

Public CI uses hosted Ubuntu runners with read-only permissions and non-persisted
checkout credentials. Do not attach the old internal self-hosted runner pool.
No internal package-publishing workflow is registered in the public repository.

Catalogue refresh is limited to scheduled/manual main runs in the exact new
repository. Configure `KRUTRIM_CATALOG_API_KEY` in that repository for refreshes;
the key is scoped to the refresh step, not source or release payloads. Its push
credential is confined to the commit/push step. The bundled snapshot remains
available if a live refresh cannot be performed.

## Install, upgrade and removal

```bash
curl --proto '=https' --proto-redir '=https' -fsSL \
  https://raw.githubusercontent.com/ola-krutrim/krutrimconnect/main/install.sh \
  -o /tmp/krutrimconnect-install.sh && sh /tmp/krutrimconnect-install.sh
```

This becomes usable only after the repository and stable release are public.
Use the version tag and `KRUTRIM_CONNECT_VERSION` for a pinned installation.
The launcher is installed under `~/.local/bin`; the managed release tree lives
under `~/.local/share/krutrimconnect`. PATH changes require explicit opt-in.
Installation does not collect an API key or change coding-tool settings.

`krutrimconnect upgrade --check` checks GitHub's latest published stable release.
`krutrimconnect upgrade` installs a newer matching target archive, validates it
and atomically switches `current`. Older version paths remain because existing
credential helpers and bridge processes can still reference them. Restart tool
sessions after upgrade; reconnect to move stored helper references.

`krutrimconnect uninstall` restores managed harness configuration, stops managed
bridges, removes accessible local credential copies, then removes only the owned
release installation and launcher. It does not revoke the Cloud API key.

## Migration from internal releases

An old internal 0.1.12 installation cannot automatically upgrade to public
0.1.0: that is a version downgrade and a repository identity change. Disconnect
Codex/OpenCode, uninstall the old owned installation, install public 0.1.0, log
in and reconnect. Uninstall removes accessible stored credentials; have the
Cloud key available through the approved credential process before migrating.
Do not remove downgrade checks or overwrite an unrelated launcher. Legacy npm
installations retain their existing registry lifecycle until explicitly migrated.
