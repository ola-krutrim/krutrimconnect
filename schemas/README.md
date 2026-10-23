# Pinned Codex configuration schema

`codex-config.schema.json` is a reviewed snapshot of the official Codex
configuration schema. `krutrimconnect doctor` uses it locally; diagnostics do
not download or execute remote schema content.

- Source: <https://learn.chatgpt.com/docs/config-schema.json>
- Retrieved: 2026-08-10
- SHA-256: `16a95ee999c0a3949d29208073507eece3e11bb1352b9519c0d4c370564cc808`

Updating this file requires reviewing the schema diff, updating the hash and
retrieval date above, and rerunning the unit and packaging tests. The additional
installed-Codex loader check remains useful because the installed binary and
this pinned schema can represent different Codex releases.
