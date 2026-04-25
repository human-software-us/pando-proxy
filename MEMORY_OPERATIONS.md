# Memory Operations

This document describes the target groups-based memory flow.

## 1. Load State

Load:

- active groups
- retained exact pieces
- persisted `inlinePieceIds`
- processed source ids

## 2. Rewrite Request

Rewrite the request using persisted manager output only.

Keep:

- leading instructions
- current round tail

Insert:

- one developer memory block containing active groups and the exact inline pieces named by
  `inlinePieceIds`
- the local `context_get` tool only when omitted retained pieces exist

Do not:

- replay full old history
- inject semantic summaries
- locally rank which pieces should be inline

## 3. Execute The Round

Run upstream.

If the model emits `context_get`, return exact retained omitted pieces locally and continue the
loop.

## 4. Collect Round Sources

Collect newly observed:

- user messages
- assistant messages
- tool outputs

Skip already-processed source ids.

## 5. Run Batched Manager Calls

At end of round:

1. run `group_intent` on new user-piece previews
2. run `source_chunk_batch` on assistant/tool sources

Those two calls should run in parallel.

Then:

3. materialize exact pieces
4. run `piece_retention_batch` on all new pieces
5. run `prompt_projection` on the resulting retained set

## 6. Apply Results Deterministically

Local deterministic application should:

- drop pieces in closed/replaced groups
- drop superseded pieces
- keep exactly the new pieces marked `keep=true`
- assign `groupId` exactly as returned
- persist exactly the returned `inlinePieceIds`

No local semantic override belongs here.

## 7. Persist

Persist:

- `groups`
- retained `pieces`
- `inlinePieceIds`
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
- `context_get_fetch`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

`memory_round_decision` should expose:

- groups before and after
- per-piece keep/drop decisions
- group assignment
- superseded piece ids
- inline projection ids
