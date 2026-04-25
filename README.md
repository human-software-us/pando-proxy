# pando-proxy

`pando-proxy` is a local Codex wrapper that rewrites each Responses request through a strict
active-memory sieve.

The important invariant is simple:

- active memory is the exact kept piece set
- the next forwarded prompt contains that exact kept set
- anything not kept is dropped from active memory completely
- if older exact material is needed later, the agent can use `recall({offset,limit})` against the
  per-session archive, up to 3 times in that round

There is no projection layer, no hidden omitted-memory tier, and no summary/embedding memory.

## Validation Policy

For the active-memory redesign in this repository:

- ignore unit tests completely
- do not use unit tests as a correctness signal
- validate with live E2E runs against the real backend
- inspect logs and persisted state as the primary verification method

## Current Design

The runtime is built around:

- `groups`: compact semantic buckets managed only by structured LLM calls
- `pieces`: exact retained user/assistant/tool chunks
- `processedSourceIds`: source ids already seen and archived
- `archive`: raw original sources kept only for bounded recovery, not for normal prompt memory

Normal end-of-round flow:

1. collect new round sources
2. run `source_chunk_batch` and `group_intent` in parallel
3. `piece_retention_batch`
4. `retained_piece_prune`
5. persist the surviving exact pieces

Normal request flow:

1. load session state
2. materialize active-piece payloads for rendering
3. inject one synthetic developer memory block
4. forward to upstream
5. if the model explicitly calls `recall`, resolve archived sources locally
6. finalize memory after the upstream round completes

## Active Memory vs Archive

These two surfaces are intentionally separate.

Active memory:

- exact surviving pieces only
- always shown in the next rewritten prompt
- what survives is exactly what crosses the prompt boundary

Archive:

- raw original round sources on disk
- not part of normal prompt construction
- only reachable through explicit `recall`
- bounded to at most 3 recall calls per round

The archive is a recovery surface, not a second active-memory tier.

## `recall`

The proxy may inject one local function tool:

- name: `recall`
- arguments: `{ offset, limit }`
- max uses per round: `3`

Guidance injected to the model:

- prefer answering from active memory first
- use `recall` only when exact needed material is not visible in active memory
- when using it, err on requesting more archive coverage rather than too little

The tool result explicitly marks returned content as archive content and includes:

- `requestedOffset`
- `requestedLimit`
- `returnedCount`
- `remainingArchivedSourceCount`
- exact archived source payloads

## Quickstart

Requires:

- Deno
- Codex on `PATH`
- Codex already logged in

Typical use:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  exec \
  --sandbox read-only \
  "inspect this repo"
```

Resume with the exact thread id printed by the wrapper:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  exec resume 019dc204-22fb-7c50-95ad-2f2508254945 \
  --sandbox read-only \
  "continue"
```

Prefer exact thread ids almost always. `--last` should be treated as fallback-only.

## Auth

Live calls resolve auth in this order:

1. `OPENAI_API_KEY`
2. `~/.codex/auth.json` via `tokens.access_token`

If Codex is already logged in, that is usually enough.

## Live E2E Workflow

For real validation, use one fixed state dir and one fixed log file per session:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-test.jsonl \
  --proxy-state-dir /tmp/pando-test-state \
  exec \
  --sandbox read-only \
  -o /tmp/round1.txt \
  "round 1 prompt"
```

Then resume the same exact thread id:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-test.jsonl \
  --proxy-state-dir /tmp/pando-test-state \
  exec resume 019dc204-22fb-7c50-95ad-2f2508254945 \
  --sandbox read-only \
  -o /tmp/round2.txt \
  "round 2 prompt"
```

Inspect after each run:

- `memory_round_chunked`
- `memory_round_decision`
- `memory_round_updated`
- `memory_state_saved`
- `archive_recall`
- `structured_model_usage`
- `structured_model_skipped`
- `round_complete`

Wrapper stderr now also prints at exit:

- estimated input tokens without the proxy
- billed all-in tokens with the proxy
- proxy overhead tokens from internal manager calls

## Repo Map

- [ACTIVE_MEMORY_REDESIGN_PLAN.md](./ACTIVE_MEMORY_REDESIGN_PLAN.md) — implementation target
- [CONTEXT_MEMORY_DESIGN.md](./CONTEXT_MEMORY_DESIGN.md) — one-tier sieve design
- [DESIGN_PRINCIPLES.md](./DESIGN_PRINCIPLES.md) — architecture rules
- [MEMORY_OPERATIONS.md](./MEMORY_OPERATIONS.md) — round-by-round operations
- [REFERENCE.md](./REFERENCE.md) — concrete runtime types and contracts
- [LIVE_E2E.md](./LIVE_E2E.md) — live validation loop
- [MEMORY_DIAGRAMS.md](./MEMORY_DIAGRAMS.md) — simplified diagrams
- [npm-publishing.md](./npm-publishing.md) — package checks and npm release flow

Key runtime files:

- `src/memory_state.ts`
- `src/memory_pipeline.ts`
- `src/group_manager.ts`
- `src/chunking.ts`
- `src/prompt_view.ts`
- `src/upstream.ts`
- `src/store.ts`
- `src/server.ts`

## Benchmarks

Replay and benchmark material remains in this repository, but treat the docs above as the source of
truth for the shipped active-memory runtime. Historical benchmark docs may discuss earlier designs.
