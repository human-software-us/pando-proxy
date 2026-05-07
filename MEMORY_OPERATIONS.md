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

If `source_chunk_batch` omits a requested source from its result array, the proxy keeps that source
as one whole exact piece. Returned source ids and verbatim chunks still have to validate locally.

If a chunk request is too large for the overflow structured window, the proxy skips the model call
and keeps each requested source whole.

## Chunk contract

Chunking returns verbatim chunk strings. It never returns summaries, labels, content types, boundary
classifications, selectors, character offsets, or model-generated rewrites.

The model should see the exact raw source text it is being asked to chunk, not a JSON-escaped
serialization of that text. The returned chunks must be validated against that same raw source view.
If the prompt representation and materialization representation differ, chunk equality is not
trustworthy and must not be accepted as exact chunks.

The model output for each source is only:

```ts
type SourceChunkBatchResponse = {
  results: Array<{
    sourceId: string;
    chunks: string[];
  }>;
};
```

For `chunks`, every item must be exact text copied from the raw source body. Chunking is lossless:
`chunks.join("")` must equal the complete raw source body exactly. The model may cut anywhere,
including before or after whitespace, but it must not trim, normalize, delete, add, or rewrite any
character. Empty chunks are ignored only after the joined output has passed the exact equality
check.

Local code converts the validated chunk list into persisted `[start,end)` selectors by cumulative
offset. If the model cannot return valid coherent chunks, the source remains one whole exact piece.
Invalid chunk output retries once with diagnostics; if it still cannot be validated, the proxy keeps
that source whole. Opaque payloads such as image/base64-like data should usually be returned as one
chunk containing the entire raw source body.

The chunker never invents semantic split points. It materializes model-selected exact chunks and
keeps the source whole on invalid model output. Large `rg`, test, log, XML, JSON, image-like, or
blob-like payloads stay whole unless the model selects exact chunks that local validation can
materialize.

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
