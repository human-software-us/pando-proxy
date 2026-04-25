import type { TextSpan } from "./source_selectors.ts";

export type ChunkSelector =
  | { kind: "whole" }
  | { kind: "text_spans"; spans: TextSpan[] }
  | { kind: "object_path"; path: Array<string | number> };

export type MemoryGroup = {
  id: string;
  status: "active" | "closed";
  routingLabel: string;
  summary: string;
  lastTouchedSeq: number;
};

export type PieceDraft = {
  id: string;
  sourceKind: "user" | "assistant" | "tool";
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

export type MaterializedMemoryPiece = MemoryPiece & {
  renderText: string;
};

export type MaterializedMemoryState = Omit<MemoryState, "pieces"> & {
  pieces: MaterializedMemoryPiece[];
};

export type MemoryState = {
  roundSeq: number;
  groups: MemoryGroup[];
  pieces: MemoryPiece[];
  processedSourceIds: string[];
};

export type SessionRecord = {
  memory: MemoryState;
};

export function emptyMemoryState(): MemoryState {
  return {
    roundSeq: 0,
    groups: [],
    pieces: [],
    processedSourceIds: [],
  };
}

export function emptySessionRecord(): SessionRecord {
  return { memory: emptyMemoryState() };
}

export function pruneMemoryState(state: MemoryState): MemoryState {
  const groups = dedupeGroups(state.groups ?? []);
  const groupIds = new Set(groups.map((group) => group.id));
  const pieces = dedupePieces(
    (state.pieces ?? []).filter((piece) =>
      typeof piece?.groupId === "string" && groupIds.has(piece.groupId)
    ),
  );
  return {
    roundSeq: Math.max(0, Math.trunc(state.roundSeq ?? 0)),
    groups,
    pieces,
    processedSourceIds: unique(
      (state.processedSourceIds ?? []).filter((id): id is string =>
        typeof id === "string" && id.length > 0
      ),
    ),
  };
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

export function dedupeGroups(groups: MemoryGroup[]): MemoryGroup[] {
  const byId = new Map<string, MemoryGroup>();
  for (const group of groups) {
    if (!group?.id) {
      continue;
    }
    byId.set(group.id, {
      ...group,
      status: group.status === "closed" ? "closed" : "active",
      routingLabel: typeof group.routingLabel === "string" ? group.routingLabel : "",
      summary: typeof group.summary === "string" ? group.summary : "",
      lastTouchedSeq: Math.max(0, Math.trunc(group.lastTouchedSeq ?? 0)),
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function dedupePieces(pieces: MemoryPiece[]): MemoryPiece[] {
  const byId = new Map<string, MemoryPiece>();
  for (const piece of pieces) {
    if (!piece?.id) {
      continue;
    }
    byId.set(piece.id, {
      id: piece.id,
      groupId: piece.groupId,
      sourceKind: piece.sourceKind,
      sourceId: piece.sourceId,
      ...(piece.toolName ? { toolName: piece.toolName } : {}),
      previewText: typeof piece.previewText === "string" ? piece.previewText : "",
      ...(piece.pointer ? { pointer: piece.pointer } : {}),
      byteSize: Math.max(0, Math.trunc(piece.byteSize ?? 0)),
      createdSeq: Math.max(0, Math.trunc(piece.createdSeq ?? 0)),
      selector: piece.selector,
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

export function activeGroups(groups: MemoryGroup[]): MemoryGroup[] {
  return groups.filter((group) => group.status === "active");
}

export function assertMemoryInvariant(state: MemoryState): void {
  const errors: string[] = [];
  const groupIds = new Set<string>();
  for (const group of state.groups) {
    if (!group.id || groupIds.has(group.id)) {
      errors.push(`Group id must be unique and non-empty: ${group.id}`);
    }
    groupIds.add(group.id);
    if (group.status !== "active" && group.status !== "closed") {
      errors.push(`Group ${group.id} has invalid status`);
    }
    if (!group.routingLabel || typeof group.routingLabel !== "string") {
      errors.push(`Group ${group.id} is missing routingLabel`);
    }
    if (!group.summary || typeof group.summary !== "string") {
      errors.push(`Group ${group.id} is missing summary`);
    }
    if (!Number.isInteger(group.lastTouchedSeq) || group.lastTouchedSeq < 0) {
      errors.push(`Group ${group.id} has invalid lastTouchedSeq`);
    }
  }

  const pieceIds = new Set<string>();
  for (const piece of state.pieces) {
    if (!piece.id || pieceIds.has(piece.id)) {
      errors.push(`Piece id must be unique and non-empty: ${piece.id}`);
    }
    pieceIds.add(piece.id);
    if (!piece.sourceId) {
      errors.push(`Piece ${piece.id} is missing sourceId`);
    }
    if (!groupIds.has(piece.groupId)) {
      errors.push(`Piece ${piece.id} references unknown group id`);
    }
    if (piece.byteSize < 0) {
      errors.push(`Piece ${piece.id} has invalid byteSize`);
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
