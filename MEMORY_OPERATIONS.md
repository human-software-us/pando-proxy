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

Chunking returns `whole` or exact start/end boundary text. It never returns summaries, labels,
content types, boundary classifications, character offsets, or model-generated rewrites.

The model should see the exact raw source text it is being asked to select from, not a JSON-escaped
serialization of that text. Any model-produced selector must be interpreted against that same raw
source view. If the prompt representation and materialization representation differ, character
offsets are not trustworthy and must not be accepted as exact chunks.

The model output for each source is only:

```ts
type ChunkSelector =
  | { kind: "whole" }
  | { kind: "chunks"; chunks: Array<{ startText: string; endText: string }> };
```

For `chunks`, `startText` and `endText` are exact substrings from the raw source body. `startText`
is the first text in the chunk and `endText` is the last text in the chunk; the chunk includes both.
The model should prefer boundary text that is unique when possible. When the same boundary pair
genuinely repeats, local code applies the same start-to-next-end match repeatedly and creates one
chunk per matching occurrence. Later duplicate-piece collapse keeps one full copy and adds duplicate
markers for the other locations.

If the model cannot select valid coherent chunks, the source remains `whole`. Local validation
rejects malformed, empty, missing, unmatched, overlapping, or otherwise unsafe boundary selections.
Invalid selectors retry once with diagnostics; if they still cannot be validated, the proxy keeps
that source whole.

For very long repeated structures, boundary text can still fail if the model chooses substrings that
do not occur exactly or do not form clean source ranges. That is not repaired heuristically; the
source falls back to `whole`. Opaque payloads such as image/base64-like data should usually stay
`whole` unless a small exact metadata or text block is clearly worth keeping.

The chunker never creates deterministic fallback chunks. It only materializes model-selected exact
chunks or keeps the source whole. Large `rg`, test, log, XML, JSON, image-like, or blob-like
payloads stay whole unless the model selects exact chunks that local validation can materialize.

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
