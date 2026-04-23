# Design Principles

## 1. Tasks Are The Only Durable Intent Abstraction

The proxy does not preserve user intent as replayed raw history or as summaries.

The durable representation of user intent is the live task list.

## 2. Exact Pieces Only

All retained memory outside the task list is exact content:

- exact whole user messages
- exact assistant chunks
- exact tool chunks

There are no summary fields, no synthetic prose memory blocks, and no renamed summary concept hiding under a different key.

## 3. End-Of-Round Update

Memory updates run once per completed round, not continuously.

Input to the round update:

- existing live tasks
- exact new content from the completed round

Output from the round update:

- full replacement live task list
- explicit keep/drop decision for the new pieces
- task links for every kept piece

## 4. Explicit Keep/Drop

The model must explicitly say what happened to the new pieces.

The keep/drop selection is one of:

- `drop_all`
- `keep_all`
- `keep_only`
- `drop_only`

This avoids implicit “anything not mentioned must be dropped” behavior.

## 5. Deterministic Retention

Retention is code, not another model pass.

If a kept piece no longer has any live task reference, it is removed.

If a stored payload is too large for inline state storage, it is moved to a local blob file by deterministic store code.

## 6. No Upstream Summary Injection

The proxy does not build or inject synthetic `<context_memory>` prose.

The upstream context is built from:

- leading instructions
- the live task list
- the deterministic piece index
- the current round tail

## 7. Fetch Exact Context On Demand

Old exact context is not replayed every turn.

The model can fetch exact prior pieces only through `context_get(pieceIds: string[])`.

The prompt-side piece index exists specifically so the model knows which exact ids are valid and roughly what they contain.

## 8. Cheap By Default

The system uses cheap structured-output calls by default.

Escalation is size-based only:

- use the small configured structured model when the request fits
- use the smallest configured overflow model only when needed for context size

There are no repair loops, ranking passes, retention passes, or “needs more info” side channels.

## 9. Observable When Enabled

When logging is enabled, the proxy should make the round mechanically inspectable.

At minimum the logs should show:

- the rewritten request shape
- structured model selection
- new round sources
- exact chunking output
- `round_update` task transitions
- explicit keep/drop decisions
- local `context_get` requests and returned ids
- end-of-round aggregate memory state
