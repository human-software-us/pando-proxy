# Context Memory Design

This document describes the target sieve-based memory design.

## Overview

The proxy is a sieve.

Each round:

1. take the prompt/history that would have been sent
2. break it into exact candidate pieces
3. keep only the pieces still worth sending next round
4. drop everything else completely

If something old is needed later, it can be resurrected from the repo, tool reruns, or the user.
The proxy itself does not keep a hidden fallback memory layer.

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
</pando_group_memory>
```

This block is exact surviving memory, not a summary and not a projection.

## Persisted Representation

The manager persists:

- `groups`
- `pieces`
- `processedSourceIds`

There is no separate inline projection and no hidden omitted-piece set.

## Manager Responsibilities

All semantic evaluation must be done by manager LLM calls:

- group lifecycle: continue / redirect / replace / close / start new
- new-piece retention: keep / drop / assign group / supersede
- old-piece pruning: drop previously kept pieces that no longer matter

Deterministic local code must not infer those semantics.

## End-Of-Round Pipeline

1. collect new round sources
2. run `source_chunk_batch` on all new sources
3. materialize exact pieces
4. run `group_intent`
5. run `piece_retention_batch` on all new pieces
6. run `retained_piece_prune` on previously kept pieces
7. deterministically apply the manager outputs
8. persist the resulting state
9. render that exact final kept set into the next prompt

## Failure Policy

Manager calls are strict-schema calls.

For each manager call:

1. parse
2. validate
3. retry once if invalid
4. if still invalid, fail the memory update and keep prior memory unchanged

There is no semantic local fallback.

## Design Intent

The design is intentionally simple:

- one kept set only
- one next-prompt memory set only
- both sets are the same

The proxy reduces the prompt mechanically and semantically, but it does not maintain a second
hidden tier “just in case.”
