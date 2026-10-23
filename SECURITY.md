# Security policy

## Reporting a vulnerability

Do not include live API keys, credential files, keychain output, or Codex
snapshots in a public issue. Until a dedicated private reporting channel is
published, open a minimal issue asking the maintainers for a private contact
method and omit exploit details and secrets.

## Credential handling

`krutrimconnect` stores one Krutrim model API key in the OS keychain where a
supported native backend is available. The opt-in POSIX fallback is plaintext
on disk and relies on OS account isolation plus directory mode `0700` and file
mode `0600`. It is disabled on Windows. Native keychain account names contain a
hash of the absolute application-home path, isolating credentials belonging to
different `KRUTRIM_CONNECT_HOME` values without exposing those paths.

Rotate the key in Krutrim KMS if you suspect exposure. Snapshot files may contain
unrelated secrets that were already in Codex config and should be protected as
sensitive backups.

The CLI refuses credential replacement while Codex has connected, drifted, or
unmanaged Krutrim base configuration. Disconnect managed configuration before
rotating the stored key. Login, probing, and activation share a capability lock,
and activation holds that lock through the Codex config transaction.

## Supported security boundary

The CLI protects credentials from config files, normal status/doctor output,
and accidental command-line history. It does not attempt to isolate the key from
other processes already running with the same OS-user privileges.

## Automatic capability qualification

`krutrimconnect codex on --model` and `krutrimconnect opencode on --model`
reuse fresh exact-model evidence when possible. When evidence is missing,
expired, or invalid, activation reports that qualification may be billable and
runs the required checks internally without a separate user-facing probe
workflow. A single activation performs no automatic retry and permits only the
fixed Krutrim HTTPS inference origin. Codex checks native Responses first and
may then run the Chat bridge ladder; OpenCode checks its required bridge route.
After the compact native ladder passes, the CLI builds authenticated exact-model
metadata and runs a fresh installed-Codex subprocess with an isolated temporary
`CODEX_HOME`, a read-only sandbox, and the fixed native Krutrim Responses origin.
The model key is passed only through that subprocess environment and never in
command arguments. The temporary Codex home and any newly created qualification
catalog are removed after the canary. This full-envelope check prevents a small
synthetic pass from qualifying a route that an upstream WAF blocks for real
Codex traffic.
After the small bridge ladder passes, the CLI reads authenticated exact-model
metadata and writes a private content-addressed catalog for an ephemeral
installed-Codex subprocess with an isolated temporary `CODEX_HOME` and working
directory. The subprocess calls the direct `exec_command` function exactly once
with `{"cmd":"pwd"}` and completes its correlated continuation through an
ephemeral loopback bridge. It is read-only and
non-persistent, receives only an instance-bound derived bridge token, and never
receives the real Krutrim key.
The temporary Codex home and catalog are removed after qualification unless the
catalog was already the intact active catalog.
Redirects are never followed. The real credential is sent to each route only
after a dummy-token control establishes safe authentication ordering.

The accepted model requests intentionally match the current Codex envelope and
therefore do not add a probe-only `max_output_tokens` field. The client stops
reading on its time and byte limits, but Krutrim may continue generation and
billing until its own service limit after cancellation. Invoking `on` without
valid cached evidence initiates this qualification and its residual billing
risk.

A requested model ID that contains the stored credential is rejected before a
pending evidence write or network request. Probe reports are redacted before
returning to the CLI, and status/doctor output is redacted with the readable
stored key; status hides the model entirely if the credential backend fails.

Probe reports and model-bound evidence never retain request headers, response
bodies, raw SSE, model output, nonces, or the API key. Evidence is private,
atomic, valid for 24 hours, and HMAC-bound to the current key. Rotating the key
invalidates prior evidence without requiring the old evidence file to be
deleted.

## Local Responses-to-Chat bridge

For an exact model with fresh streaming-compatible bridge evidence,
`codex on` may start a background HTTP service bound only to `127.0.0.1` on a
dynamically allocated port. Codex authenticates with an instance-bound HMAC
token derived from the stored key; the real key is never written to TOML or
sent over loopback. The bridge reads it from the configured credential backend
and sends it only to the fixed Krutrim HTTPS Chat Completions endpoint with
redirects disabled.

Health and shutdown routes require a separate random control token stored only
in the private `0600` runtime record. Responses requests, upstream streams, and
function/custom-tool arguments are bounded and are not persisted. The managed
bridge catalog selects Codex's direct function-tool mode and disables freeform
apply-patch, so the primary shell path uses ordinary bounded JSON function
arguments. Provider instructions and developer/system inputs are combined into
one leading Chat `system` message without changing their order; raw instruction
text is not logged or persisted. Gemma's observed non-JSON tool wrapper is
accepted only by a bounded recursive parser that requires the declared tool
name, rejects duplicate keys and trailing content, and emits canonical JSON
only after the complete argument stream validates. A narrow custom-`exec`
compatibility adapter remains fail-closed for
diagnostics and older clients; arbitrary undeclared tools or fields remain
rejected. Client disconnects abort
the upstream fetch, although upstream cancellation and billing remain controlled
by Krutrim. The authenticated `/v1/models` route exposes only the model bound to
that bridge instance. `codex off` restores the saved configuration before stopping the
bridge. Processes with the same OS-user privileges remain inside the supported
security boundary and can access the user's private runtime state.
