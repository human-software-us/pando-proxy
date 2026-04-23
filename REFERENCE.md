# Reference

## Task

```ts
type Task = {
  id: string;
  text: string;
  status: "open" | "in_progress";
  kind: "say" | "do";
};
```

## Piece

```ts
type PieceRecord = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  taskIds: string[];
  payloadInline?: unknown;
  payloadRef?: string;
  pointer?: Record<string, unknown>;
  previewText?: string;
  byteSize: number;
  createdSeq: number;
  selector:
    | { kind: "whole" }
    | { kind: "line_range"; startLine: number; endLine: number }
    | { kind: "object_path"; path: Array<string | number> };
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

## `round_update`

Request:

```ts
type RoundUpdateRequest = {
  tasks: Task[];
  newPieces: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    toolName?: string;
    content: unknown;
    pointer?: Record<string, unknown>;
  }>;
};
```

Response:

```ts
type RoundUpdateResponse = {
  tasksAfter: Task[];
  pieceSelection:
    | { mode: "drop_all" }
    | { mode: "keep_all" }
    | { mode: "keep_only"; ids: string[] }
    | { mode: "drop_only"; ids: string[] };
  keptPieceTaskLinks: Array<{
    id: string;
    taskIds: string[];
  }>;
};
```

Validation rules:

- `pieceSelection` must be explicit
- `keptPieceTaskLinks` must exactly match the kept set implied by `pieceSelection`
- every kept piece must link to at least one live task
- dropped pieces must not appear in `keptPieceTaskLinks`

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

The proxy materializes exact chunks from the original source using these selectors.

## `context_get`

Tool schema:

```json
{
  "name": "context_get",
  "parameters": {
    "type": "object",
    "required": ["pieceIds"],
    "properties": {
      "pieceIds": {
        "type": "array",
        "items": { "type": "string" }
      }
    }
  }
}
```

The response contains exact stored payloads for those exact ids only.

## Logging

Important log events:

- `rewritten_context`
- `structured_model_selected`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `context_get`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

`round_complete` is the round-level aggregate record. It includes current task ids/count, piece ids/count, total stored piece bytes, processed source count, local fetch count, returned fetch ids, and any memory-update error.
