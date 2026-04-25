# Reference

This document describes the current shipped runtime contracts.

## Core State

```ts
type ChunkSelector =
  | { kind: "whole" }
  | { kind: "text_spans"; spans: Array<{ start: number; end: number }> }
  | { kind: "object_path"; path: Array<string | number> };

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

Important invariant:

- the stored `pieces` set is the active prompt-memory set
- pieces reference exact original sources through selectors instead of storing rewritten payloads
- non-Pando text-like pieces use exact `text_spans` into the archived original source
- one conceptual piece may contain multiple ordered spans when separated source regions belong together
- there is no `inlinePieceIds`
- there is no visibility split like `inline | omittable`

## Structured Manager Calls

All semantic decisions come from strict-schema structured model calls.

### `group_intent`

```ts
type GroupIntentRequest = {
  groups: MemoryGroup[];
  retainedGroupAnchors: Array<{
    groupId: string;
    pieceId: string;
    sourceKind: "user" | "assistant" | "tool";
    sourceId: string;
    toolName?: string;
    previewText: string;
    createdSeq: number;
  }>;
  newUserPieces: Array<{
    id: string;
    sourceId: string;
    previewText: string;
    pointer?: Record<string, unknown>;
    selector: ChunkSelector;
  }>;
};

type GroupIntentResponse = {
  groupsAfter: MemoryGroup[];
  closedGroupIds: string[];
  replacedGroupIds: string[];
};
```

### `piece_retention_batch`

```ts
type PieceRetentionBatchRequest = {
  groups: MemoryGroup[];
  retainedPieceAnchors: Array<{
    id: string;
    groupId: string;
    sourceKind: "user" | "assistant" | "tool";
    sourceId: string;
    toolName?: string;
    previewText: string;
    createdSeq: number;
  }>;
  newPieces: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    sourceId: string;
    toolName?: string;
    previewText: string;
    pointer?: Record<string, unknown>;
    selector: ChunkSelector;
  }>;
};

type PieceRetentionDecision = {
  pieceId: string;
  keep: boolean;
  groupId: string | null;
  supersedesPieceIds: string[];
};

type PieceRetentionBatchResponse = {
  decisions: PieceRetentionDecision[];
};
```

### `retained_piece_prune`

```ts
type RetainedPiecePruneRequest = {
  groups: MemoryGroup[];
  retainedOldPieces: Array<{
    id: string;
    groupId: string;
    sourceKind: "user" | "assistant" | "tool";
    sourceId: string;
    toolName?: string;
    previewText: string;
    createdSeq: number;
  }>;
  keptNewPieces: Array<{
    id: string;
    groupId: string;
    sourceKind: "user" | "assistant" | "tool";
    sourceId: string;
    toolName?: string;
    previewText: string;
    createdSeq: number;
  }>;
};

type RetainedPiecePruneResponse = {
  dropPieceIds: string[];
};
```

### `source_chunk_batch`

```ts
type SourceChunkBatchRequest = {
  sources: Array<{
    sourceId: string;
    sourceKind: "user" | "assistant" | "tool";
    toolName?: string;
    contentText: string;
    pointer?: Record<string, unknown>;
  }>;
};

type SourceChunkBatchResponse = {
  results: Array<{
    sourceId: string;
    selectors: ChunkSelector[];
  }>;
};
```

Notes:

- user sources are chunked too
- Pando tool outputs are still split deterministically
- model chunking returns selectors only; it never rewrites source content
- `text_spans` offsets are exact character offsets into `contentText`
- source order is preserved within each multi-span piece
- duplicate selectors from the same source are deduped by canonical selector identity

## Prompt Memory Block

The proxy injects one synthetic developer message shaped like:

```xml
<pando_group_memory>
<groups>
- groupId=g1 status=active label=... summary=...
</groups>
<exact_pieces>
<piece pieceId=... groupId=... sourceKind=...>
...exact materialized source span(s)...
</piece>
</exact_pieces>
<archive>
archivedSourceCount=12
If you truly need older exact material that is not shown above, you may call recall({offset,limit}) up to 3 times in this round.
Use it only as an emergency recovery path for earlier exact sources from the per-session archive, not from active memory.
Prefer answering from active memory first. If you do use recall, request enough chronological coverage to satisfy the task and err on asking for more archived pieces rather than fewer.
</archive>
</pando_group_memory>
```

## `recall`

`recall` is the only local recovery tool in the active path.

Schema:

```json
{
  "type": "function",
  "name": "recall",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "offset": { "type": "integer", "minimum": 0 },
      "limit": { "type": "integer", "minimum": 1, "maximum": 20 }
    },
    "required": ["offset", "limit"]
  }
}
```

Behavior:

- archive-only, never active-memory browsing
- max 3 calls per round
- chronological selection over archived source ids not currently active
- exact original archived source payloads only

Tool result includes:

- `source: "archive"`
- `requestedOffset`
- `requestedLimit`
- `returnedCount`
- `remainingArchivedSourceCount`
- `note`
- `items[]`

## Storage

`src/store.ts` persists:

- `state.json` for active memory
- `payloads/*.json` for spilled active piece payloads
- `archive/*.json` for raw archived original sources

Important access paths:

- `load(sessionKey)` — metadata/pruned active state only
- `materializeMemory(sessionKey, memory)` — lazy active-payload hydration for prompt rendering
- `archiveSources(sessionKey, sources)` — archive raw round sources
- `getArchivedSources(sessionKey, sourceIds)` — archive retrieval for `recall`

## Logging

Important JSONL events:

- `rewritten_context`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `memory_round_updated`
- `memory_state_saved`
- `structured_model_usage`
- `structured_model_skipped`
- `archive_recall`
- `round_complete`

`round_complete` includes:

- `archiveRecallCount`
- `archiveRecalls`
- `archiveRecallReturnedBytes`
- `returnedArchiveSourceIds`
- `internalManagerByClassifier`
- `internalManagerRetryAttempts`
- `internalManagerDurationMs`
- `internalManagerInputTokenDelta`
- active memory metrics
- all-in token totals including manager calls

`structured_model_usage` includes:

- `attempt`
- `durationMs`
- `estimatedInputTokens`
- `inputTokens`
- `inputTokenDelta`
