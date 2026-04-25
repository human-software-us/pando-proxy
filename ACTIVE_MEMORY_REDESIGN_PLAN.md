# Active Memory Redesign Plan

This document is the current implementation plan for the sieve-based memory manager redesign.

The target behavior is:

- one memory tier only
- exact kept pieces only
- no hidden retained memory
- no prompt projection layer
- no local retrieval fallback
- semantic decisions made only by manager LLM calls

Net effect:

- raw outgoing prompt/history is `A`
- proxy sends reduced prompt/history `A'`
- `A'` is no larger than `A`
- `A'` preserves the same essential content in nearly the same original order
- anything not worth sending next round is dropped completely

## Hard Rules

1. Every non-obviously-deterministic evaluation must be done by a manager LLM call.
2. Manager calls must use strict-schema structured outputs.
3. Manager calls get one retry if validation fails.
4. If the retry also fails, fail the memory update, keep prior memory unchanged, and log it.
5. Deterministic code may only do structural work:
   - persistence
   - exact chunk materialization
   - exact payload spill/ref handling
   - applying already-classified results
   - preserving chronological order as much as possible
   - structural fallback like malformed chunk selectors falling back to `whole`
6. No local semantic heuristics:
   - no phrase matching
   - no local close/replace inference
   - no semantic keep/drop ranking
   - no semantic prompt projection
   - no semantic auto-linking

## Target State

```ts
type MemoryGroup = {
  id: string;
  status: "active" | "closed";
  routingLabel: string;
  summary: string;
  lastTouchedSeq: number;
};

type MemoryPiece = {
  id: string;
  groupId: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  payloadInline?: unknown;
  payloadRef?: string;
  previewText: string;
  pointer?: Record<string, unknown>;
  byteSize: number;
  createdSeq: number;
  selector: ChunkSelector;
};

type MemoryState = {
  roundSeq: number;
  groups: MemoryGroup[];
  pieces: MemoryPiece[];
  processedSourceIds: string[];
};
```

The stored `pieces` set and the next prompt memory set are the same thing.

## Manager Calls

### 1. `source_chunk_batch`

Purpose:

- chunk all new sources together, including user messages

Input:

- all new round sources

Output:

- `[{ sourceId, selectors: ChunkSelector[] }]`

### 2. `group_intent`

Purpose:

- classify group lifecycle for the round

Input:

- existing groups
- retained anchor previews from already-kept pieces
- new user-piece previews

Output:

- `groupsAfter`
- `closedGroupIds`
- `replacedGroupIds`

### 3. `piece_retention_batch`

Purpose:

- decide keep/drop, group assignment, and supersession for all new pieces together

Input:

- `groupsAfter`
- all new exact pieces
- bounded anchor previews from already-kept pieces

Output:

- one decision per new piece:
  - `keep`
  - `groupId`
  - `supersedesPieceIds`

### 4. `retained_piece_prune`

Purpose:

- explicitly prune previously kept old pieces that are no longer worth sending next round

Input:

- `groupsAfter`
- surviving old kept pieces
- newly kept pieces

Output:

- `dropPieceIds`

Prompt rule:

- err on the side of keeping if unsure

## End-Of-Round Flow

1. Start from the full raw prompt/history that would have been sent.
2. Extract new round sources.
3. Run `source_chunk_batch` on all new sources.
4. Materialize exact pieces from selectors.
5. Run `group_intent`.
6. Run `piece_retention_batch`.
7. Run `retained_piece_prune`.
8. Deterministically apply manager results:
   - drop pieces in closed/replaced groups where appropriate
   - drop superseded pieces
   - drop pruned old pieces
   - keep exactly the new pieces marked `keep=true`
   - preserve original chronological order as much as possible
9. Persist `groups`, `pieces`, and `processedSourceIds`.
10. Build the next rewritten prompt directly from that final kept set.

There is no `prompt_projection`.
There is no omitted shadow set.
There is no `context_get`.

## Prompt Memory

Prompt memory should become:

```xml
<pando_group_memory>
<groups>
- groupId=g1 status=active label=remember-token summary=Preserve exact token BLUE-...
</groups>
<exact_pieces>
<piece pieceId=p1 groupId=g1 sourceKind=user>
...
</piece>
</exact_pieces>
</pando_group_memory>
```

Everything shown there is exactly what survives.
Nothing else is retained by the proxy.

## Rollout Steps

### Step 1. Update Docs

- rewrite the plan and design docs to describe the sieve model

### Step 2. Collapse To One Memory Tier

- remove `inlinePieceIds`
- remove piece visibility classes
- remove omitted-vs-inline handling

### Step 3. Replace Prompt Projection And Retrieval

- delete `prompt_projection`
- delete `context_get`
- delete hidden retained-piece browsing logic

### Step 4. Chunk All Sources

- run `source_chunk_batch` for user, assistant, and tool sources
- keep deterministic `whole` fallback when splitting is unsafe

### Step 5. Add Old-Piece Pruning

- add `retained_piece_prune`
- prune old kept pieces conservatively

### Step 6. Make Next Prompt Equal Final Kept Set

- render all surviving kept pieces
- keep ordering close to original chronology

### Step 7. Live E2E Only

- validate only with live backend calls
- after every fix, restart the same session from scratch

## Post-Implementation Audit

After implementation, explicitly verify that no hidden second-tier memory remains.

Search for and remove any local logic around:

- `inlinePieceIds`
- omitted pieces
- `context_get`
- prompt projection
- semantic keep/drop overrides

Only the final kept set may survive into the next round.
