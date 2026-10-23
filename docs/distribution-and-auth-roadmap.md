# KrutrimConnect distribution and authentication roadmap

Status: GitHub-release distribution plan with the local API-key lifecycle implemented.
Public availability remains subject to the release gates below.

## Product decision

The public experience should be simple:

```text
Install -> authenticate -> choose a model -> connect a coding tool
```

Diagnostic probes and the local bridge remain internal to normal activation.
The public workflow stays:

```bash
krutrimconnect login
krutrimconnect models list
krutrimconnect codex on --model YOUR_MODEL_ID
```

FireConnect is only a product-experience reference. KrutrimConnect uses its
own installer, terminal artwork, command language, implementation, and
security model.

## Distribution status

GitHub Releases is the initial distribution channel. The self-contained archives
bundle the CLI, production dependencies, and a private Node runtime. End users do
not need Node.js or npm. npm remains a development dependency manager and a legacy
installation channel; public npm publication is disabled.

The current installation commands and release gates are maintained in
[GitHub Release distribution](github-releases.md) and the [README](../README.md).
Do not use older npm-first installer or `KRUTRIM_CONNECT_CHANNEL=testing`
instructions with the new release installer.

| Surface | Implementation | Remaining release gate |
| --- | --- | --- |
| Source checkout | Contributor/development path | Review source and history before public exposure |
| GitHub Release archive | Bundled runtime, native production dependencies, SHA-256 sidecar | Native target builds and downloaded-asset verification |
| macOS/Linux shell installer | Validates and activates an exact release; optional PATH setup | Published assets and authenticated/anonymous delivery checks |
| Upgrade | GitHub-release routing; old version paths retained | Real hosted-release upgrade validation |
| Uninstall | Ordered harness/bridge/credential teardown and managed file removal | Target-platform end-to-end validation |
| Windows/Alpine release installer | Not supported by this distribution flow | Separate implementation and verification |
| npm installations | Existing registry-bound lifecycle remains supported | Optional future publication decision |

## Release train

1. Review and commit the intended changes and choose an immutable matching version
   tag. Keep licence approval, visibility changes, pushes and publication as
   separately authorized actions.
2. Run local tests, type-checking, build, installer checks, and package verification.
   Build target-native release archives and run `npm run verify:release` in isolation.
3. Create a draft GitHub Release through the manually confirmed workflow. Verify
   all intended target assets, checksums, runtime/dependency notices, and downloaded
   install/upgrade/uninstall behavior. A draft is not a public installation endpoint.
4. After legal/security/platform approval, publish the approved release and test
   anonymous downloads. Keep prereleases out of stable latest selection.

Live model qualification can incur inference charges. Offline packaging checks
must not call the real keychain, change a developer's harness configuration, or
invoke live inference without separate approval.

## Public and internal distribution

The initial public release is `0.1.0` in `ola-krutrim/krutrimconnect`.
The source will be published as a fresh snapshot, without old repository history,
internal branches or pre-existing tags. Public CI and release builds use
GitHub-hosted runners. npm publication is disabled; npm is used internally to
build and test, and legacy registry installations retain their upgrade routing.

The old internal repository remains separate. Its `0.1.12` installations require
an explicit migration to public `0.1.0`; repository ownership and downgrade
checks must remain enabled. See [release operations](github-releases.md).

## Authentication available today

`krutrimconnect login` stores one Krutrim model API key for the selected
application home. It is credential storage, not an authenticated account
session.

| Input/storage preference | Current behavior |
| --- | --- |
| Masked interactive input | Default; an ambient `KRUTRIM_API_KEY` is ignored unless explicitly selected |
| `login --from-env` | Reads `KRUTRIM_API_KEY` explicitly |
| `login --stdin` | Reads bounded UTF-8 input and accepts one trailing shell line ending |
| Default validation | Invalid-token control followed by authenticated `GET /v1/models`; no inference |
| `login --skip-validation` | Explicitly stores an unvalidated key for exceptional offline/internal use |
| OS keychain | Preferred storage on macOS, Linux, and Windows |
| Restricted file | Explicit `--allow-file-fallback` last resort on supported POSIX systems |
| Runtime commands | Read the stored backend; they do not consume the environment key directly |
| `auth status [--json]` | Reports local presence, backend, credential type, and validation state without the key |
| `logout [--json]` | Removes accessible keychain/fallback copies and the backend record; does not revoke KMS keys |

Credential replacement and logout are blocked while managed Codex or OpenCode configuration
is active, drifted, or unmanaged. This protects capability evidence and
configuration from silently changing identity.

## Recommended login preferences

### Release 1: local API-key lifecycle — implemented

The implemented local lifecycle is:

```text
krutrimconnect login --from-env
printf '%s' "$KRUTRIM_API_KEY" | krutrimconnect login --stdin
krutrimconnect auth status
krutrimconnect logout
```

Rules:

- never accept the key in a command-line value;
- require explicit `--from-env` or `--stdin` for noninteractive input;
- define `logout` as local secret removal, not remote KMS key revocation;
- refuse logout or rotation until connected tools are safely disconnected;
- remove stale keychain/fallback copies when switching backends and report
  partial cleanup;
- validate before storage so failed authentication never replaces a working key;
- persist HMAC-bound validation evidence and report its timestamp without
  claiming that the key cannot subsequently be revoked; and
- provide deterministic JSON results and exit codes for automation.

Lifecycle command exit codes are stable:

| Exit code | Meaning |
| --- | --- |
| `0` | The command completed; `auth status` can still report `state: "missing"` |
| `1` | The new credential was stored, but stale-backend cleanup was incomplete |
| `2` | Input, online validation, configuration, active-harness guard, or secret-backend failure |

### Release 2: named API-key profiles

- Store separate keychain entries per profile.
- Bind capability evidence, model access, and managed configuration to the
  selected profile.
- Show the active profile and validation freshness without exposing identity or
  secret values.
- Never silently fall through to another profile or an old fallback key.

### Release 3: browser or device login

This phase is blocked on an approved Krutrim IAM OAuth/OIDC contract covering
client registration, issuer, audience, scopes, PKCE or device authorization,
refresh, revocation, logout, and organisation/project selection.

When that contract exists:

- prefer browser sign-in with PKCE or device authorization for interactive
  users;
- keep short-lived access tokens in memory;
- store only the refresh/session credential in the OS keychain;
- revoke the server session on logout where supported; and
- retain API-key login as an explicit alternative during migration.

Do not show a non-functional browser-login choice before the IAM contract and
end-to-end flow exist.

### Release 4: CI and service identities

This phase requires short-lived service-account or workload-federation
contracts from Krutrim IAM.

- Prefer an explicitly selected, non-persistent workload token.
- Do not copy CI credentials into the plaintext fallback file.
- Keep bridge and coding-tool configuration free of the upstream credential.
- Expose noninteractive status, expiry, scope, and remediation without printing
  tokens.

## Long-term preference order

1. Interactive developer: browser/device session when supported.
2. Explicitly selected API-key profile as the supported fallback.
3. Automation: short-lived workload/service identity.
4. API key from stdin into an approved secure backend.
5. Permission-restricted plaintext fallback only by explicit opt-in.

Until Krutrim IAM provides the necessary contracts, only the API-key path is
supported and product wording must not call it an account session.
