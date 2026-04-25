# Design Principles

1. Active memory is exact.
   - no summaries
   - no embeddings
   - no projection layer

2. Active memory is one tier.
   - stored active pieces == prompt-visible active pieces

3. Archive is separate.
   - archive is a bounded recovery surface, not active memory

4. Semantic decisions come from manager calls.
   - `group_intent`
   - `piece_retention_batch`
   - `retained_piece_prune`
   - `source_chunk_batch`

5. Local code is structural only.
   - persistence
   - selector materialization
   - archive fetch
   - applying manager outputs
   - structural fallback like malformed chunk selectors -> `whole`

6. Recall is bounded.
   - `recall({offset,limit})`
   - max 3 calls per round
   - archive only

7. Validation is live.
   - real backend calls
   - logs and persisted state
   - not unit tests
