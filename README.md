# pando-proxy

`pando-proxy` is a local Codex wrapper that rewrites each Responses request through a strict
active-task working set.

The important invariant is simple:

- active memory is one active task plus exact kept pieces
- the next forwarded prompt contains that exact kept set
- exact duplicate content is shown once, with duplicate source markers on the canonical kept piece
- dropped material leaves active memory, but raw round sources stay in the per-session archive
- if older exact material is needed later, the agent can use `recall({offset,limit})` against the
  archive, up to 3 times in that round, with no per-call item cap

There are no memory groups, summaries as source material, embeddings, projection layers, hidden
omitted-memory tiers, or retained-state tags. Exact answers must come from visible `pieces` or
archive `recall`.

## Validation Policy

For the active-memory redesign in this repository:

- ignore unit tests completely as product proof
- validate with live E2E runs against the real backend
- inspect logs and persisted state as the primary verification method

Unit tests are still useful for local regressions in the state transition code.

## Current Design

The runtime is built around:

- `activeTask`: the single current executable task and its active piece ids
- `archivedTasks`: previous task bundles, revivable by negative relative index
- `pieces`: exact retained user/assistant reasoning/talk/tool-result/tool-call chunks
- `processedSourceIds`: source ids already seen and archived
- `archive`: raw original sources kept for explicit recovery, not normal prompt memory

Normal end-of-round flow:

1. collect new round sources, including user input, assistant talk/reasoning, tool calls, and tool
   results
2. run `source_chunk_batch` and `task_route` in parallel
   - if chunking omits a requested source or is too large for the structured window, that source is
     kept whole
3. dedupe exact duplicate pieces by content hash while recording duplicate source markers
4. build the routed candidate active set
5. run `piece_drop_batch` over full-payload batches sized under the prune budget
6. keep everything not dropped with an accepted concrete reason
7. persist the active task, archived task bundles, and surviving exact pieces

Normal request flow:

1. load session state
2. materialize active-piece payloads for rendering
3. inject one synthetic `<pando_task_memory>` developer block
4. forward to upstream
5. if the model explicitly calls `recall`, resolve archived sources locally
6. finalize memory after the upstream round completes

## Active Memory vs Archive

These two surfaces are intentionally separate.

Active memory:

- one active task
- exact surviving pieces only
- always shown in the next rewritten prompt
- what survives is exactly what crosses the prompt boundary

Archive:

- raw original round sources on disk
- not part of normal prompt construction
- only reachable through explicit `recall`
- call-count bounded to at most 3 recall calls per round, with no per-call item cap

The archive is a recovery surface, not a second active-memory tier.

## `recall`

The proxy may inject one local function tool:

- name: `recall`
- arguments: `{ offset, limit }`
- max uses per round: `3`
- per-call item cap: none

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

- `incoming_request` with the original Responses body
- `materialized_memory_loaded`
- `rewritten_context` with the original and rewritten bodies
- `upstream_loop_iteration`
- `upstream_request`
- `upstream_response`
- `structured_model_request`
- `structured_model_response`
- `memory_round_chunked`
- `memory_round_decision`
- `memory_round_updated`
- `memory_update_inputs`
- `memory_state_saved`
- `archive_recall`
- `structured_model_usage`
- `structured_model_skipped`
- `round_complete`

`--proxy-log` is the one switch for full proxy data-flow logging. It writes every main-model
request/response, internal structured-model request/response, memory materialization, chunking
input/output, prune decision, archive recall payload, and round summary to JSONL. Use
`--proxy-log-file <path>` when you want a stable path. Direct `serve` mode has equivalent `--log`
and `--log-file` flags. Authorization and token fields are redacted, but user prompts, tool outputs,
model outputs, and retained memory payloads are intentionally present for debugging.

Wrapper stderr also prints at exit:

- estimated input tokens without the proxy
- billed all-in tokens with the proxy
- proxy overhead tokens from internal manager calls

## Repo Map

- [ACTIVE_MEMORY_REDESIGN_PLAN.md](./ACTIVE_MEMORY_REDESIGN_PLAN.md) — implemented target
- [CONTEXT_MEMORY_DESIGN.md](./CONTEXT_MEMORY_DESIGN.md) — one-task sieve design
- [DESIGN_PRINCIPLES.md](./DESIGN_PRINCIPLES.md) — architecture rules
- [WORKING_SET_PRUNE_DESIGN.md](./WORKING_SET_PRUNE_DESIGN.md) — full-payload prune design
- [MEMORY_OPERATIONS.md](./MEMORY_OPERATIONS.md) — round-by-round operations
- [REFERENCE.md](./REFERENCE.md) — concrete runtime types and contracts
- [LIVE_E2E.md](./LIVE_E2E.md) — live validation loop
- [MEMORY_DIAGRAMS.md](./MEMORY_DIAGRAMS.md) — simplified diagrams
- [npm-publishing.md](./npm-publishing.md) — package checks and npm release flow

Key runtime files:

- `src/memory_state.ts`
- `src/memory_pipeline.ts`
- `src/working_set_manager.ts`
- `src/chunking.ts`
- `src/prompt_view.ts`
- `src/upstream.ts`
- `src/store.ts`
- `src/server.ts`

## Benchmarks

Replay and benchmark material remains in this repository, but the benchmark docs are now limited to
current active-task working-set runtime measurements.
