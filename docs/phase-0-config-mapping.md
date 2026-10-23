# Phase 0: Codex configuration mapping

Phase 0 records the configuration contract checked on 2026-08-10 before any
implementation work began.

## Confirmed Codex behavior

- User configuration lives at `$CODEX_HOME/config.toml`, defaulting to
  `~/.codex/config.toml`.
- Provider and authentication keys are machine-local. Codex ignores
  `model_provider` and `model_providers` in project `.codex/config.toml` files.
- A custom provider supports `base_url`, `wire_api`, and either `env_key` or a
  command-backed bearer-token helper under `[model_providers.<id>.auth]`.
- The only supported custom-provider `wire_api` value is `responses`.
- The auth helper receives no stdin and returns a bearer token on stdout.

Official sources:

- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
- [Codex authentication](https://learn.chatgpt.com/docs/auth#alternative-model-providers)

The local inspection used Codex CLI `0.145.0`. The existing user config was
read only for its non-secret structure and was not modified.

## Confirmed Krutrim behavior

- The documented inference base URL is `https://cloud.olakrutrim.com/v1`.
- Authentication uses `Authorization: Bearer <model-api-key>`.
- Public documentation demonstrates `POST /v1/chat/completions` and documents
  streaming.

Official sources:

- [Krutrim model API keys](https://docs.cloud.olakrutrim.com/basics/key-management-system/model-api-keys)
- [Krutrim inferencing](https://docs.cloud.olakrutrim.com/basics/ai-studio/ai-jobs/inferencing)

## Exact managed mapping

When the compatibility gate passes, `krutrimconnect codex on` manages only
these semantic values in the user-level Codex TOML:

```toml
model = "<selected-model>"
model_provider = "krutrim"

[model_providers.krutrim]
name = "Krutrim Cloud"
base_url = "https://cloud.olakrutrim.com/v1"
wire_api = "responses"
supports_websockets = false

[model_providers.krutrim.auth]
command = "<absolute-path-to-node>"
args = ["<absolute-installed-cli-entrypoint>", "_credential", "read", "--app-home", "<absolute-app-home>"]
timeout_ms = 60000
refresh_interval_ms = 0
```

The standalone web-search capability key is deliberately omitted. Official
documentation defines `false` as the default for a custom provider, and Codex
CLI 0.145.0 rejects an explicit `supports_standalone_web_search = false` during
strict runtime loading even though the latest official schema accepts it. The
minimal mapping above is accepted by both checks.

The API key is never written to TOML. The helper reads it from the OS keychain,
or from the documented permission-restricted fallback, and writes it only to
the stdout pipe Codex created for its bearer-token hook.

## Compatibility decision

Codex requires the Responses API, streaming, and tool calling for an agent loop.
The public Krutrim documentation found during Phase 0 does not establish a
Responses endpoint or tool-calling support. The adapter therefore records those
capabilities as `unknown`, and Phase 1 refuses to modify Codex configuration
until they are confirmed. A future local Responses-to-Chat-Completions bridge
is explicitly outside Phase 1 and requires a product decision.

Phase 2 selected the native conformance path instead of a local bridge. See
[Phase 2 conformance](phase-2-conformance.md) for the authenticated, model-bound
promotion gate.
