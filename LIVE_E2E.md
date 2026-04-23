# Live E2E Test

This verifies stock Codex can talk to a real upstream model through `pando-proxy`.

The first live test should run with memory disabled so it proves transport, Codex auth forwarding,
request forwarding, and response streaming before testing memory maintenance.

## Prerequisites

- `codex` is installed and logged in.
- Deno is installed.
- Node/npm is installed for `npx` package checks.

No Codex config install is required. The wrapper starts a proxy on a free port, injects Codex
provider overrides for that process only, then runs `codex`.

## Exec JSON Transport Tests

Run a memory-disabled first turn. The wrapper will inject `--json` if it is missing:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log \
  --proxy-no-memory \
  exec \
  --sandbox read-only \
  -o /tmp/pando-proxy-turn1.txt \
  "Do not run tools. Reply with exactly: pando proxy live ok turn one"
```

Expected:

```sh
cat /tmp/pando-proxy-turn1.txt
# pando proxy live ok turn one
```

Run turn two:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log \
  --proxy-no-memory \
  exec resume \
  --last \
  -o /tmp/pando-proxy-turn2.txt \
  "Do not run tools. Reply with exactly: pando proxy live ok turn two"
```

Expected:

```sh
cat /tmp/pando-proxy-turn2.txt
# pando proxy live ok turn two
```

When `--proxy-log` or `--proxy-log-file` is set, each wrapper invocation prints:

```text
Pando Proxy log: /Users/you/.pando-proxy/logs/pando-proxy-...jsonl
Pando Proxy URL: http://127.0.0.1:40123/v1
```

The port starts at `40123` and increments until an available port is found. Logging is disabled by
default. `--proxy-log` creates a unique JSONL log file under `~/.pando-proxy/logs`;
`--proxy-log-file` writes to the specified path.

## Per-Mode Smoke Matrix

Use fixed log files when you want deterministic inspection.

Exec mode:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-e2e-mode-exec-1.jsonl \
  --proxy-no-memory \
  exec "Reply exactly PANDO_MODE_EXEC_1."

deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-e2e-mode-exec-2.jsonl \
  --proxy-state-dir /tmp/pando-e2e-mode-state-exec-2 \
  exec "Reply exactly PANDO_MODE_EXEC_2."
```

Expected stdout includes `item.completed` agent messages with the exact requested text and a
`turn.completed` event with token usage.

Interactive mode:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-e2e-mode-interactive-1.jsonl \
  --proxy-no-memory \
  --no-alt-screen \
  "Reply exactly PANDO_MODE_INTERACTIVE_1."

deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-e2e-mode-interactive-2.jsonl \
  --proxy-state-dir /tmp/pando-e2e-mode-state-interactive-2 \
  --no-alt-screen \
  "Reply exactly PANDO_MODE_INTERACTIVE_2."
```

Expected TUI output includes the exact requested text. Stop the TUI with `Ctrl-C` after the
response. Logs should include `turn/start`, `item/completed` for the user and agent messages,
`thread/tokenUsage/updated`, and `turn/completed`.

Passthrough mode:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-e2e-mode-passthrough-1.jsonl \
  help exec

deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-e2e-mode-passthrough-2.jsonl \
  --version
```

Expected stdout is the normal Codex help/version output. These utility commands generally do not
make upstream model requests, so their logs should show wrapper lifecycle events but no
`incoming_request`.

## Verify Logs

Use the log paths printed by the two runs:

```sh
node - <<'NODE' /path/to/first-log.jsonl /path/to/second-log.jsonl
const fs = require("fs");
for (const file of process.argv.slice(2)) {
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const counts = {};
  for (const event of lines) counts[event.event] = (counts[event.event] || 0) + 1;
  console.log(file);
  console.log(JSON.stringify(counts, null, 2));
}
NODE
```

Expected minimum counts in each model-call log:

```json
{
  "wrapper_start": 1,
  "incoming_request": 1,
  "upstream_request": 1,
  "upstream_response_start": 1,
  "upstream_response_end": 1,
  "wrapper_exit": 1
}
```

For exec-mode JSONL observation:

```sh
jq -r 'select(.event=="codex_exec_event" or .event=="wrapper_exit") |
  [.ts,.event,.eventType,(.payload.item.text // ""),(.payload.usage.input_tokens // ""),
   (.payload.usage.cached_input_tokens // ""),(.payload.usage.output_tokens // ""),
   (.success // ""),(.code // "")] | @tsv' \
  /tmp/pando-e2e-mode-exec-1.jsonl /tmp/pando-e2e-mode-exec-2.jsonl
```

For interactive app-server relay observation:

```sh
jq -r 'select(.event=="codex_app_server_frame" or .event=="wrapper_exit") |
  [.ts,.event,(.direction // ""),(.method // ""),(.itemType // ""),
   (.payload.params.item.text // ""),
   (.payload.params.tokenUsage.total.inputTokens // ""),
   (.payload.params.tokenUsage.total.cachedInputTokens // ""),
   (.payload.params.tokenUsage.total.outputTokens // ""),
   (.success // ""),(.code // "")] | @tsv' \
  /tmp/pando-e2e-mode-interactive-1.jsonl /tmp/pando-e2e-mode-interactive-2.jsonl
```

For passthrough lifecycle checks:

```sh
jq -r 'select(.event=="wrapper_start" or .event=="wrapper_codex_start" or .event=="wrapper_exit") |
  [.ts,.event,.mode,(.success // ""),(.code // "")] | @tsv' \
  /tmp/pando-e2e-mode-passthrough-1.jsonl /tmp/pando-e2e-mode-passthrough-2.jsonl
```

The log intentionally preserves request and response payloads as received. Only explicit credential
fields such as `authorization`, `access_token`, `refresh_token`, `id_token`, and API-key fields are
redacted.

```sh
node - <<'NODE' /path/to/log.jsonl
const fs = require("fs");
for (const file of process.argv.slice(2)) {
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.headers?.authorization && event.headers.authorization !== "[redacted]") {
      throw new Error(`${file}: authorization header was not redacted`);
    }
  }
}
console.log("credential_fields_redacted=ok");
NODE
```

## `npx` Shape

Once published, the intended user command is:

```sh
npx -y pando-proxy exec "Reply with exactly: pando proxy ok"
```

Proxy-only flags are prefixed so Codex flags pass through cleanly:

```sh
npx -y pando-proxy --proxy-no-memory --proxy-port-start 40130 exec "Reply with ok"
npx -y pando-proxy --proxy-log exec "Reply with logged ok"
```

Use `--` if a Codex argument ever has the same spelling as a proxy flag:

```sh
npx -y pando-proxy --proxy-no-memory -- --proxy-no-memory
```

Before publishing, test the packed npm artifact locally:

```sh
npm pack
npx -y ./pando-proxy-0.1.0.tgz --proxy-help
npx -y ./pando-proxy-0.1.0.tgz --proxy-no-memory exec "Reply with exactly: packed npx ok"
```

## Manual Serve Mode

For debugging without the wrapper:

```sh
deno run --allow-net --allow-env --allow-read --allow-write \
  src/main.ts serve \
  --no-memory \
  --log-file /tmp/pando-proxy-live.jsonl
```

Then run Codex manually with equivalent provider overrides:

```sh
codex \
  -c 'model_provider="pando-proxy"' \
  -c 'model_providers.pando-proxy.name="Pando Memory Proxy"' \
  -c 'model_providers.pando-proxy.base_url="http://127.0.0.1:8787/v1"' \
  -c 'model_providers.pando-proxy.wire_api="responses"' \
  -c 'model_providers.pando-proxy.requires_openai_auth=true' \
  exec "Reply with exactly: pando proxy manual ok"
```

## Memory-Enabled Follow-Up

After pass-through works, rerun without `--proxy-no-memory`:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log \
  exec \
  --sandbox read-only \
  "Use the proxy with memory enabled."
```

That exercises task-update, tool-result chunking, retention, prompt rewriting, maintenance model
calls, assistant-response review on the next request, persistence, and upstream forwarding.

For more detailed memory/logging expectations, including SSE maintenance parsing, stream
cancelation, eager retention, and resume coverage, see
[MEMORY_OPERATIONS.md](./MEMORY_OPERATIONS.md).
