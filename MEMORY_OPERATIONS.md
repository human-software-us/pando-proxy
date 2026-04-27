# Memory Operations

## Start of request

1. load session state
2. materialize active piece payloads for prompt rendering
3. inject `<pando_group_memory>`
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
2. chunk them
3. update groups
4. retain or drop new pieces
5. prune obsolete old pieces
6. archive raw round sources
7. persist the surviving active pieces

`groups[].summary` is updated as temporary routing/grouping metadata. It is not user-provided source
material and must not be treated as a replacement for exact pieces or archive recall.

## Failure policy

- manager call invalid twice -> fail closed for that memory update
- keep prior memory unchanged
- log the failure
- do not infer semantics locally
