# Context Memory Design

## Overview

The proxy keeps context memory as:

- a live task list
- exact retained pieces linked to those tasks

It does not use summaries anywhere.

## Why This Shape

The prior design made correctness hard to reason about because the system had multiple overlapping abstractions:

- raw history replay
- kept-message summaries
- summarized tool/assistant chunks
- model-based retention

The current design removes those layers.

## Prompt-Side Representation

The rewritten upstream prompt contains a deterministic memory block:

```xml
<pando_task_memory>
<tasks>
- id=task_1 status=open kind=do text="Inspect the proxy"
</tasks>
<piece_index>
task=task_1
- pieceId=piece_17 source=tool tool=mcp__pando__.find_nodes bytes=420 selector=path:["data","results",0] preview="src/server.ts"
</piece_index>
<context_get>
Use context_get with exact pieceIds when you need exact old context.
</context_get>
</pando_task_memory>
```

This is not a summary. It is a structured index of exact pieces already stored locally.

## End-Of-Round Update

After a round completes, the proxy:

1. extracts newly observed content from that round
2. chunks that content into exact pieces
3. runs `round_update`
4. stores only explicitly kept pieces
5. prunes anything no longer linked to a live task

This means task updates are based on the full finished round, including assistant output, rather than a partial pre-response guess.

## Fetch On Demand

The model learns valid `pieceId`s from the piece index.

When it needs old exact context, it issues:

```json
{ "pieceIds": ["piece_17"] }
```

The proxy intercepts `context_get` locally and returns the exact stored payload.

Older exact data is therefore available without being replayed into every upstream request.

## Observability

When logging is enabled, the memory flow around this design is visible in the log:

- which new sources were observed
- how they were chunked into exact pieces
- which pieces were explicitly kept or dropped
- how the live task list changed
- which exact ids were fetched through `context_get`
- what the aggregate stored memory looked like at round end

## Non-Goals

This design intentionally does not include:

- summaries
- pinning
- ranking
- fuzzy lookup
- model-based retention
- background “repair” or “needs more info” loops

The system is designed to be small, explicit, and mechanically checkable.
