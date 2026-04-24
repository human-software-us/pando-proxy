# Memory Operations

## Wrapper Notes

**Important:** if `npx -y pando-proxy` or an aliased `codex` appears to freeze before the proxy sees any request, Codex may actually be waiting on its own update chooser. Run `npx -y pando-proxy --proxy-run-codex-direct` or `codex --proxy-run-codex-direct` to launch raw Codex with full stdio, make the choice directly in Codex, then rerun the proxied command. Put `--proxy-run-codex-direct` before any Codex args; everything after it is passed straight to raw `codex`.

To remove the installed shell alias later:

```sh
npx -y pando-proxy --uninstall-codex-alias
# or, if the alias is still active in the current shell:
codex --uninstall-codex-alias
```

Wrapper default: `--proxy-codex-auto-compact-token-limit 280000`.

That default is intentionally more generous than the older `50000` / `200000` testing thresholds. `280000` is about 70% of GPT-5's documented `400000` token context window, so Pando gets room to keep normal long sessions below native Codex compaction while still leaving compaction available as a late fallback.

## Round Lifecycle

### 1. Load State

The proxy loads the current session state:

- `objective`
- kept `chunks`
- `processedSourceIds`

### 2. Rewrite Request

Before the upstream call, the proxy rewrites the request from existing memory only.

It keeps:

- leading instructions
- the current round tail

It inserts:

- a developer memory block containing the current objective
- the exact retained chunks selected for inline inclusion
- optionally, the local `memory` tool definition when retained chunks exist outside the inline set

It does not replay older raw history by default.

### 3. Execute The Round

The proxy runs the upstream request.

If the model emits `memory(offset, limit)`, the proxy:

- computes the retained chunk stream that is still live but not already in the prompt
- orders it chronologically
- slices it by `offset` and `limit`
- returns the exact stored payloads locally
- continues the upstream loop

### 4. Collect New Round Content

At the end of the round, the proxy collects newly observed content:

- new user messages from the request
- new tool outputs present in the request
- assistant messages produced during the upstream/local-tool loop

Already processed source ids are ignored.

### 5. Chunk The New Content

Chunking rules:

- user messages: whole exact chunk
- assistant outputs: structured-output chunker
- non-Pando tool outputs: structured-output chunker
- Pando tool outputs: deterministic in-code splitter

The chunker returns selectors, and the proxy materializes exact chunks from the original payload.

### 6. Run `working_memory_update`

`working_memory_update` receives:

- current objective
- current kept chunks
- exact new chunks

It returns:

- `objectiveAfter`
- `keepOldChunkIds`
- `keepNewChunkIds`

Validation is mechanical and strict.

### 7. Persist

For kept chunks:

- store the exact payload inline in state

For dropped chunks:

- remove them from state

There is no payload indirection layer in the current design.

### 8. Finalize

After the work round completes and memory is updated, the proxy may run a final no-tool pass that turns the exact work results into the best user-facing answer for the original request.

## Persistence Layout

Per session:

- `state.json`

State keeps only the latest session snapshot. There is no append-only summary history and no external payload blob store in the intended design.

## Logging

When logging is enabled, each completed round should leave behind enough information to debug the memory manager without reconstructing state by hand.

Key events:

- `rewritten_context`
- `structured_model_selected`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `memory_fetch`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

`round_complete` is the compact aggregate checkpoint for the round. It should record:

- the current objective
- chunk ids and chunk count
- total stored chunk bytes
- processed source count
- local memory fetch count and returned ids
- any memory-update error for that round

## `memory(offset, limit)`

`memory` accepts:

```json
{ "offset": 0, "limit": 10 }
```

and returns:

- exact retained payloads
- in deterministic chronological order
- excluding any retained chunks already present in the prompt

No previews, selector dumps, ranking, or fuzzy lookup exist in this design.
