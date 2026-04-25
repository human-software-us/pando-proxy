# Context Memory Design

This document describes the target groups-based memory design.

## Overview

The proxy keeps memory as:

- active groups for semantic routing and lifecycle
- exact retained pieces linked to one group each
- a persisted inline projection for prompt inclusion

The main model sees exact pieces only plus a compact list of active groups.

## Prompt-Side Representation

```xml
<pando_group_memory>
<groups>
- groupId=group:token status=active label=remember-token summary=Preserve exact token BLUE-...
</groups>
<exact_pieces>
<piece pieceId=piece_17 groupId=group:token sourceKind=user>
remember this exact token: BLUE-123
</piece>
</exact_pieces>
<context_get>
Use context_get({pieceIds:[...]}) when you know the ids.
Use context_get({offset,limit}) to browse omitted retained exact pieces.
If the exact answer is already visible above, answer from it directly.
</context_get>
</pando_group_memory>
```

This block is exact memory, not a summary.

## Persisted Representation

The manager persists:

- `groups`
- `pieces`
- `inlinePieceIds`
- `processedSourceIds`

Groups are control-plane state. Pieces are exact evidence. Inline projection is a manager-chosen
prompt projection, not a local heuristic.

## Manager Responsibilities

All semantic evaluation must be done by manager LLM calls:

- group lifecycle: continue / redirect / replace / close / start new
- piece retention: keep / drop / assign group / supersede / visibility
- prompt projection: which retained exact pieces should be inline

Deterministic local code must not infer those semantics.

## End-Of-Round Pipeline

1. collect new round sources
2. run `group_intent` on new user-piece previews
3. run `source_chunk_batch` on assistant/tool sources
4. materialize exact pieces
5. run `piece_retention_batch` on all new pieces
6. deterministically apply the manager outputs
7. run `prompt_projection`
8. persist the resulting state

`group_intent` and `source_chunk_batch` should run in parallel.

## Failure Policy

Manager calls are strict-schema one-shot calls.

For each manager call:

1. parse
2. validate
3. retry once if invalid
4. if still invalid, fail the memory update and keep prior memory unchanged

There is no semantic local fallback.

## `context_get`

`context_get` is a local exact retrieval fallback only.

It may fetch:

- known exact piece ids
- chronological pages of retained omitted pieces

It must not:

- rank semantically
- search fuzzily
- synthesize summaries

## Design Intent

The design is intentionally split into:

- semantic control-plane decisions by manager LLM calls
- deterministic exact-data handling by local code

That keeps prompts small, keeps memory exact, and avoids local semantic heuristics.
