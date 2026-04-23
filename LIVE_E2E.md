# Live E2E Test

This verifies stock Codex can talk to a real upstream model through `pando-proxy` and that the current working-memory design behaves correctly under live multi-round use.

## Current Memory Design To Validate

The live design is:

- one compact `objective`
- exact retained chunks only
- aggressive end-of-turn pruning of useless chunks
- optional local `memory(offset, limit)` fallback for exact retained chunks not already in the prompt
- final empty-memory behavior when the work is explicitly over

The main thing to validate is not raw recall volume. It is whether the proxy keeps the right exact evidence and drops the rest.

## Prerequisites

- `codex` is installed and logged in
- Deno is installed

No Codex config install is required. The wrapper starts a proxy on a free port, injects Codex provider overrides for that process only, then runs `codex`.

## Recommended Local Loop

For fast local iteration against the latest code, prefer the Deno wrapper path instead of `npm pack` or `npx`.

Use one fixed `--proxy-log-file` and one fixed `--proxy-state-dir` per test session. That gives you:

- a fresh proxy process on every round
- one durable memory state across rounds in the same test
- deterministic logs and on-disk state for inspection after each round

Round 1:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-test-1.jsonl \
  --proxy-state-dir /tmp/pando-test-1-state \
  exec \
  --sandbox read-only \
  -o /tmp/pando-test-1-r1.txt \
  "your round 1 prompt"
```

Later rounds in the same session:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-test-1.jsonl \
  --proxy-state-dir /tmp/pando-test-1-state \
  exec resume --last \
  -o /tmp/pando-test-1-r2.txt \
  "your next prompt"
```

For a multi-round test, repeat `exec resume --last` with the same log/state paths. For an independent new test, switch to a new log path and new state dir.

## What To Inspect After Each Round

Check:

- `incoming_request`
- `rewritten_context`
- `structured_model_selected`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `memory_fetch`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

Then inspect the persisted state under the chosen `--proxy-state-dir`.

Confirm:

- the current `objective`
- retained chunk ids and count
- total stored chunk bytes
- processed source count
- whether irrelevant chunks were dropped
- whether memory becomes empty when the work is explicitly ended

## Main Live Scenarios

1. Non-Pando carry-forward
2. Pando deterministic chunking
3. Mixed Pando + non-Pando
4. Large exploratory round with aggressive pruning
5. Session completion with empty memory

For any failure:

1. inspect log JSONL
2. inspect persisted state
3. fix the product bug immediately
4. run `deno check src/main.ts`
5. rerun the same session from scratch

## Transport Notes

There are two wrapper paths and they are intentionally different:

- `exec` mode injects a temporary Responses provider that points at the local HTTP proxy
- interactive mode starts a local Codex app-server plus websocket relay

For memory validation of the real proxy request/response loop, prefer `exec` mode unless you are specifically testing the interactive relay.

When inspecting a run, do not treat a log that currently shows only wrapper lifecycle events as proof that the request bypassed the proxy. There can be a delay before the first `incoming_request`. Judge the run only after one of:

- `incoming_request` appears
- `wrapper_exit` appears
- the child process has clearly failed

## Success Criteria

A round is successful when:

- `round_complete` is present
- the persisted state matches the intended objective/chunk set
- unnecessary chunks were dropped
- required exact chunks survived
- the user-facing answer still matches the prompt

A session is successful when:

- memory carries forward correctly across `exec resume --last`
- retrieval fallback, if used, returns exact chronological chunks not already in prompt
- explicit session completion clears the memory state
