# Reference

This document describes the current shipped runtime contracts.

## Core State

```ts
type ChunkSelector =
  | { kind: "whole" }
  | { kind: "chunks"; chunks: Array<{ start: number; end: number }> }
  | { kind: "object_path"; path: Array<string | number> };

type ActiveTask = {
  id: string;
  title: string;
  pieceIds: string[];
  startedRound: number;
  lastRound: number;
};

type ArchivedTaskBundle = {
  id: string;
  title: string;
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
- active and archived tasks have short human-readable titles
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
- omitted `source_chunk_batch` results for requested sources are kept as one whole chunk
- failed or malformed `source_chunk_batch` output keeps requested sources as one whole chunk

### `task_route`

```ts
type TaskRouteRequest = {
  activeTask: ActiveTask | null;
  activePieces: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
    sourceId: string;
    toolName?: string;
    createdSeq: number;
    byteSize: number;
    contentText: string;
  }>;
  archivePage: {
    offset: number;
    pageSize: number;
    hasMore: boolean;
    nextRelativeIndex: number | null;
  };
  archivedTasks: Array<{
    relativeIndex: number;
    id: string;
    title: string;
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

type TaskRouteWireResponse =
  | TaskRouteResponse
  | { kind: "more_archived_tasks" };
```

For strict schema compatibility, the wire object always contains `kind` and `relativeIndex`.
`same_task`, `new_task`, and `more_archived_tasks` use `relativeIndex: 0`; `revive_task` uses a
negative index. Local code normalizes final decisions into `TaskRouteResponse`.

Relative indexes are negative:

```text
-1 = most recent previous task
-2 = task before that
```

Only five archived task cards are shown per route request, newest first. If the model returns
`more_archived_tasks` and more cards exist, the proxy asks again with the next page (`-6..-10`, then
`-11..-15`, and so on). If no more cards exist, routing falls back to `same_task`.

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

Chunking asks the model for verbatim chunks copied from the raw source text. It never asks for
summaries, labels, content types, boundary classifications, or character offsets. The request
representation shown to the model and the source representation used for materialization must be the
same raw source text.

This classifier always uses the configured full/overflow structured model, currently `gpt-5.4`, with
low reasoning effort when the selected model supports it, and `service_tier: "priority"`.
`task_route` and `piece_drop_batch` remain cost-sensitive and use the configured small model,
currently `gpt-5.4-mini`, when they fit.

The prompt biases the model toward coherent multi-chunk output because malformed chunks fail closed
to whole-source retention and later pruning can keep too much. Clearly inseparable sources should
still be returned as one whole chunk.

User messages are not sent to this classifier. Each user message becomes one inseparable `whole`
piece before pruning.

Chunk contract:

```ts
type SourceChunkBatchResponse = {
  results: Array<{
    sourceId: string;
    chunks: string[];
  }>;
};
```

For `chunks`, every item must be exact text copied from the raw source body shown to the model. The
chunk list is valid only when `chunks.join("")` equals the complete raw source body exactly. Local
code converts the returned lossless chunk list to persisted `[start,end)` selectors.

Request shape:

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
    chunks: string[];
  }>;
};
```

If coherent chunks cannot be selected and validated, the correct result is one chunk containing the
whole source, not an approximate split.

Validation rules:

- returned `sourceId` values must be in the request
- duplicate returned `sourceId` values are invalid
- `chunks` must be a non-empty string array
- `chunks.join("")` must equal the raw source body exactly
- returned chunks are not fuzzily repaired; invalid XML/log/blob text falls back to one whole chunk
- if a requested source is omitted from `results`, the proxy creates a single whole chunk for that
  source
- if the whole chunk request cannot fit even in the overflow structured window, the proxy skips the
  model call and creates one whole chunk for each requested source
- if the call fails after retry because returned entries are malformed, the memory update fails
  closed and prior memory remains unchanged

Tool-call sources are not sent to `source_chunk_batch`; they become whole exact pieces structurally.
User-message sources are also not sent; they become whole exact pieces structurally. `object_path`
selectors are produced only by deterministic Pando-tool chunking.

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
