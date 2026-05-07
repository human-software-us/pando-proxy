import type { TextSpan } from "./source_selectors.ts";

export type ChunkSelector =
  | { kind: "whole" }
  | { kind: "chunks"; chunks: TextSpan[] }
  | { kind: "object_path"; path: Array<string | number> };

export type SourceKind = "user" | "assistant" | "tool" | "tool_call";

export type ActiveTask = {
  id: string;
  pieceIds: string[];
  startedRound: number;
  lastRound: number;
};

export type ArchivedTaskBundle = {
  id: string;
  pieces: MemoryPiece[];
  startedRound: number;
  archivedRound: number;
};

export type PieceDraft = {
  id: string;
  sourceKind: SourceKind;
  sourceId: string;
  toolName?: string;
  content: unknown;
  previewText: string;
  pointer?: Record<string, unknown>;
  byteSize: number;
  selector: ChunkSelector;
};

export type MemoryPiece = {
  id: string;
  sourceKind: SourceKind;
  sourceId: string;
  toolName?: string;
  previewText: string;
  pointer?: Record<string, unknown>;
  byteSize: number;
  createdSeq: number;
  selector: ChunkSelector;
  contentHash: string;
  duplicateSources?: DuplicateSource[];
};

export type DuplicateSource = {
  pieceId: string;
  sourceId: string;
  sourceKind: SourceKind;
  createdSeq?: number;
  toolName?: string;
  pointer?: Record<string, unknown>;
};

export type MaterializedMemoryPiece = MemoryPiece & {
  renderText: string;
};

export type MaterializedMemoryState = Omit<MemoryState, "pieces"> & {
  pieces: MaterializedMemoryPiece[];
};

export type MemoryState = {
  roundSeq: number;
  activeTask: ActiveTask | null;
  archivedTasks: ArchivedTaskBundle[];
  pieces: MemoryPiece[];
  processedSourceIds: string[];
};

export type SessionRecord = {
  memory: MemoryState;
};

export function emptyMemoryState(): MemoryState {
  return {
    roundSeq: 0,
    activeTask: null,
    archivedTasks: [],
    pieces: [],
    processedSourceIds: [],
  };
}

export function emptySessionRecord(): SessionRecord {
  return { memory: emptyMemoryState() };
}

export function pruneMemoryState(state: MemoryState): MemoryState {
  const pieces = dedupePieces(state.pieces ?? []);
  const pieceIds = new Set(pieces.map((piece) => piece.id));
  const rawActiveTask = state.activeTask && typeof state.activeTask === "object"
    ? state.activeTask
    : null;
  const activeTask = rawActiveTask
    ? {
      id: typeof rawActiveTask.id === "string" && rawActiveTask.id ? rawActiveTask.id : "task_1",
      pieceIds: unique(
        (rawActiveTask.pieceIds ?? []).filter((id): id is string =>
          typeof id === "string" && pieceIds.has(id)
        ),
      ),
      startedRound: nonNegativeInt(
        typeof rawActiveTask.startedRound === "number"
          ? rawActiveTask.startedRound
          : rawActiveTask.lastRound,
      ),
      lastRound: nonNegativeInt(rawActiveTask.lastRound),
    }
    : null;
  const archivedTasks = normalizeArchivedTasks(state.archivedTasks);
  return {
    roundSeq: nonNegativeInt(state.roundSeq),
    activeTask,
    archivedTasks,
    pieces,
    processedSourceIds: unique(
      (state.processedSourceIds ?? []).filter((id): id is string =>
        typeof id === "string" && id.length > 0
      ),
    ),
  };
}

export function allKnownPieces(state: MemoryState): MemoryPiece[] {
  return dedupePieces([
    ...state.pieces,
    ...state.archivedTasks.flatMap((task) => task.pieces),
  ]);
}

export function chronologicalPieces<T extends { createdSeq: number; id: string }>(
  pieces: T[],
): T[] {
  return [...pieces].sort((left, right) =>
    left.createdSeq === right.createdSeq
      ? left.id.localeCompare(right.id)
      : left.createdSeq - right.createdSeq
  );
}

export function dedupePieces(pieces: MemoryPiece[]): MemoryPiece[] {
  const byId = new Map<string, MemoryPiece>();
  for (const piece of pieces) {
    if (!piece?.id) {
      continue;
    }
    byId.set(piece.id, {
      id: piece.id,
      sourceKind: normalizeSourceKind(piece.sourceKind),
      sourceId: piece.sourceId,
      ...(piece.toolName ? { toolName: piece.toolName } : {}),
      previewText: typeof piece.previewText === "string" ? piece.previewText : "",
      ...(piece.pointer ? { pointer: piece.pointer } : {}),
      byteSize: nonNegativeInt(piece.byteSize),
      createdSeq: nonNegativeInt(piece.createdSeq),
      selector: piece.selector,
      contentHash: typeof piece.contentHash === "string" && piece.contentHash
        ? piece.contentHash
        : piece.id,
      ...normalizedDuplicateSources(piece.duplicateSources),
    });
  }
  return chronologicalPieces([...byId.values()]);
}

export function piecePreview(piece: Pick<MemoryPiece, "previewText">): string {
  if (typeof piece.previewText === "string" && piece.previewText.trim().length > 0) {
    return piece.previewText;
  }
  return "";
}

export function assertMemoryInvariant(state: MemoryState): void {
  const errors: string[] = [];
  const pieceIds = new Set<string>();
  for (const piece of state.pieces) {
    if (!piece.id || pieceIds.has(piece.id)) {
      errors.push(`Piece id must be unique and non-empty: ${piece.id}`);
    }
    pieceIds.add(piece.id);
    if (!piece.sourceId) {
      errors.push(`Piece ${piece.id} is missing sourceId`);
    }
    if (piece.byteSize < 0) {
      errors.push(`Piece ${piece.id} has invalid byteSize`);
    }
    if (!piece.contentHash) {
      errors.push(`Piece ${piece.id} is missing contentHash`);
    }
    for (const duplicate of piece.duplicateSources ?? []) {
      if (!duplicate.pieceId || !duplicate.sourceId) {
        errors.push(`Piece ${piece.id} has invalid duplicate source marker`);
      }
    }
  }

  if (state.activeTask) {
    if (!state.activeTask.id) {
      errors.push("activeTask must have an id");
    }
    for (const pieceId of state.activeTask.pieceIds) {
      if (!pieceIds.has(pieceId)) {
        errors.push(`activeTask references unknown piece ${pieceId}`);
      }
    }
  }

  for (const task of state.archivedTasks) {
    if (!task.id) {
      errors.push("archived task must have an id");
    }
    const archivedPieceIds = new Set<string>();
    for (const piece of task.pieces) {
      if (!piece.id || archivedPieceIds.has(piece.id)) {
        errors.push(`Archived task ${task.id} has invalid piece id ${piece.id}`);
      }
      archivedPieceIds.add(piece.id);
      if (!piece.sourceId) {
        errors.push(`Archived task ${task.id} piece ${piece.id} is missing sourceId`);
      }
      if (!piece.contentHash) {
        errors.push(`Archived task ${task.id} piece ${piece.id} is missing contentHash`);
      }
    }
  }

  if ((state.processedSourceIds ?? []).some((id) => !id)) {
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

function normalizeSourceKind(value: unknown): SourceKind {
  return value === "user" || value === "assistant" || value === "tool" || value === "tool_call"
    ? value
    : "assistant";
}

function normalizeArchivedTasks(value: unknown): ArchivedTaskBundle[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ArchivedTaskBundle[] = [];
  const seen = new Set<string>();
  for (const task of value) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      continue;
    }
    const record = task as Record<string, unknown>;
    const id = typeof record.id === "string" && record.id ? record.id : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const rawPieces = Array.isArray(record.pieces) ? record.pieces : [];
    out.push({
      id,
      pieces: dedupePieces(rawPieces as MemoryPiece[]),
      startedRound: nonNegativeInt(record.startedRound),
      archivedRound: nonNegativeInt(record.archivedRound),
    });
  }
  return out;
}

function normalizedDuplicateSources(value: unknown): { duplicateSources?: DuplicateSource[] } {
  if (!Array.isArray(value)) {
    return {};
  }
  const out: DuplicateSource[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const pieceId = typeof record.pieceId === "string" ? record.pieceId : "";
    const sourceId = typeof record.sourceId === "string" ? record.sourceId : "";
    if (!pieceId || !sourceId || seen.has(pieceId)) {
      continue;
    }
    seen.add(pieceId);
    out.push({
      pieceId,
      sourceId,
      sourceKind: normalizeSourceKind(record.sourceKind),
      ...(typeof record.createdSeq === "number"
        ? { createdSeq: nonNegativeInt(record.createdSeq) }
        : {}),
      ...(typeof record.toolName === "string" && record.toolName
        ? { toolName: record.toolName }
        : {}),
      ...(isRecord(record.pointer) ? { pointer: record.pointer } : {}),
    });
  }
  return out.length > 0 ? { duplicateSources: out } : {};
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
