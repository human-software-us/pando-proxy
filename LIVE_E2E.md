# Live E2E Test

This verifies stock Codex can talk to a real upstream model through the local proxy.

The first live test should run with memory disabled so it proves transport, auth forwarding, request
forwarding, and SSE passthrough before testing memory maintenance.

## Prerequisites

- `codex` is installed and logged in.
- Deno is installed.
- Port `8787` is free.

Check:

```sh
command -v codex
test -f "${CODEX_HOME:-$HOME/.codex}/auth.json"
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

## Install Codex Profile

```sh
deno run --allow-env --allow-read --allow-write src/main.ts install
```

This writes a `pando-memory` profile using:

```toml
[profiles.pando-memory]
model_provider = "pando-proxy"

[model_providers.pando-proxy]
name = "Pando Memory Proxy"
base_url = "http://127.0.0.1:8787/v1"
wire_api = "responses"
requires_openai_auth = true
```

With `requires_openai_auth = true`, Codex sends its existing auth as an `Authorization` header to
the proxy. The proxy log redacts that header.

## Start Proxy

```sh
rm -f /tmp/pando-proxy-live.jsonl

deno run --allow-net --allow-env --allow-read --allow-write \
  src/main.ts serve \
  --no-memory \
  --log-file /tmp/pando-proxy-live.jsonl
```

Keep this process running. `--no-memory` bypasses task update, chunking, retention, and prompt
injection so the test proves baseline pass-through behavior.

Optional monitor:

```sh
tail -f /tmp/pando-proxy-live.jsonl
```

## Turn One

In another terminal:

```sh
codex exec \
  --profile pando-memory \
  --sandbox read-only \
  --json \
  -o /tmp/pando-proxy-turn1.txt \
  "Do not run tools. Reply with exactly: pando proxy live ok turn one"
```

Expected:

```sh
cat /tmp/pando-proxy-turn1.txt
# pando proxy live ok turn one
```

## Turn Two

Resume the previous Codex session and force the proxy provider again:

```sh
codex exec resume \
  --last \
  -c 'model_provider="pando-proxy"' \
  --json \
  -o /tmp/pando-proxy-turn2.txt \
  "Do not run tools. Reply with exactly: pando proxy live ok turn two"
```

Expected:

```sh
cat /tmp/pando-proxy-turn2.txt
# pando proxy live ok turn two
```

Why the explicit `-c` matters: `codex exec --profile pando-memory ...` applies the profile to that
new exec invocation, but `codex exec resume --last ...` does not accept `--profile` as a
resume-scoped flag in the tested CLI. A root-level profile on
`codex --profile pando-memory exec
resume ...` can still resume a rollout whose saved provider is
the original default provider. The reliable resume command is therefore to pass the provider
override directly to the resume invocation with `-c 'model_provider="pando-proxy"'`.

## Verify Proxy Log

```sh
node - <<'NODE'
const fs = require("fs");
const lines = fs.readFileSync("/tmp/pando-proxy-live.jsonl", "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map(JSON.parse);
const counts = {};
for (const event of lines) counts[event.event] = (counts[event.event] || 0) + 1;
console.log(JSON.stringify(counts, null, 2));
NODE
```

Expected minimum counts after two turns:

```json
{
  "incoming_request": 2,
  "upstream_request": 2,
  "upstream_response_start": 2,
  "upstream_response_end": 2
}
```

Check that secrets were not logged:

```sh
if rg -n 'Bearer |sk-|access_token|refresh_token|id_token' /tmp/pando-proxy-live.jsonl; then
  echo "secret-like value found in log"
  exit 1
else
  echo "secret_scan=clean"
fi
```

## Stop Proxy

Press `Ctrl-C` in the proxy terminal.

Confirm:

```sh
lsof -nP -iTCP:8787 -sTCP:LISTEN
```

No output means the proxy stopped.

## Memory-Enabled Follow-Up

After pass-through works, rerun without `--no-memory`:

```sh
deno run --allow-net --allow-env --allow-read --allow-write \
  src/main.ts serve \
  --log-file /tmp/pando-proxy-memory-live.jsonl
```

That exercises task-update, tool-result chunking, retention, prompt rewriting, maintenance model
calls, persistence, and upstream forwarding.
