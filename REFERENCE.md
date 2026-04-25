# Reference

This document describes the current shipped runtime schema and maintenance contracts.

## `Task`

```ts
type Task = {
  id: string;
  text: string;
  status: "open" | "closed";
  kind: "do";
};
```

## `Piece`

```ts
type ChunkSelector =
  | { kind: "whole" }
  | { kind: "line_range"; startLine: number; endLine: number }
  | { kind: "object_path"; path: Array<string | number> };

type PieceRecord = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  taskIds: string[];
  payloadInline?: unknown;
  payloadRef?: string;
  previewText?: string;
  pointer?: Record<string, unknown>;
  byteSize: number;
  createdSeq: number;
  selector: ChunkSelector;
};
```

## Session State

```ts
type MemoryState = {
  roundSeq: number;
  tasks: Task[];
  pieces: PieceRecord[];
  processedSourceIds: string[];
};
```

Large piece payloads may be written to per-session payload files and referenced through
`payloadRef`. Retrieval still returns the exact original payload.

## `round_update`

Request:

```ts
type RoundUpdateRequest = {
  tasks: Task[];
  retainedPieces: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    sourceId: string;
    toolName?: string;
    content: unknown;
    pointer?: Record<string, unknown>;
    taskIds: string[];
  }>;
  newPieces: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    sourceId: string;
    toolName?: string;
    content: unknown;
    pointer?: Record<string, unknown>;
  }>;
};
```

Response:

```ts
type PieceSelection =
  | { mode: "keep_all" }
  | { mode: "drop_all" }
  | { mode: "keep_only"; ids: string[] }
  | { mode: "drop_only"; ids: string[] };

type RoundUpdateResponse = {
  tasksAfter: Task[];
  pieceSelection: PieceSelection;
  keptPieceTaskLinks: Array<{
    id: string;
    taskIds: string[];
  }>;
};
```

Validation rules:

- every `tasksAfter` entry must have `id`, `text`, `status`, and `kind`
- `pieceSelection` applies to `newPieces`
- every kept new piece id must exist in `newPieces`
- every kept new piece must appear in `keptPieceTaskLinks`
- every linked task id in `keptPieceTaskLinks` must exist in `tasksAfter`
- older retained pieces remain only if their linked task ids still exist after cleanup

## `source_chunk`

Request:

```ts
type SourceChunkRequest = {
  sourceKind: "assistant" | "tool";
  toolName?: string;
  content: unknown;
  pointer?: Record<string, unknown>;
};
```

Response:

```ts
type SourceChunkResponse = {
  chunks: Array<
    | { kind: "whole" }
    | { kind: "line_range"; startLine: number; endLine: number }
    | { kind: "object_path"; path: Array<string | number> }
  >;
};
```

The proxy materializes exact pieces from the original source using these selectors.

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
<pando_task_memory>
<tasks>
- taskId=task:main status=open text=...
</tasks>
<exact_pieces>
<piece pieceId=piece_17 sourceKind=tool taskIds=task:main>
...
</piece>
</exact_pieces>
<context_get>
Use context_get({pieceIds:[...]}) when you know the needed piece ids.
Use context_get({offset,limit}) to browse additional retained exact pieces in chronological order.
</context_get>
</pando_task_memory>
```

## Logging

Important log events:

- `rewritten_context`
- `structured_model_selected`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `context_get_fetch`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

`memory_round_decision` includes:

- `taskIdsBefore`
- `tasksAfter`
- `pieceSelection`
- `keptPieceTaskLinks`
- kept/dropped old-piece ids
- kept/dropped new-piece ids

`round_complete` includes the active task ids/count, piece ids/count, total stored piece bytes,
processed source count, local fetch count, returned fetch ids, and any memory-update error.
