# Live E2E Test

This verifies stock Codex can talk to a real upstream model through `pando-proxy`.

The first live test should run with memory disabled so it proves transport, Codex auth forwarding,
request forwarding, response streaming, and logging before testing memory maintenance.

## Prerequisites

- `codex` is installed and logged in.
- Deno is installed.
- Node/npm is installed for `npx` package checks.

No Codex config install is required. The wrapper starts a proxy on a free port, injects Codex
provider overrides for that process only, then runs `codex`.

## Wrapper Pass-Through Test

Run turn one:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-no-memory \
  exec \
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

Run turn two:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-no-memory \
  exec resume \
  --last \
  --json \
  -o /tmp/pando-proxy-turn2.txt \
  "Do not run tools. Reply with exactly: pando proxy live ok turn two"
```

Expected:

```sh
cat /tmp/pando-proxy-turn2.txt
# pando proxy live ok turn two
```

Each wrapper invocation prints:

```text
Pando Proxy log: /Users/you/.pando-proxy/logs/pando-proxy-...jsonl
Pando Proxy URL: http://127.0.0.1:40123/v1
```

The port starts at `40123` and increments until an available port is found. Every wrapper instance
gets its own unique JSONL log file under `~/.pando-proxy/logs` unless `--proxy-log-file` is
supplied.

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

Expected minimum counts in each Codex-call log:

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

Check that secrets were not logged:

```sh
if rg -n 'Bearer |sk-|access_token|refresh_token|id_token' /path/to/log.jsonl; then
  echo "secret-like value found in log"
  exit 1
else
  echo "secret_scan=clean"
fi
```

## `npx` Shape

Once published, the intended user command is:

```sh
npx -y pando-proxy exec "Reply with exactly: pando proxy ok"
```

Proxy-only flags are prefixed so Codex flags pass through cleanly:

```sh
npx -y pando-proxy --proxy-no-memory --proxy-port-start 40130 exec "Reply with ok"
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
  -c 'model_providers.pando-proxy={ name = "Pando Memory Proxy", base_url = "http://127.0.0.1:8787/v1", wire_api = "responses", requires_openai_auth = true }' \
  exec "Reply with exactly: pando proxy manual ok"
```

## Memory-Enabled Follow-Up

After pass-through works, rerun without `--proxy-no-memory`:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  exec \
  --sandbox read-only \
  "Use the proxy with memory enabled."
```

That exercises task-update, tool-result chunking, retention, prompt rewriting, maintenance model
calls, persistence, and upstream forwarding.
