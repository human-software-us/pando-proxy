# Memory Operations

## Round Lifecycle

### 1. Load State

The proxy loads the current session state:

- `tasks`
- kept `pieces`
- `processedSourceIds`

### 2. Rewrite Request

Before the upstream call, the proxy rewrites the request from existing memory only.

It keeps:

- leading instructions
- the current round tail

It inserts:

- a developer message containing the live task list
- a deterministic piece index with exact `pieceId`s and structured pointers
- the local `context_get` tool definition when pieces exist

It does not replay older raw history beyond the current round tail.

### 3. Execute The Round

The proxy runs the upstream request.

If the model emits `context_get`, the proxy:

- validates the requested `pieceId`s against stored pieces
- loads the exact payloads locally
- returns them as local tool outputs
- continues the upstream loop

### 4. Collect New Round Content

At the end of the round, the proxy collects newly observed content:

- new user messages from the request
- new tool outputs present in the request
- assistant messages produced during the upstream/local-tool loop

Already processed source ids are ignored.

### 5. Chunk The New Content

Chunking rules:

- user messages: whole exact piece
- assistant outputs: structured-output chunker
- non-Pando tool outputs: structured-output chunker
- Pando tool outputs: deterministic in-code splitter

The chunker returns selectors, not rewritten text. The proxy materializes exact chunks from the original payload.

### 6. Run `round_update`

`round_update` receives:

- current live tasks
- exact new pieces

It returns:

- `tasksAfter`
- explicit `pieceSelection`
- `keptPieceTaskLinks`

Validation is mechanical and strict.

### 7. Persist

For kept pieces:

- small exact payloads stay inline
- large exact payloads move to local blob refs

For dropped pieces:

- nothing is persisted

Then the proxy prunes any prior kept piece whose `taskIds` no longer intersect the live task set.

## Persistence Layout

Per session:

- `state.json`
- `pieces/*.json` for large payload blobs

State keeps only the latest session snapshot. There is no append-only summary history.

## Logging

When logging is enabled, each completed round should leave behind enough information to debug the memory manager without reconstructing state by hand.

Key events:

- `rewritten_context`
- `structured_model_selected`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `context_get`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

`round_complete` is the compact aggregate checkpoint for the round. It records:

- task ids and task count
- piece ids and piece count
- total stored piece bytes
- processed source count
- local context fetch count and returned ids
- any memory-update error for that round

## Context Fetch

`context_get` accepts:

```json
{ "pieceIds": ["piece_1", "piece_2"] }
```

and returns:

- the exact payload
- the piece id
- source metadata
- selector metadata

No task-wide lookup, fuzzy recall, or ranking exists in v1.
