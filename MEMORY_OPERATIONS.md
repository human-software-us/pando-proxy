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
2. chunk non-Pando user, assistant talk/reasoning, and tool-result sources with `source_chunk_batch`
3. decide `same_task` vs `new_task` vs `revive_task(relativeIndex)` with `task_route`
4. materialize exact new pieces
5. dedupe exact duplicate pieces by content hash
6. build the candidate active set from the route
7. ask `piece_drop_batch` about bounded full-payload batches
8. keep all pieces that are not dropped with an accepted concrete reason
9. archive raw round sources
10. persist the active task, archived task bundles, and surviving exact pieces

Tool-call sources are chunked as whole pieces. They are still eligible for later full-payload prune
decisions; nothing is protected forever.

If `source_chunk_batch` omits a requested source from its result array, the proxy keeps that source
as one whole exact piece. Returned source ids and selectors still have to validate locally.

If a chunk request is too large for the overflow structured window, the proxy skips the model call
and keeps each requested source whole.

On `new_task`, the old active working set is paged out of active memory. The raw sources remain in
the archive and can be recovered through `recall`.

On `revive_task(-N)`, the current active task is archived and the selected previous task bundle is
restored as the active candidate set.

## Failure policy

- `task_route` invalid after retry -> use `same_task`
- `piece_drop_batch` invalid after retry -> keep all pieces evaluated by that failed batch
- `source_chunk_batch` omits requested source -> keep that source whole
- `source_chunk_batch` exceeds the overflow structured window -> keep the whole batch as whole
  sources
- `source_chunk_batch` returns malformed source ids or selectors after retry -> fail closed for that
  memory update
- failed memory update -> keep prior memory unchanged
- log failures and the full data flow when proxy logging is enabled
