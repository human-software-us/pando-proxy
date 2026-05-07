# Active Memory Redesign Plan

Implemented target state:

- one `activeTask`
- previous `archivedTasks`
- exact `pieces`
- a short title on each active/archived task
- no groups
- no projection/inline-vs-omitted logic
- no hidden retained-memory retrieval
- one explicit archive recovery path through `recall`

Core invariant:

- stored active pieces == next prompt memory pieces

Implementation shape:

1. collect all new sources
2. run `source_chunk_batch` for non-user sources and `task_route` in parallel; user messages are
   kept whole by message
3. materialize exact new pieces and apply the task route
4. collapse same-task and revived-task exact duplicate new pieces before prune; defer `new_task`
   old/new duplicate collapse until after prune so old-task pieces can be rescued or dropped with
   full context
5. build the routed candidate active set
6. run `piece_drop_batch` for bounded full-payload batches
7. reject non-structural drops that would collapse a working set with non-assistant evidence to
   assistant-only output
8. persist only the surviving exact pieces under the active task
9. archive raw original sources separately for explicit recovery

Archive policy:

- archive is not active memory
- archive is only a recovery surface
- routing sees archived task titles in newest-first pages of five and can ask for the next page
- the model may call `recall({offset,limit})` up to 3 times in a round
- each recall call has no per-call item cap
- recall should prefer broad-enough coverage rather than underfetching

Out of scope:

- pinning subsystem
- projection layer
- omitted-piece browsing tier
- durable taxonomy or group manager
- unit-test-driven product validation
