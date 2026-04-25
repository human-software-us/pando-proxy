# Design Principles

## 1. The Proxy Is A Sieve

The proxy should keep only what still needs to be sent next round.

Anything else should be dropped completely.

## 2. One Memory Tier Only

There is no hidden retained set behind the prompt.

The stored memory set and the next prompt memory set must be the same thing.

## 3. Exact Pieces Only

Prompt-side memory contains only exact kept pieces.

No semantic summaries, preview catalogs, omitted shadow sets, or retrieval layers belong in the
runtime design.

## 4. Semantic Decisions Belong To The Manager

Every non-obviously-deterministic decision must come from a manager LLM call:

- group lifecycle
- group routing
- keep/drop
- supersession
- old-piece pruning

Local code must not infer these semantics.

## 5. Chunk Everything

User messages, assistant messages, and tool outputs should all be chunkable.

If splitting would be unsafe, keep the source as one exact whole piece.

## 6. Deterministic Code Is Structural Only

Allowed deterministic logic:

- persistence
- chunk materialization from selectors
- payload spill/ref handling
- applying manager outputs
- preserving chronological order as much as possible
- structural fallback such as malformed chunk selectors falling back to `whole`

Not allowed:

- phrase matching
- local close/replace inference
- semantic scoring
- semantic projection
- semantic auto-linking

## 7. No Projection Layer

There is no `prompt_projection`.

If a piece is worth keeping, it survives into the next prompt.
If it is not worth keeping, it is dropped.

## 8. No Local Retrieval Fallback

There is no `context_get` layer in the target design.

If old context is needed later, resurrect it from the original source instead of hoarding it in the
proxy.

## 9. Structured Outputs With Bounded Retry

Manager calls should use strict structured output schemas.

Policy:

- make one call
- validate locally
- retry once if invalid
- if still invalid, fail the memory update and keep prior state

## 10. Live E2E Is The Source Of Truth

Validation should focus on real backend behavior with persisted state and logs.

Outdated unit tests are not the correctness source for the redesign.
