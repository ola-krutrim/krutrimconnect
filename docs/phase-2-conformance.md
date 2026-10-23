# Phase 2: native Responses and local bridge conformance

Phase 2 supports two fail-closed paths: native Responses, and a private local
Responses-to-Chat translator for models whose Chat function calls, streamed
arguments, and tool-result continuation pass a separate model-bound probe.
Bridge evidence cannot promote native capabilities.

The public Krutrim contract checked on 2026-08-11 still demonstrates
`POST /v1/chat/completions`, bearer model keys, and Chat Completions token
streaming. It does not publicly specify `/v1/responses`, native function calls,
Responses SSE events, or the authenticated `/v1/models` response that the CLI
has observed and validates at runtime:

- [Krutrim inferencing](https://docs.cloud.olakrutrim.com/basics/ai-studio/ai-jobs/inferencing)
- [Krutrim model API keys](https://docs.cloud.olakrutrim.com/basics/key-management-system/model-api-keys)

Codex custom providers use the Responses wire API. The probe is based on the
official Responses function-call and streaming contracts:

- [Codex custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
- [Responses function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [Responses streaming](https://developers.openai.com/api/docs/guides/streaming-responses)

## Automatic live qualification

First store a Krutrim model API key, then activate the harness directly:

```bash
krutrimconnect codex on --model '<exact-model-id>'
```

The command reuses valid current evidence; otherwise it reports that internal
qualification can be billable before sending requests. Accepted model requests
consume input and output tokens, and a timeout can still incur partial usage.
The qualification does not retry automatically. It checks native Responses first. When native
conformance fails after authentication succeeds, it automatically runs the Chat
bridge ladder and selects `native` or `bridge` internally.

If the requested model ID contains the stored credential, the probe stops
before writing pending evidence or making any request. Reports and diagnostics
are key-aware redacted before display.

The endpoint is not configurable. The implementation permits only:

```text
https://cloud.olakrutrim.com/v1/chat/completions
https://cloud.olakrutrim.com/v1/responses
https://cloud.olakrutrim.com/v1/models
```

Redirects are disabled. The real credential is sent to a route only after a
dummy-token control proves that the route performs authentication before body
validation.

## Probe ladder

The probe stops at the first unresolved layer:

1. **Credential control.** Send model-free `{}` Chat Completions requests,
   first with a fixed invalid token and then with the stored token. The invalid
   request must return `401` or `403`; the stored-token request must reach body
   validation and return `400` or `422`.
2. **Responses route control.** Repeat the sequential model-free control on
   `/v1/responses`. A `404`, `405`, or `501` fails the route gate. Reaching body
   validation proves only that the route exists; it does not promote a
   capability.
3. **Responses text stream.** Make one small, authenticated model request with
   `stream: true` and `store: false`. Require `text/event-stream`, one
   `response.created`, an assistant `response.output_item.added`, one or more
   indexed `response.output_text.delta` events, a completed output item, and a
   terminal completed response. Delta text and the completed message must be
   non-empty and consistent, but exact reproduction of a long random string is
   not treated as a transport requirement. The created and completed response
   objects must both report the exact requested model; aliases are not assumed
   equivalent. The completed event need not repeat its output array: the target
   Codex runtime records assistant history from `response.output_item.done`.
4. **Streamed function call.** Ask the model to select a no-op function through
   `tool_choice: "auto"`, matching normal Codex turns, with a random nonce.
   Require a stable item ID and call ID, at least one
   `response.function_call_arguments.delta`, the matching argument-done and
   output-item-done events, valid JSON arguments, and the exact nonce.
5. **Tool-result continuation.** Replay the function call plus a synthetic
   `function_call_output` using the same call ID, including any returned
   reasoning items required by reasoning models. Require a second canonical
   text stream containing the fixed synthetic result marker. Matching current
   Codex behavior, the continuation resends the same declarations with
   `tool_choice: "auto"`; the CLI never executes a returned tool call, and the
   representative web-search declaration has external access disabled.
6. **Installed-Codex native canary.** Only after the five synthetic stages pass,
   build authenticated exact-model metadata and launch a fresh `codex exec`
   process with an isolated temporary `CODEX_HOME`, read-only sandbox, and the
   native Krutrim Responses mapping. Require one real shell-tool call, its
   correlated continuation, and the exact final marker. An HTML `403` from
   EdgeSuite/Akamai fails native qualification even when the smaller synthetic
   requests passed; the unified command then evaluates bridge compatibility.

The active request includes current Codex-shaped envelope fields such as
`instructions`, Responses `input` items, `tool_choice`,
`parallel_tool_calls: false`, `reasoning`, `store: false`, `include`,
`prompt_cache_key`, and `client_metadata`. Its representative tool declarations
include a regular function, a namespace, and disabled external web search.
The envelope intentionally omits `max_output_tokens`, because current Codex
does not send that field. This prevents a provider that incorrectly requires a
probe-only field from receiving passing evidence. The client stops reading
after 15 seconds, 1 MiB, 512 events, or a 64 KiB event, but an upstream service
may continue generation after client cancellation and may charge through its
own output limit.

This establishes the core Responses/tool loop required by the adapter and checks
it using the installed Codex request envelope. It is not a blanket claim that
every configuration-dependent or future Codex tool schema is compatible.
Bumping the probe contract revision is required when the Codex request contract
materially changes.

## Evidence and promotion

Every probe result, including a failure, replaces the previous result for the
same exact scope under:

```text
$KRUTRIM_CONNECT_HOME/capabilities/krutrim/<scope-sha256>.json
```

The scope hash covers provider ID, fixed base URL, and exact model ID. The file
contains only summaries, HTTP statuses, and observed event type names. It never
contains the API key, request headers, raw SSE, model output, nonces, or response
bodies.

Evidence is:

- written atomically to a private directory with file mode `0600`;
- protected by an HMAC derived from the currently stored model API key;
- valid for 24 hours;
- rejected after key rotation, tampering, expiry, endpoint/model mismatch, or
  probe-contract revision; and
- resolved per model through `ProviderAdapter.capabilitiesFor(...)`, never by
  mutating provider-global flags.

The capability lock serializes login, probing, and activation. `codex on` holds
it from evidence verification through the Codex config transaction, preventing
a concurrent pending/failing probe or credential replacement from racing a
cached passing adapter. `login` refuses rotation while Codex base config is
connected, drifted, or unmanaged.

Capabilities are promoted independently:

| Capability | Promotion requirement |
| --- | --- |
| `responsesApi` | Authenticated canonical Responses text stream |
| `streaming` | Text SSE plus streamed function-argument deltas |
| `toolCalling` | Stable call ID, successful `function_call_output` continuation, and passing isolated installed-Codex native canary |
| `structuredOutput` | Remains `unknown`; not tested here |
| `modelListing` | Remains `unknown`; not tested here |

Timeouts, redirects, authentication failures, rate limits, 4xx schema errors,
5xx responses, and malformed streams never infer `unsupported`; the relevant
capability remains `unknown`. A passing Responses/streaming check can be kept as
partial evidence when the later tool loop or installed-Codex canary fails, but
Codex activation still requires all three required capabilities and the current
canary contract.

After a complete native pass:

```bash
krutrimconnect doctor --model '<exact-model-id>'
krutrimconnect codex on --model '<exact-model-id>'
```

`doctor --model` reads and validates evidence without running inference. When
Codex is already connected, normal `doctor` automatically applies the active
exact-model native or bridge evidence. Both paths remain non-billable and send
no stored credential to the reachability check.

## Internal local-bridge qualification

The activation coordinator invokes this ladder automatically when native
Responses fails after authentication. It uses only the fixed Krutrim Chat
Completions endpoint and performs no
automatic retries. Its ladder is:

1. sequential invalid-token and stored-token controls using model-free `{}`;
2. one non-streaming function call with a bounded nonce argument;
3. one streamed function call requiring exactly one stable call and at least
   one function-argument delta; and
4. one non-streaming continuation containing the assistant tool call and a
   correlated `role: tool` result; and
5. after those checks pass, read the exact model's authenticated Krutrim
   metadata, generate a private startup catalog, and run one ephemeral
   installed-Codex canary through an ephemeral loopback bridge with an isolated
   temporary `CODEX_HOME` and working directory. The catalog selects direct
   function-tool mode and disables freeform apply-patch. The fresh session must
   load that catalog without a fallback-metadata warning, call `exec_command`
   exactly once with `{"cmd":"pwd"}`, accept its correlated result, and return
   the exact marker.

The continuation still runs when the streaming step fails. Consequently,
`streaming-compatible` establishes the real-time bridge path only when the full
Codex canary also returns its exact marker.
`buffered-compatible` records useful diagnostic evidence but does not qualify
for Codex activation because Codex requires streamed function arguments.
Failure before successful non-streaming tool calling and continuation
establishes no usable bridge mode.

Every result replaces the exact model's separate evidence under:

```text
$KRUTRIM_CONNECT_HOME/bridge-capabilities/krutrim/<scope-sha256>.json
```

The file is private, atomic, HMAC-bound to the current credential, valid for 24
hours, and contains only check summaries, HTTP statuses, and numeric stream
observations. It excludes raw JSON/SSE, messages, tool arguments, nonces,
headers, and credentials. Native capability resolution never reads this
directory.

`krutrimconnect codex on --model '<exact-model-id>'` checks native evidence
first, then valid streaming bridge evidence. For bridge mode it starts an
authenticated server on a dynamically allocated `127.0.0.1` port, configures
Codex's normal Responses provider mapping to that endpoint, and translates
messages, function declarations, namespace functions, custom tools, function
calls, correlated tool outputs, text deltas, function-argument deltas, and
custom-tool input events. The managed bridge catalog uses `tool_mode = direct`
and `apply_patch_tool_type = null`, causing Codex shell operations to use an
ordinary JSON function such as `exec_command`; this matches the bridge's
standard Chat function-calling contract. The translator preserves the order of
Codex provider instructions and developer/system items while combining them
into exactly one leading Chat `system` message; this satisfies Krutrim's Chat
message-ordering constraint without dropping an instruction. For Gemma's
observed model-token function wrapper, the translator buffers the full argument
stream, requires the wrapper's tool name to match the declared function, parses
only a bounded JSON-like value grammar, and emits canonical JSON after complete
validation. Duplicate keys, malformed/trailing input, excessive depth, and
oversized content fail closed. Optional
provider-executed web search
declarations are omitted because the managed catalog marks search unsupported
and the fixed Chat upstream cannot execute them. Other unsupported built-in
tools are rejected. A narrow reversible alias for older code-mode custom
`exec` traffic remains bounded to its allowlisted argument object, and
unexpected fields fail closed.

The real Krutrim key stays out of Codex TOML and local HTTP traffic. A
command-backed helper returns an instance-bound derived bearer token; the bridge
reads the stored key and forwards it only to the fixed Krutrim HTTPS Chat
Completions endpoint. Request and stream sizes are bounded, redirects are
disabled, client disconnects cancel the upstream fetch, and raw prompts,
outputs, arguments, headers, and keys are not persisted. `codex off` restores
the exact baseline and stops the bridge. `status` reports the selected mode,
evidence validity, and loopback health.

The automatic bridge is a compatibility path, not proof of every future Codex
tool schema. Qualification now includes a catalog-aware real installed-Codex
deterministic direct `exec_command` canary; evidence from older, generic-shell,
or code-mode canary contracts is rejected. Evidence remains time-bound and must
be refreshed when Codex materially changes its request envelope or adds a
provider-executed built-in tool. The bridge also serves authenticated
`GET /v1/models` with only its bound model so Codex model discovery does not
fall through to a 404.

Activation writes a content-addressed `0600` model catalog under
`$KRUTRIM_CONNECT_HOME/codex/model-catalogs/<config-scope>/` and manages its
absolute path through `model_catalog_json`. The catalog contains only the exact
selected model, uses the authenticated Krutrim deployment context limit, and
replaces the template identity in both base and message instructions. Its hash
is recorded in rollback state and checked by status, update, and disconnect.

## Krutrim-owned acceptance

Before describing the integration as generally supported, the Krutrim API team
should publish or explicitly approve:

1. the `/v1/responses` request and error schema;
2. the SSE lifecycle and function-argument delta contract;
3. supported tool declaration types and call-ID continuation behavior;
4. per-model capability and model-key scope; and
5. rate-limit, cancellation, partial-stream billing, and versioning behavior.

## Live integration test gate

The same core probe is available to CI or a controlled developer environment,
but runs only when all three variables are present:

```bash
KRUTRIM_API_KEY='<hidden>' \
KRUTRIM_PROBE_MODEL='<exact-model-id>' \
KRUTRIM_ALLOW_BILLABLE_PROBES=1 \
npm run test:integration:capabilities
```

The bridge-feasibility integration test has separate opt-in variables:

```bash
KRUTRIM_API_KEY='<hidden>' \
KRUTRIM_BRIDGE_PROBE_MODEL='<exact-model-id>' \
KRUTRIM_ALLOW_BILLABLE_BRIDGE_PROBES=1 \
npm run test:integration:bridge
```

Do not place the key in a committed shell script, test name, fixture, or report.
