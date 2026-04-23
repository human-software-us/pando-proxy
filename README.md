# pando-proxy

`pando-proxy` is an OpenAI Responses-compatible proxy with a deliberately mechanical memory system.

The current design is:

- one compact live `objective`
- exact retained chunks only
- aggressive end-of-turn pruning
- optional local `memory(offset, limit)` fallback for exact retained chunks that were kept but not inlined this turn
- a separate finalization pass for the clean user-facing answer

The proxy does not maintain prose summaries of prior work and does not expose preview catalogs, selector indexes, or fuzzy retrieval.

## Memory Model

Durable memory is just:

- `objective`
- exact retained `chunks`
- `processedSourceIds`

Each retained chunk stores the original payload inline. There are no blob refs or payload indirection layers in the design.

At the end of each completed round, the proxy takes:

- the previous objective
- the previous kept chunks
- the new exact content observed during that round

and runs one structured `working_memory_update` call that returns:

- `objectiveAfter`
- `keepOldChunkIds`
- `keepNewChunkIds`

Everything else is dropped.

## Prompt Rewrite

The default upstream request is rewritten from:

- leading instructions
- the current live objective
- the exact retained chunks chosen for inline inclusion this turn
- the current round tail

It does not replay older raw history by default and does not inject synthetic preview text.

If the system omits some retained chunks from the prompt for budget reasons, the proxy may expose a local fallback tool:

```json
{ "name": "memory", "arguments": { "offset": 0, "limit": 10 } }
```

That tool returns a chronological list of exact retained chunks that are still live but were not already included in the prompt. It is a transparent fallback, not the main retrieval path.

## Retention Rules

- user messages are kept as exact chunks when still needed
- assistant outputs are chunked exactly
- tool outputs are chunked exactly
- only chunks that still materially support the live objective survive
- exploratory junk should be dropped at round end
- if the objective is complete, memory should become empty

The intended bias is: keep less, not more.

## Final Answering

Work and answer formatting are separate concerns.

The recommended turn shape is:

1. work pass: tools and intermediate steps allowed
2. memory update: keep/drop exact chunks
3. finalization pass: no tools, produce the best user-facing answer from the exact work results

The final answer should match the user request, not the proxy's internal memory fragments.

## Models

The system is intentionally small:

- one required structured model call per completed round: `working_memory_update`
- one structured chunker for assistant and non-Pando tool outputs
- deterministic retention and persistence

The proxy should use the cheap structured model by default and escalate only when size requires it.

## Observability

Logging is off unless a log file is configured.

When enabled, the proxy should log:

- request rewrite metrics
- structured model selection
- round source discovery
- exact chunk materialization
- explicit `working_memory_update` keep/drop decisions
- local `memory` fetches
- saved memory totals
- end-of-round aggregate state in `round_complete`

`round_complete` should include the current objective, chunk ids/count, total stored chunk bytes, processed source count, local fetch counts, and any memory-update error for that round.

## Wrapper Transport Modes

The wrapper has two distinct transport paths:

- `exec` mode points Codex at the local HTTP proxy and exercises `POST /v1/responses`
- interactive mode uses a local Codex app-server plus websocket relay

For fast local live testing against the latest source, prefer:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run src/main.ts ...
```

Use one fixed `--proxy-log-file` and one fixed `--proxy-state-dir` per test session, then run round 1 with `exec` and later rounds with `exec resume --last`. That keeps one multi-round memory session while still starting a fresh proxy process on each round.

## Files

Core files:

- `src/server.ts`
- `src/upstream.ts`
- `src/memory_pipeline.ts`
- `src/prompt_view.ts`
- `src/round_update.ts`
- `src/chunking.ts`
- `src/store.ts`
- `src/structured_model.ts`

Design docs:

- `DESIGN_PRINCIPLES.md`
- `MEMORY_OPERATIONS.md`
- `REFERENCE.md`
- `CONTEXT_MEMORY_DESIGN.md`
- `LIVE_E2E.md`
