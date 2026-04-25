# Design Principles

## 1. Groups, Not Objectives

Durable memory is organized around active groups.

There is no session-wide objective string and no synthetic semantic compression of prior work.

## 2. Exact Pieces Only

Prompt-side memory contains only exact retained pieces.

No semantic summaries, embeddings, preview catalogs, or prose reconstructions belong in the prompt
memory block.

## 3. Semantic Decisions Belong To The Manager

Every non-obviously-deterministic decision must come from a manager LLM call:

- group lifecycle
- group routing
- keep/drop
- supersession
- inline projection

Local code must not infer these semantics.

## 4. Batched, Small Manager Calls

Do not cram unrelated evaluations into one giant prompt.

Use a few small batched calls instead:

- `group_intent`
- `source_chunk_batch`
- `piece_retention_batch`
- `prompt_projection`

Run independent calls in parallel when possible.

## 5. Deterministic Code Is Structural Only

Allowed deterministic logic:

- persistence
- chunk materialization from selectors
- payload spill/ref handling
- exact chronological paging for `context_get`
- applying manager outputs
- structural fallback such as malformed chunk selectors falling back to `whole`

Not allowed:

- phrase matching
- local close/replace inference
- semantic scoring
- semantic inline ranking
- semantic auto-linking

## 6. One-Shot Structured Outputs

Manager calls should use strict structured output schemas.

Policy:

- make one call
- validate locally
- retry once if invalid
- if still invalid, fail the memory update and keep prior state

## 7. Drop Aggressively, But By Manager Decision

The system should keep a minimal exact retained set.

But that drop bias must come from manager output, not from local semantic heuristics.

## 8. Prompt Projection Is Manager-Owned

Which retained pieces are inline is itself a semantic choice and should be manager output.

Local code should only render the chosen `inlinePieceIds`.

## 9. `context_get` Is Exact Fallback Only

`context_get` exists only to fetch exact retained omitted pieces.

It must remain:

- exact
- chronological when paging
- non-semantic

## 10. Live E2E Is The Source Of Truth

Validation should focus on real backend behavior with persisted state and logs.

Outdated unit tests are not the correctness source for the redesign.
