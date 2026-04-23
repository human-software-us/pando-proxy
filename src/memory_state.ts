export type ChunkSelector =
  | { kind: "whole" }
  | { kind: "line_range"; startLine: number; endLine: number }
  | { kind: "object_path"; path: Array<string | number> };

export type ChunkDraft = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  payload: unknown;
  pointer?: Record<string, unknown>;
  byteSize: number;
  selector: ChunkSelector;
};

export type ChunkRecord = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  payload: unknown;
  pointer?: Record<string, unknown>;
  byteSize: number;
  createdSeq: number;
  selector: ChunkSelector;
};

export type MemoryState = {
  roundSeq: number;
  objective: string | null;
  chunks: ChunkRecord[];
  processedSourceIds: string[];
};

export type SessionRecord = {
  memory: MemoryState;
};

export function emptyMemoryState(): MemoryState {
  return {
    roundSeq: 0,
    objective: null,
    chunks: [],
    processedSourceIds: [],
  };
}

export function emptySessionRecord(): SessionRecord {
  return {
    memory: emptyMemoryState(),
  };
}

export function pruneMemoryState(state: MemoryState): MemoryState {
  return {
    ...state,
    objective: normalizeObjective(state.objective),
    chunks: dedupeChunks(state.chunks),
    processedSourceIds: unique(state.processedSourceIds),
  };
}

export function chronologicalChunks(chunks: ChunkRecord[]): ChunkRecord[] {
  return [...chunks].sort((left, right) =>
    left.createdSeq === right.createdSeq ? left.id.localeCompare(right.id) : left.createdSeq - right.createdSeq
  );
}

export function assertMemoryInvariant(state: MemoryState): void {
  const errors: string[] = [];

  if (state.objective !== null && typeof state.objective !== "string") {
    errors.push("objective must be string or null");
  }

  const seenChunkIds = new Set<string>();
  for (const chunk of state.chunks) {
    if (!chunk.id || seenChunkIds.has(chunk.id)) {
      errors.push(`Chunk id must be unique and non-empty: ${chunk.id}`);
    }
    seenChunkIds.add(chunk.id);
    if (!chunk.sourceId) {
      errors.push(`Chunk ${chunk.id} is missing sourceId`);
    }
    if (chunk.payload === undefined) {
      errors.push(`Chunk ${chunk.id} has no payload`);
    }
    if (chunk.byteSize < 0) {
      errors.push(`Chunk ${chunk.id} has invalid byteSize`);
    }
  }

  if (state.processedSourceIds.some((id) => !id)) {
    errors.push("processedSourceIds must not contain empty values");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export function dedupeChunks(chunks: ChunkRecord[]): ChunkRecord[] {
  const map = new Map<string, ChunkRecord>();
  for (const chunk of chunks) {
    map.set(chunk.id, chunk);
  }
  return chronologicalChunks([...map.values()]);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeObjective(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
