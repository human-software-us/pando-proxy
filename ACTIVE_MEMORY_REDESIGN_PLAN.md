# Active Memory Redesign Plan

Implemented target state:

- one `activeTask`
- previous `archivedTasks`
- exact `pieces`
- no groups
- no projection/inline-vs-omitted logic
- no hidden retained-memory retrieval
- one explicit archive recovery path through `recall`

Core invariant:

- stored active pieces == next prompt memory pieces

Implementation shape:

1. chunk all new sources
2. run `source_chunk_batch` and `task_route` in parallel
3. dedupe exact content hashes while recording duplicate source markers
4. build the routed candidate active set
5. run `piece_drop_batch` for bounded full-payload batches
6. persist only the surviving exact pieces under the active task
7. archive raw original sources separately for explicit recovery

Archive policy:

- archive is not active memory
- archive is only a recovery surface
- the model may call `recall({offset,limit})` up to 3 times in a round
- each recall call has no per-call item cap
- recall should prefer broad-enough coverage rather than underfetching

Out of scope:

- pinning subsystem
- projection layer
- omitted-piece browsing tier
- durable taxonomy or group manager
- unit-test-driven product validation
