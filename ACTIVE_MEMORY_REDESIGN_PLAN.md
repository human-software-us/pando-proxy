# Active Memory Redesign Plan

Target state:

- keep `groups`
- keep exact `pieces`
- remove projection/inline-vs-omitted logic
- remove hidden retained-memory retrieval
- keep one bounded archive recovery path through `recall`

Core invariant:

- stored active pieces == next prompt memory pieces

Implementation shape:

1. chunk all new sources
2. run `source_chunk_batch` and `group_intent` in parallel
3. run `piece_retention_batch`
4. run `retained_piece_prune`
5. persist only the surviving exact pieces
6. archive raw original sources separately for bounded recovery

Archive policy:

- archive is not active memory
- archive is only a recovery surface
- the model may call `recall({offset,limit})` up to 3 times in a round
- recall should prefer broad-enough coverage rather than underfetching

Out of scope:

- pinning subsystem
- projection layer
- omitted-piece browsing tier
- unit-test-driven validation
