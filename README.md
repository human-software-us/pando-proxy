# pando-proxy

`pando-proxy` is an OpenAI Responses-compatible proxy with a deliberately mechanical memory system.

The proxy does not maintain prose summaries of prior work. Instead it keeps:

- a live task list
- exact stored pieces of user, assistant, and tool content that are still required by those live tasks
- a local `context_get` tool for exact fetch-on-demand by piece id

## Memory Model

The durable abstraction of user intent is the task list.

At the end of each completed round, the proxy takes:

- the existing live task list
- the new exact content observed during that round

and runs a single structured `round_update` call that returns:

- the next full live task list
- an explicit keep/drop decision for the new pieces
- task links for every kept piece

Everything else is dropped. Nothing is summarized.

## Piece Rules

- User messages are kept whole.
- Assistant outputs are chunked by a cheap structured-output model and stored exactly.
- Non-Pando tool outputs are chunked by the same structured-output model and stored exactly.
- Pando outputs are split deterministically in code.
- Kept pieces are stored exactly, inline when small and by local blob reference when large.
- If no live task references a piece anymore, it is pruned deterministically.

## Prompt Rewrite

The upstream request is rewritten from:

- leading instructions
- the current live task list
- a deterministic per-task piece index
- the current round tail

The proxy does not replay old raw user history upstream and does not inject any synthetic memory prose.

The piece index includes exact `pieceId`s plus structured locator metadata and exact short previews so the model knows what it can later fetch with `context_get`.

## Local Context Fetch

The proxy injects a local tool:

```json
{ "name": "context_get", "arguments": { "pieceIds": ["piece_1", "piece_2"] } }
```

The tool returns exact stored payloads for those piece ids only. No fuzzy search, ranking, or broad task-scoped lookup exists in v1.

## Models

The system is intentionally small:

- one required structured model call per completed round: `round_update`
- one structured chunker for assistant and non-Pando tool outputs
- deterministic retention and persistence

The default path uses the cheap structured model. The proxy only escalates to the configured overflow model when the serialized structured-input payload exceeds the small model window.

## Observability

Logging is off unless a log file is configured.

When enabled, the proxy logs:

- request rewrite metrics
- structured model selection
- round source discovery
- exact chunk materialization
- explicit `round_update` keep/drop decisions and task transitions
- local `context_get` fetches
- saved memory totals
- end-of-round aggregate state in `round_complete`

`round_complete` includes the current task ids/count, piece ids/count, total stored piece bytes, processed source count, local fetch counts, and any memory-update error for that round.

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
