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
12. persist the active task, archived task bundles, and surviving exact pieces

Tool-call sources are chunked as whole pieces. They are still eligible for later full-payload prune
decisions; nothing is protected forever.

If `source_chunk_batch` omits a requested source from its result array, the proxy keeps that source
as one whole exact piece. Returned source ids and selectors still have to validate locally.

If a chunk request is too large for the overflow structured window, the proxy skips the model call
and keeps each requested source whole.

## Chunk boundary contract

Chunking returns `whole` or exact copied chunk text. It never returns summaries, labels, content
types, boundary classifications, or model-generated rewrites.

The model should see the exact raw source text it is being asked to select from, not a JSON-escaped
serialization of that text. Any model-produced selector must be interpreted against that same raw
source view. If the prompt representation and materialization representation differ, character
offsets are not trustworthy and must not be accepted as exact chunks.

The model output for each source is only:

```ts
type ChunkSelector =
  | { kind: "whole" }
  | { kind: "chunks"; chunks: Array<{ text: string }> };
```

For `chunks`, `text` must be the complete chunk copied exactly from the raw source body shown to the
model. Local code finds every exact occurrence of each quoted chunk and converts those occurrences
to persisted `[start,end)` chunk selectors. If the same quoted chunk appears multiple times in one
source, all matching occurrences become chunks; later duplicate-piece collapse keeps one full copy
and adds duplicate markers for the other locations.

If the model cannot select valid coherent chunks, the source remains `whole`. Local validation
rejects malformed, empty, missing, changed, overlapping, or otherwise non-exact quoted chunks.
Invalid selectors retry once with diagnostics; if they still cannot be validated, the proxy keeps
that source whole.

If the chunk model returns `whole` for a large text source, the proxy applies a deterministic exact
split before creating pieces. It prefers complete top-level JSON array entries when the text is a
JSON array. Otherwise it uses bounded line windows: contiguous line ranges under the byte budget,
with each line kept intact. This is a fallback for cases where the model did not already split on a
better conceptual boundary.

The split fallback is deterministic:

1. if the text is a complete top-level JSON array, find exact element chunks
2. pack adjacent element chunks under the deterministic byte budget
3. otherwise split into contiguous line windows under the byte budget
4. if neither path produces multiple chunks, keep the source whole

For large `rg` outputs, the model prompt asks for conceptual split points before line windows:

- `rg --files ...`: group consecutive paths by directory, package, namespace, or subsystem path,
  such as `src/metabase/api/...`, `src/metabase/search/...`, `test/metabase/...`, or
  `enterprise/backend/...`
- `rg -n "..." ...`: group by file path first, then by line-number ranges or nearby match clusters
  for very large files
- broad repository searches: group by subsystem/path prefix, then by file, then by line range

This keeps the archive lossless while avoiding all-or-nothing active pieces for large `rg`, test, or
log outputs.

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
- `source_chunk_batch` fails or returns malformed source ids/selectors after retry -> keep requested
  sources whole
- failed memory update -> keep prior memory unchanged
- log failures and the full data flow when proxy logging is enabled
