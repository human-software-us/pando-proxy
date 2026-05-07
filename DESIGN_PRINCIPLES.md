# Design Principles

1. Active memory is exact.
   - no summaries as source material
   - no embeddings
   - no projection layer
   - no memory groups or retained-state tags

2. Active memory is one task.
   - at most one `activeTask`
   - the task owns the exact piece ids needed for current execution
   - stored active pieces == prompt-visible active pieces

3. Dropping requires positive proof.
   - exact duplicate content hash, with a duplicate source marker kept on the canonical piece and
     rendered where the duplicate appeared
   - explicit invalidation
   - certain structured drop decision
   - reason-specific applicability checks for narrow reasons like confirmed old-task switch drops
   - sanity rejection for non-structural drops that would collapse non-assistant evidence to
     assistant-only output
   - if uncertain, keep

4. Archive is separate.
   - archive is an explicit recovery surface, not active memory
   - task switches page old active memory out of the prompt, not out of storage

5. Semantic decisions come from narrow manager calls.
   - `task_route`
   - `piece_drop_batch`
   - `source_chunk_batch`

6. Chunking returns exact selectors only.
   - show the model the exact raw source text that local code will materialize
   - do not ask the model for character offsets
   - model output is only `whole` or exact copied chunk text
   - no summaries, labels, content types, or boundary classifications
   - local code maps exact chunk text to persisted `[start,end)` selectors
   - repeated exact chunk text in one source materializes every occurrence
   - if returned chunks are not exact and valid, keep the source whole
   - line/window splitting is only an oversized deterministic fallback, not the semantic goal

7. Local code is structural only.
   - persistence
   - selector materialization
   - archive fetch
   - deterministic duplicate collapse before same-task prune and after new-task prune
   - applying manager outputs
   - structural fallback like omitted or oversized chunk batches -> `whole`
   - selector validation/materialization for valid manager output

8. Recall is call-count bounded and item-count unbounded.
   - `recall({offset,limit})`
   - max 3 calls per round
   - no per-call item cap
   - archive only

9. Validation is live.
   - real backend calls
   - logs and persisted state
   - unit tests only cover local regressions
