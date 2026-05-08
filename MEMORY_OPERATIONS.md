# Memory Operations

## Start of request

1. load session state
2. materialize active piece payloads for prompt rendering
3. inject `<pando_task_memory>`
4. inject `recall` only if archived sources exist outside active memory
5. forward upstream

## During response

If the model calls `recall({offset,limit})`:

1. resolve archived source ids not currently active
2. return exact archived payloads
3. include `remainingArchivedSourceCount`
4. allow any requested per-call item count
5. cap at 3 recalls in that round

## End of round

1. extract new sources
2. chunk non-user assistant talk/reasoning and tool-result sources with `source_chunk_batch`; each
   user message is kept as one inseparable `whole` piece
3. decide `same_task` vs `new_task` vs `revive_task(relativeIndex)` with `task_route`
4. materialize exact new pieces
5. apply the task route
6. for `same_task` and `revive_task`, collapse exact duplicate new pieces before prune, recording
   duplicate source markers on the canonical kept piece
7. build the candidate active set
8. ask `piece_drop_batch` about bounded full-payload batches
9. keep all pieces that are not dropped with an accepted concrete reason, and reject non-structural
   drops that would leave only assistant output when non-assistant evidence existed
10. collapse surviving exact duplicates; on `new_task`, old/new duplicate collapse is deferred until
    after prune and prefers the new piece as canonical
11. archive raw round sources
12. persist the active task title, archived task bundles, and surviving exact pieces

User-message and tool-call sources are chunked as whole pieces. They are still eligible for later
full-payload prune decisions; nothing is protected forever.

Task routing receives the active task title, full exact active pieces, full new user messages, and
only a five-card newest-first archive page. It can request the next linear page when older archived
task titles are needed for `revive_task`.

If a chunk request is too large for the overflow structured window, the proxy skips the model call
and keeps each requested source whole. Per-item failure is isolated: a malformed item's response
cannot break parsing of the others — it just leaves that item unchanged for the round.

## Chunk contract

Chunking is **iterative outline+anchor commitment**, never verbatim-chunk return. The model never
reproduces source bytes; verbatim is a property of slicing the original source text locally.

State is a list of chunks, initialized as one chunk per source (the whole source). Each round, every
current chunk is sent to `source_chunk_batch` as an item in one batched call. The model returns, per
item, a section outline:

```ts
type SourceChunkBatchResponse = {
  results: Array<
    | { itemId: string; sections: Array<{ label: string; anchor: string }> }
    | { itemId: string; error: string }
  >;
};
```

Each `label` is a 3–8 word semantic description; each `anchor` is a 5–7 word verbatim prefix copied
exactly from the start of that section in the item's text. Anchors are cut points — the slice from
one anchor to the next becomes one sub-chunk.

Local code resolves anchors against the item's text using forward-sequential `indexOf`. Each anchor
is searched only after the previous resolved position. A failed anchor drops just that cut and the
others apply. The prefix before the first resolved anchor is preserved (extended to position 0).
Resulting sub-chunks are converted to `[start,end)` selectors relative to the original source.

The model is instructed: each section will be evaluated independently for keep/drop in the active
working set, so each section should be a self-standing keep/drop decision. If two adjacent sections
would always travel together, they should be one section. Atomic content (encrypted blobs, minified
streams, opaque payloads, small already-coherent units) returns a single section. The model never
returns an empty sections array.

The orchestrator (`chunkBatchWithModel`) runs up to 7 rounds. It terminates early when a whole round
produces zero real splits (a real split = item replaced by ≥2 sub-chunks). Item boundaries set in an
earlier round are never undone — chunk count is monotonically non-decreasing across rounds. There is
no size threshold; every chunk is re-evaluated every round until the model declines to split it.

Empty-text spans (e.g., a tool that produced no output) are short-circuited locally — they become a
single empty chunk without burning a model call.

Final per-source verbatim check: the concatenation of a source's final chunks must equal the
original source text. On any mismatch the chunker falls back to whole for that source only. This is
the verbatim safety net: any drift from anchor resolution is caught before chunks reach downstream
code.

Per-round telemetry is emitted via `setChunkRoundLogger(fn)`: round number, item count, item sizes,
real splits, item errors, per-item section counts, resulting chunk count, largest resulting chunk,
duration. Replay and serve modes both forward this telemetry to the JSONL log.

On `new_task`, the old task identity is always archived as a complete task bundle. The old active
pieces are still included as prune candidates for the fresh task, so pieces that remain relevant can
be rescued into the new active task. Rescued pieces are exact shared pieces: they remain in the
archived old task bundle and are also active under the new task.

If the prune call fails during `new_task`, the old task bundle is still archived and the candidate
pieces are kept under the new task. This may save fewer tokens, but it avoids losing context.

On `revive_task(-N)`, the current active task is archived and the selected previous task bundle is
restored as the active candidate set. New round pieces are then evaluated with the revived pieces.

If the requested revive index does not exist, the proxy keeps the current active task and treats the
round as `same_task`.

## Failure policy

- `task_route` invalid after retry -> use `same_task`
- `revive_task(relativeIndex)` points at no archived task -> use `same_task`
- `piece_drop_batch` invalid after retry -> keep all pieces evaluated by that failed batch
- `piece_drop_batch` would leave only assistant pieces after non-structural drops while
  non-assistant evidence was available -> reject the non-structural drops and keep that evidence
- `source_chunk_batch` omits requested source -> keep that source whole
- `source_chunk_batch` exceeds the overflow structured window -> keep the whole batch as whole
  sources
- `source_chunk_batch` fails or returns malformed source ids/chunks after retry -> keep requested
  sources whole
- failed memory update -> keep prior memory unchanged
- log failures and the full data flow when proxy logging is enabled
