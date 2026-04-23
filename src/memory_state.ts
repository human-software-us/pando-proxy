export type Task = {
  id: string;
  text: string;
  status: "open" | "in_progress";
  kind: "say" | "do";
};

export type PieceSelector =
  | { kind: "whole" }
  | { kind: "line_range"; startLine: number; endLine: number }
  | { kind: "object_path"; path: Array<string | number> };

export type PieceDraft = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
  sourceId: string;
  toolName?: string;
  payloadInline: unknown;
  pointer?: Record<string, unknown>;
  previewText?: string;
  byteSize: number;
  selector: PieceSelector;
};

export type PieceRecord = {
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
  selector: PieceSelector;
};

export type MemoryState = {
  roundSeq: number;
  tasks: Task[];
  pieces: PieceRecord[];
  processedSourceIds: string[];
};

export type SessionRecord = {
  memory: MemoryState;
};

export function emptyMemoryState(): MemoryState {
  return {
    roundSeq: 0,
    tasks: [],
    pieces: [],
    processedSourceIds: [],
  };
}

export function emptySessionRecord(): SessionRecord {
  return {
    memory: emptyMemoryState(),
  };
}

export function liveTaskIdSet(state: Pick<MemoryState, "tasks">): Set<string> {
  return new Set(state.tasks.map((task) => task.id));
}

export function pruneMemoryToLiveTasks(state: MemoryState): MemoryState {
  const live = liveTaskIdSet(state);
  return {
    ...state,
    pieces: state.pieces
      .map((piece) => ({
        ...piece,
        taskIds: unique(piece.taskIds.filter((taskId) => live.has(taskId))),
      }))
      .filter((piece) => piece.taskIds.length > 0),
    processedSourceIds: unique(state.processedSourceIds),
  };
}

export function assertMemoryInvariant(state: MemoryState): void {
  const live = liveTaskIdSet(state);
  const errors: string[] = [];

  for (const task of state.tasks) {
    if (!task.id || !task.text) {
      errors.push("Every task must have id and text");
    }
    if (task.status !== "open" && task.status !== "in_progress") {
      errors.push(`Task ${task.id} has invalid status`);
    }
    if (task.kind !== "say" && task.kind !== "do") {
      errors.push(`Task ${task.id} has invalid kind`);
    }
  }

  const seenPieceIds = new Set<string>();
  for (const piece of state.pieces) {
    if (!piece.id || seenPieceIds.has(piece.id)) {
      errors.push(`Piece id must be unique and non-empty: ${piece.id}`);
    }
    seenPieceIds.add(piece.id);
    if (!piece.sourceId) {
      errors.push(`Piece ${piece.id} is missing sourceId`);
    }
    if (piece.taskIds.length === 0) {
      errors.push(`Piece ${piece.id} has no taskIds`);
    }
    for (const taskId of piece.taskIds) {
      if (!live.has(taskId)) {
        errors.push(`Piece ${piece.id} references missing task ${taskId}`);
      }
    }
    if (piece.payloadInline === undefined && !piece.payloadRef) {
      errors.push(`Piece ${piece.id} has no payload`);
    }
    if (piece.byteSize < 0) {
      errors.push(`Piece ${piece.id} has invalid byteSize`);
    }
  }

  if (state.processedSourceIds.some((id) => !id)) {
    errors.push("processedSourceIds must not contain empty values");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
