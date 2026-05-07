# Reference

This document describes the current shipped runtime contracts.

## Core State

```ts
type ChunkSelector =
  | { kind: "whole" }
  | { kind: "text_spans"; spans: Array<{ start: number; end: number }> }
  | { kind: "object_path"; path: Array<string | number> };

type ActiveTask = {
  id: string;
  pieceIds: string[];
  startedRound: number;
  lastRound: number;
};

type ArchivedTaskBundle = {
  id: string;
  pieces: MemoryPiece[];
  startedRound: number;
  archivedRound: number;
};

type MemoryPiece = {
  id: string;
  sourceKind: "user" | "assistant" | "tool" | "tool_call";
  sourceId: string;
  toolName?: string;
  previewText: string;
  pointer?: Record<string, unknown>;
  byteSize: number;
  createdSeq: number;
  selector: ChunkSelector;
  contentHash: string;
  duplicateSources?: Array<{
    pieceId: string;
    sourceId: string;
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
    createdSeq?: number;
    toolName?: string;
    pointer?: Record<string, unknown>;
  }>;
};

type MemoryState = {
  roundSeq: number;
  activeTask: ActiveTask | null;
  archivedTasks: ArchivedTaskBundle[];
  pieces: MemoryPiece[];
  processedSourceIds: string[];
};
```

Important invariant:

- there is at most one active task
- `pieces` is the active prompt-memory set
- `archivedTasks` stores previous task piece metadata for revive
- raw payloads live in the lossless archive
- pieces reference exact original sources through selectors
- exact duplicate content is stored once in active memory, with duplicate source markers attached to
  the canonical kept piece; duplicate markers preserve the duplicate piece id, source identity,
  creation order when known, and a pointer or selector fallback for where the duplicate appeared
- there are no memory groups, summaries, or visibility tiers

## Structured Manager Calls

All manager calls use strict JSON schema response formatting. The proxy also validates returned
objects after parsing before applying them to state.

Dynamic checks that JSON Schema cannot fully express are handled conservatively:

- malformed `task_route` output falls back to `same_task`
- malformed `piece_drop_batch` output keeps every evaluated piece in that batch
- accepted `piece_drop_batch` drops are still filtered by local applicability and sanity checks
- omitted `source_chunk_batch` results for requested sources default to a `whole` selector
- failed or malformed `source_chunk_batch` output keeps requested sources as `whole` selectors

### `task_route`

```ts
type TaskRouteRequest = {
  activeTask: ActiveTask | null;
  archivedTasks: Array<{
    relativeIndex: number;
    id: string;
    pieceCount: number;
    startedRound: number;
    archivedRound: number;
  }>;
  newUserPieces: Array<{
    id: string;
    sourceId: string;
    content: unknown;
    previewText: string;
    pointer?: Record<string, unknown>;
  }>;
};

type TaskRouteResponse =
  | { kind: "same_task" }
  | { kind: "new_task" }
  | { kind: "revive_task"; relativeIndex: number };
```

For strict schema compatibility, the wire object always contains `kind` and `relativeIndex`.
`same_task` and `new_task` use `relativeIndex: 0`; `revive_task` uses a negative index. Local code
normalizes that wire object into the union above.

Relative indexes are negative:

```text
-1 = most recent previous task
-2 = task before that
```

If route fails, the runtime keeps the current task with `same_task`.

If `revive_task` names a relative index that does not exist, the runtime also keeps the current task
with `same_task`.

### `piece_drop_batch`

```ts
type PieceDropBatchRequest = {
  activeTask: ActiveTask | null;
  taskRoute: TaskRouteResponse;
  latestUserPieces: FullPayloadPiece[];
  sharedUserPieces: FullPayloadPiece[];
  candidateManifest: PieceManifestEntry[];
  evaluatedPieces: FullPayloadPiece[];
};

type PieceDropDecisionBody = {
  drop: boolean;
  reason: DropReason | null;
};

type PieceDropBatchWireResponse = {
  defaultDecision: PieceDropDecisionBody;
  overrides: Array<PieceDropDecisionBody & { pieceId: string }>;
};

type PieceDropBatchResponse = {
  decisions: Array<PieceDropDecisionBody & { pieceId: string }>;
};
```

A batch may only drop ids from `evaluatedPieces`, whose full payloads are included in the request.
Manifest-only pieces are kept. The runtime expands `defaultDecision` plus `overrides` into per-piece
`decisions` internally. To keep the whole batch on the wire, return
`defaultDecision={drop:false,reason:null}` and `overrides=[]`.

Accepted drop reasons:

```ts
type DropReason =
  | "exact_duplicate"
  | "explicitly_invalidated_by_user"
  | "old_task_after_confirmed_task_switch"
  | "pure_ack_or_chatter"
  | "transient_format_request_only"
  | "clearly_unrelated_to_current_work"
  | "empty_or_invalid";
```

Rule:

```text
drop=true + accepted reason => drop
anything else => keep
```

The rule is subject to local filters:

- `old_task_after_confirmed_task_switch` must apply to the target piece
- if candidates included non-assistant evidence and accepted drops would leave zero pieces or
  assistant-only pieces, the runtime rejects non-structural drops and keeps that evidence

`old_task_after_confirmed_task_switch` has an extra local applicability check. It is accepted only
when the effective route is `new_task`, the target piece came from the previous active task
candidate set, and the piece was created before the new task's `startedRound`.

### `source_chunk_batch`

```ts
type SourceChunkBatchRequest = {
  sources: Array<{
    sourceId: string;
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
    toolName?: string;
    contentText: string;
    pointer?: Record<string, unknown>;
  }>;
};

type SourceChunkBatchResponse = {
  results: Array<{
    sourceId: string;
    selectors: Array<
      | { kind: "whole" }
      | { kind: "text_spans"; spans: Array<{ start: number; end: number }> }
    >;
  }>;
};
```

Chunking returns selectors only; it never rewrites source content.

Validation rules:

- returned `sourceId` values must be in the request
- duplicate returned `sourceId` values are invalid
- selectors must be structurally valid
- if a requested source is omitted from `results`, the proxy creates a single `whole` selector for
  that source
- if the whole chunk request cannot fit even in the overflow structured window, the proxy skips the
  model call and creates one `whole` selector for each requested source
- if the call fails after retry because returned entries are malformed, the memory update fails
  closed and prior memory remains unchanged

Tool-call sources are not sent to `source_chunk_batch`; they become whole exact pieces structurally.
`object_path` selectors are produced only by deterministic Pando-tool chunking.

## Prompt Memory Block

The proxy injects one synthetic developer message shaped like:

```xml
<pando_task_memory>
<active_task>
taskId=task_2_abcd1234 startedRound=2 lastRound=5
</active_task>
<exact_pieces>
<piece pieceId="..." sourceKind="tool">
...exact materialized source span(s)...
</piece>
<duplicate_marker duplicatePieceId="..." duplicateSourceId="..." duplicateSourceKind="user" canonicalPieceId="..." canonicalSourceId="..." canonicalSourceKind="tool" duplicatePointer="..." />
</exact_pieces>
<archive>
archivedSourceCount=12
...
</archive>
</pando_task_memory>
```

## `recall`

`recall({offset,limit})` is the only local recovery tool in the active path.

Behavior:

- archive-only, never active-memory browsing
- max 3 calls per round
- no per-call item cap
- chronological selection over archived source ids not currently active
- exact original archived source payloads only

## Storage

`src/store.ts` persists:

- `state.json` for active memory and archived task metadata
- `archive/*.json` for raw archived original sources

Important access paths:

- `load(sessionKey)` — metadata/pruned active state only
- `materializeMemory(sessionKey, memory)` — lazy active-payload hydration for prompt rendering
- `materializePieces(sessionKey, pieces)` — full payload hydration for prune batches
- `archiveSources(sessionKey, sources)` — archive raw round sources
- `getArchivedSources(sessionKey, sourceIds)` — archive retrieval for `recall`
