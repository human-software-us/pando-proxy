# Memory Operations

This document describes the target sieve-style memory flow.

## 1. Load State

Load:

- active groups
- kept exact pieces
- processed source ids

## 2. Rewrite Request

Rewrite the request using only the currently kept exact pieces.

Keep:

- leading instructions
- current round tail
- the exact surviving memory block

Do not:

- replay full old history
- inject hidden retained memory
- inject a retrieval tool
- locally rank a second inline subset

## 3. Execute The Round

Run upstream normally.

There is no local exact-memory retrieval loop in the target design.

## 4. Collect Round Sources

Collect newly observed:

- user messages
- assistant messages
- tool outputs

Skip already-processed source ids.

## 5. Run Manager Calls

At end of round:

1. run `source_chunk_batch` on all new sources
2. materialize exact pieces
3. run `group_intent`
4. run `piece_retention_batch` on all new pieces
5. run `retained_piece_prune` on previously kept pieces

## 6. Apply Results Deterministically

Local deterministic application should:

- drop pieces in closed/replaced groups where appropriate
- drop superseded pieces
- drop explicitly pruned old pieces
- keep exactly the new pieces marked `keep=true`
- assign `groupId` exactly as returned
- preserve original chronological order as much as possible

No local semantic override belongs here.

## 7. Persist

Persist:

- `groups`
- surviving `pieces`
- `processedSourceIds`

Small exact payloads stay inline. Larger ones spill to `payloadRef`.

## 8. Failure Policy

For each manager call:

1. parse
2. validate
3. retry once if invalid
4. if invalid again, fail the memory update and keep prior memory unchanged

The proxy must log which manager call failed and why.

## 9. Logging

Key events should include:

- `rewritten_context`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

`memory_round_decision` should expose:

- groups before and after
- per-piece keep/drop decisions
- group assignment
- superseded piece ids
- explicitly pruned old-piece ids
