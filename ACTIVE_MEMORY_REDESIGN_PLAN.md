# Active Memory Redesign Plan

This document is the current implementation plan for the groups-based memory manager redesign.

The previous `tasks`-based runtime is being replaced again because the desired architecture is:

- active groups, not generic tasks
- exact retained pieces only
- semantic decisions made only by manager LLM calls
- batched manager calls with small prompts
- no local semantic heuristics

## Hard Rules

1. Every non-obviously-deterministic evaluation must be done by a manager LLM call.
2. Manager calls must be strict-schema structured outputs.
3. Manager calls are one-shot, with at most one retry if the response is invalid.
4. If the retry is also invalid, fail the memory update, keep prior memory unchanged, and log it.
5. Deterministic code may only do structural work:
   - persistence
   - chunk materialization
   - exact payload externalization
   - applying already-classified results
   - deterministic paging / ordering for `context_get`
   - structural fallback like malformed chunk selectors falling back to `whole`
6. No local semantic heuristics:
   - no phrase matching
   - no local close/replace inference
   - no semantic keep/drop ranking
   - no semantic inline ranking
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
  visibility: "inline" | "omittable";
};

type MemoryState = {
  roundSeq: number;
  groups: MemoryGroup[];
  pieces: MemoryPiece[];
  processedSourceIds: string[];
  inlinePieceIds: string[];
};
```

## Manager Calls

### 1. `group_intent`

Purpose:

- classify group lifecycle for the round

Input:

- existing groups: `id`, `status`, `routingLabel`, `summary`
- new user-piece previews only

Output:

- `groupsAfter`
- `closedGroupIds`
- `replacedGroupIds`
- optional relation metadata for new/replacement groups

### 2. `source_chunk_batch`

Purpose:

- chunk all new assistant/tool sources together

Input:

- all new assistant/tool sources from the round

Output:

- `[{ sourceId, selectors: ChunkSelector[] }]`

### 3. `piece_retention_batch`

Purpose:

- decide keep/drop, group assignment, supersession, and visibility for all new pieces together

Input:

- `groupsAfter`
- all new exact pieces
- bounded anchor previews from existing kept pieces by group

Output:

- `decisions: Array<{ pieceId, keep, groupId?, supersedesPieceIds, visibility }>`

### 4. `prompt_projection`

Purpose:

- choose which retained pieces should be inline in the next prompt

Input:

- active groups
- retained piece previews
- `maxInlinePieces`

Output:

- `inlinePieceIds`

## End-Of-Round Flow

1. Extract round sources.
2. In parallel:
   - run `group_intent`
   - run `source_chunk_batch`
3. Materialize exact pieces from selectors.
4. Run `piece_retention_batch`.
5. Deterministically apply manager results:
   - drop pieces in closed/replaced groups
   - drop superseded pieces
   - keep new pieces where `keep=true`
   - assign `groupId` exactly as returned
6. Run `prompt_projection`.
7. Persist `groups`, `pieces`, and `inlinePieceIds`.

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
<context_get>
Use context_get({pieceIds:[...]}) when you know ids.
Use context_get({offset,limit}) to browse omitted exact retained pieces.
If the needed exact value is already visible above, answer from it directly.
</context_get>
</pando_group_memory>
```

## Rollout Steps

### Step 1. Update Docs

- rewrite the plan and design docs to describe groups plus batched manager calls

### Step 2. Introduce Group State Types

- replace task-oriented types with group-oriented ones
- add `inlinePieceIds` to persisted state

### Step 3. Replace `round_update`

- delete the current semantic `round_update` contract
- add `group_intent`
- add `piece_retention_batch`
- add `prompt_projection`

### Step 4. Replace Prompt Projection Heuristics

- remove local inline ranking
- make prompt projection depend only on manager-returned `inlinePieceIds`

### Step 5. Wire Batched Execution

- `group_intent` and `source_chunk_batch` run in parallel
- `piece_retention_batch` runs after exact pieces are materialized

### Step 6. Live E2E Only

- validate only with live backend calls
- after every fix, restart from scenario 1

## Post-Implementation Audit

After implementation, explicitly verify that no semantic heuristic remains in local code.

Search for and remove any local logic around:

- close/replace/redirect cues
- semantic priority/ranking
- semantic task/group linking
- semantic keep/drop overrides

Only manager outputs may decide those things.
