# Live E2E Test

This document describes the live validation loop for the current group-and-piece memory system.

## Memory Design To Validate

The current design to validate is:

- active group metadata for incremental routing and cleanup
- exact retained pieces only in prompt memory
- aggressive end-of-turn pruning through manager calls
- optional local `context_get` fallback for exact retained pieces not already in the prompt
- empty-memory behavior when work is explicitly over or replaced

The main thing to validate is not raw recall volume. It is whether the proxy keeps the right exact
evidence for the still-active groups and drops the rest.

## Prerequisites

- `codex` is installed and logged in
- Deno is installed

Auth for the live harness resolves in this order:

- `OPENAI_API_KEY`, if set
- `~/.codex/auth.json` via `tokens.access_token`

So if Codex is already logged in, live manager/backend calls should work without extra setup.

**Important:** if `pando-proxy` or an aliased `codex` looks frozen before the proxy ever receives a
request, Codex may be blocked on its own update-selection prompt. In that case run raw Codex with
`npx -y pando-proxy --run-codex-direct` or `codex --run-codex-direct`, make the update choice
directly in Codex, then rerun the proxy test.

No Codex config install is required. The wrapper starts a proxy on a free port, injects Codex
provider overrides for that process only, then runs `codex`.

## Recommended Local Loop

For fast local iteration against the latest code, prefer the Deno wrapper path instead of `npm pack`
or `npx`.

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
  --sandbox read-only \
  -o /tmp/pando-test-1-r2.txt \
  "your next prompt"
```

## What To Inspect After Each Round

Check:

- `incoming_request`
- `rewritten_context`
- `structured_model_selected`
- `codex_exec_turn_summary` for interactive runs
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `context_get_fetch`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

Then inspect the persisted state under the chosen `--proxy-state-dir`.

Confirm:

- active group ids and their statuses
- retained piece ids and count
- `codex_exec_turn_summary` counts line up with the round: tool calls, tool results, reasoning,
  assistant messages, user messages, and observed tool names
- total stored piece bytes
- processed source count
- whether irrelevant pieces were dropped
- whether closed or replaced groups were removed

## Main Live Scenarios

1. Continue the same task across rounds
2. Redirect the same task with "do it differently"
3. Replace the old task with unrelated work
4. Use tool results that later become superseded
5. Explicitly close the session and clear all retained memory

For any failure:

1. inspect log JSONL
2. inspect persisted state
3. fix the product bug immediately
4. run `deno check src/main.ts`
5. rerun the same session from scratch

## Success Criteria

A round is successful when:

- `round_complete` is present
- the persisted state matches the intended task/piece set
- unnecessary pieces were dropped
- required exact pieces survived
- the user-facing answer still matches the prompt

A session is successful when:

- group routing remains stable across `exec resume --last`
- retrieval fallback, if used, returns exact chronological pieces not already in prompt
- explicit completion or replacement clears obsolete retained memory
