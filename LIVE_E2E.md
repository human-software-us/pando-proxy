# Live E2E

This repository should be validated with live backend calls, not unit tests.

## Auth

Live auth resolves in this order:

1. `OPENAI_API_KEY`
2. `~/.codex/auth.json` via `tokens.access_token`

If Codex is already logged in, that is usually enough.

## Core Rules

- use real backend calls
- use exact thread ids for every resumed round
- do not trust unit tests
- inspect logs and persisted state after each run

## Recommended Wrapper Loop

Round 1:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-live.jsonl \
  --proxy-state-dir /tmp/pando-live-state \
  exec \
  --sandbox read-only \
  -o /tmp/round1.txt \
  "round 1 prompt"
```

Resume the exact thread id printed by the wrapper:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-live.jsonl \
  --proxy-state-dir /tmp/pando-live-state \
  exec resume 019dc204-22fb-7c50-95ad-2f2508254945 \
  --sandbox read-only \
  -o /tmp/round2.txt \
  "round 2 prompt"
```

Prefer exact thread ids almost always. Treat `--last` as fallback-only.

## What To Inspect

After each round, inspect:

- `memory_round_chunked`
- `memory_round_decision`
- `memory_round_updated`
- `memory_state_saved`
- `structured_model_usage`
- `structured_model_skipped`
- `archive_recall`
- `round_complete`

Also inspect the persisted state under the chosen `--proxy-state-dir`.

## Main Questions

1. Did active memory keep the right exact pieces?
2. Did obsolete pieces get dropped?
3. Did the kept set plateau or stay bounded instead of drifting upward?
4. If `recall` was used, was it because the model actually needed older exact material?
5. Did `recall` stay within the hard cap of 3 calls for that round?
6. Did any round hit `memory_update_failed`?
7. Which classifier actually cost the tokens and time in `internalManagerByClassifier`?
8. Did wrapper stderr print both main-model and manager token summaries at exit?

## Suggested Probe Order

### 1. Focused 3-round probe

Goal:

- confirm the sieve works for a small task
- confirm active memory can often answer without `recall`

Pattern:

1. inspect a couple of files and extract 2-4 exact facts
2. inspect one more file
3. ask for the earlier exact facts without rereading if possible

Expected result:

- often `archiveRecallCount = 0`

### 2. Realistic 8-round probe

Goal:

- mix tool-heavy rounds with no-tool recall rounds
- force the model to decide whether to keep, drop, or recover older facts

Pattern:

1. inspect file A
2. inspect file B
3. inspect file C
4. ask for an earlier fact without rereading if possible
5. inspect file D
6. inspect file E
7. add one explicit token or constraint to preserve
8. ask for several older exact facts at once, allowing `recall`

Expected result:

- `archiveRecallCount` may be 0, 1, 2, or 3 depending on how broad the final ask is
- if it reaches 3, inspect whether the final request truly demanded a broad chronological archive
  walk

## Failure Loop

For any failure:

1. inspect the JSONL log
2. inspect persisted state
3. fix the product bug
4. run `deno check src/main.ts src/replay.ts bin/replay.ts`
5. rerun the same live session from scratch

## Success Criteria

A session is good when:

- every `round_complete.memoryUpdateError` is `null`
- active memory contains only the needed exact pieces
- dropped material is actually obsolete
- `recall` is archive-only and bounded
- the user-facing answer is still correct
