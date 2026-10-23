# Phase 1 scope

Phase 1 is a safe, capability-gated coding-tool foundation. The current
internal-alpha harnesses are Codex and OpenCode.

Included:

- TypeScript CLI command surface for login, status, doctor, Codex on, and Codex
  off.
- Provider and coding-tool harness interfaces.
- OS-keychain-first secret storage with error-preserving reads, an authoritative
  backend record, and a `0600` fallback.
- Safe Codex config discovery, TOML parsing and semantic merging.
- Durable timestamped snapshots, per-config prepared transaction journals,
  OS-backed advisory locks, atomic writes, crash recovery, idempotency, and
  exact restore.
- Non-destructive diagnostics, including validation against a pinned official
  Codex schema, an isolated installed-Codex loader check with relative-path
  rebasing, and opt-in integration tests.
- OpenCode global strict-JSON configuration, schema-adaptive provider mapping,
  snapshot-backed model switching, exact restore, and plain `opencode` launch
  through a private, instance-bound local bridge token file. The Krutrim API key
  remains in the KrutrimConnect credential backend; `opencode off` removes the
  launch token.

Not included:

- Unverified claims that Chat Completions compatibility implies Codex Responses
  compatibility.
- Support for Cursor, VS Code, or Claude Code beyond the harness interface.
- Telemetry.

The subsequent native compatibility work is documented in
[Phase 2 conformance](phase-2-conformance.md).
