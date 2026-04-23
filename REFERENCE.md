# Reference

## Chunk

```ts
type ChunkRecord = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  payload: unknown;
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
  objective: string | null;
  chunks: ChunkRecord[];
  processedSourceIds: string[];
};
```

## `working_memory_update`

Request:

```ts
type WorkingMemoryUpdateRequest = {
  objective: string | null;
  chunks: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    toolName?: string;
    content: unknown;
  }>;
  newChunks: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    toolName?: string;
    content: unknown;
  }>;
};
```

Response:

```ts
type WorkingMemoryUpdateResponse = {
  objectiveAfter: string | null;
  keepOldChunkIds: string[];
  keepNewChunkIds: string[];
};
```

Validation rules:

- every kept old id must exist in the prior kept set
- every kept new id must exist in the new chunk set
- duplicate ids are invalid
- if `objectiveAfter` is `null`, both keep lists should usually be empty
- anything not explicitly kept is dropped

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

## `memory`

Tool schema:

```json
{
  "name": "memory",
  "parameters": {
    "type": "object",
    "required": ["offset", "limit"],
    "properties": {
      "offset": { "type": "integer", "minimum": 0 },
      "limit": { "type": "integer", "minimum": 1, "maximum": 50 }
    }
  }
}
```

The response contains exact stored payloads for the chronological retained-memory slice selected by `offset` and `limit`, excluding chunks already included in the rewritten prompt.

## Logging

Important log events:

- `rewritten_context`
- `structured_model_selected`
- `memory_round_sources`
- `memory_round_chunked`
- `memory_round_decision`
- `memory_fetch`
- `memory_round_updated`
- `memory_state_saved`
- `round_complete`

`round_complete` is the round-level aggregate record. It should include the current objective, chunk ids/count, total stored chunk bytes, processed source count, local fetch count, returned fetch ids, and any memory-update error.
