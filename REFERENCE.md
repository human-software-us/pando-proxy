# Reference

This document describes the current shipped runtime schema and maintenance contracts.

## `MemoryGroup`

```ts
type MemoryGroup = {
  id: string;
  status: "active" | "closed";
  routingLabel: string;
  summary: string;
  lastTouchedSeq: number;
};
```

`summary` is compact routing metadata for the group. Exact retained evidence still lives in pieces.

## `MemoryPiece`

```ts
type ChunkSelector =
  | { kind: "whole" }
  | { kind: "line_range"; startLine: number; endLine: number }
  | { kind: "object_path"; path: Array<string | number> };

type MemoryPiece = {
  id: string;
  groupId: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  visibility: "inline" | "omittable";
  payloadInline?: unknown;
  payloadRef?: string;
  previewText: string;
  pointer?: Record<string, unknown>;
  byteSize: number;
  createdSeq: number;
  selector: ChunkSelector;
};
```

Large piece payloads may be written to per-session payload files and referenced through
`payloadRef`. Retrieval still returns the exact original payload.

## Session State

```ts
type MemoryState = {
  roundSeq: number;
  groups: MemoryGroup[];
  pieces: MemoryPiece[];
  processedSourceIds: string[];
  inlinePieceIds: string[];
};
```

`inlinePieceIds` is the prompt projection for the next round. Retained pieces not in that list stay
durable and retrievable through `context_get`.

## `group_intent`

Request:

```ts
type GroupIntentRequest = {
  groups: MemoryGroup[];
  newUserPieces: Array<{
    id: string;
    sourceId: string;
    content: unknown;
    previewText: string;
    pointer?: Record<string, unknown>;
  }>;
};
```

Response:

```ts
type GroupIntentResponse = {
  groupsAfter: MemoryGroup[];
  closedGroupIds: string[];
  replacedGroupIds: string[];
};
```

Validation rules:

- every `groupsAfter` entry must have `id`, `status`, `routingLabel`, `summary`, and
  `lastTouchedSeq`
- every group id must be unique and non-empty
- retired ids in `closedGroupIds` and `replacedGroupIds` must be non-empty
- retired ids must not also appear in `groupsAfter`

## `piece_retention_batch`

Request:

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
    content: unknown;
    previewText: string;
    pointer?: Record<string, unknown>;
  }>;
};
```

Response:

```ts
type PieceRetentionDecision = {
  pieceId: string;
  keep: boolean;
  groupId?: string;
  supersedesPieceIds: string[];
  visibility: "inline" | "omittable";
};

type PieceRetentionBatchResponse = {
  decisions: PieceRetentionDecision[];
};
```

Validation rules:

- every `newPieces` entry must have exactly one decision
- every kept piece must reference an active group in `groups`
- `visibility` must be either `inline` or `omittable`
- every superseded piece id must reference an older retained piece

## `prompt_projection`

Request:

```ts
type PromptProjectionRequest = {
  groups: MemoryGroup[];
  retainedPieces: Array<{
    id: string;
    groupId: string;
    sourceKind: "user" | "assistant" | "tool";
    previewText: string;
    visibility: "inline" | "omittable";
    createdSeq: number;
  }>;
  maxInlinePieces: number;
};
```

Response:

```ts
type PromptProjectionResponse = {
  inlinePieceIds: string[];
};
```

Validation rules:

- every `inlinePieceIds` entry must exist in `retainedPieces`
- `inlinePieceIds.length` must not exceed `maxInlinePieces`

## `source_chunk_batch`

Request:

```ts
type SourceChunkBatchRequest = {
  sources: Array<{
    sourceId: string;
    sourceKind: "assistant" | "tool";
    toolName?: string;
    content: unknown;
    pointer?: Record<string, unknown>;
  }>;
};
```

Response:

```ts
type SourceChunkBatchResponse = {
  results: Array<{
    sourceId: string;
    selectors: Array<
      | { kind: "whole" }
      | { kind: "line_range"; startLine: number; endLine: number }
      | { kind: "object_path"; path: Array<string | number> }
    >;
  }>;
};
```

The proxy materializes exact pieces from the original source using these selectors. User messages
are retained as whole pieces and do not go through `source_chunk_batch`.

## `context_get`

Tool schema:

```json
{
  "name": "context_get",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "pieceIds": {
        "type": "array",
        "items": { "type": "string" }
      },
      "offset": { "type": "integer", "minimum": 0 },
      "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
    }
  }
}
```

`context_get` supports two retrieval modes:

- `pieceIds`: fetch exact retained pieces by id
- `offset` + `limit`: page through hidden retained pieces in deterministic chronological order

The response contains exact stored payloads only. It skips pieces already included in the rewritten
prompt and pieces already returned by earlier `context_get(...)` calls in the same round.

## Prompt Memory Block

The rewritten prompt injects one synthetic developer message shaped like:

```xml
<pando_memory>
<exact_pieces>
<piece pieceId=piece_17 sourceKind=tool>
...
</piece>
</exact_pieces>
<context_get>
Use context_get({pieceIds:[...]}) when you know the needed piece ids.
Use context_get({offset,limit}) to browse additional retained exact pieces in chronological order.
Prefer attached exact pieces when they already contain the needed fact.
</context_get>
</pando_memory>
```

Internal groups are not rendered in the forwarded prompt.

## Logging

Important log events:

- `rewritten_context`
- `structured_model_selected`
- `structured_model_usage`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `context_get_fetch`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

`memory_round_decision` includes:

- `groupsBefore`
- `groupsAfter`
- `closedGroupIds`
- `replacedGroupIds`
- `pieceRetention`
- `inlinePieceIds`
- kept/dropped old-piece ids
- kept/dropped new-piece ids

`round_complete` includes the current group ids/count, piece ids/count, total stored piece bytes,
processed source count, inline piece ids/count, local fetch count, returned fetch ids, internal
structured-model usage totals, aggregate usage totals, and any memory-update error.
