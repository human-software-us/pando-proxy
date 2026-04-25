import { stableJson } from "./json.ts";

export type ChunkSelector =
  | { kind: "whole" }
  | { kind: "line_range"; startLine: number; endLine: number }
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
  payloadInline: unknown;
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
  visibility: "inline" | "omittable";
  payloadInline?: unknown;
  payloadRef?: string;
  previewText: string;
  pointer?: Record<string, unknown>;
  byteSize: number;
  createdSeq: number;
  selector: ChunkSelector;
};

export type MemoryState = {
  roundSeq: number;
  groups: MemoryGroup[];
  pieces: MemoryPiece[];
  processedSourceIds: string[];
  inlinePieceIds: string[];
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
    inlinePieceIds: [],
  };
}

export function emptySessionRecord(): SessionRecord {
  return { memory: emptyMemoryState() };
}

export function pruneMemoryState(state: MemoryState): MemoryState {
  const groups = dedupeGroups(state.groups ?? []);
  const groupIds = new Set(groups.map((group) => group.id));
  const pieces = dedupePieces(
    (state.pieces ?? []).filter((piece) => typeof piece?.groupId === "string" && groupIds.has(piece.groupId)),
  );
  const pieceIds = new Set(pieces.map((piece) => piece.id));
  return {
    roundSeq: Math.max(0, Math.trunc(state.roundSeq ?? 0)),
    groups,
    pieces,
    processedSourceIds: unique(
      (state.processedSourceIds ?? []).filter((id): id is string =>
        typeof id === "string" && id.length > 0
      ),
    ),
    inlinePieceIds: unique(
      (state.inlinePieceIds ?? []).filter((id): id is string =>
        typeof id === "string" && id.length > 0 && pieceIds.has(id)
      ),
    ),
  };
}

export function chronologicalPieces(pieces: MemoryPiece[]): MemoryPiece[] {
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
      ...piece,
      visibility: piece.visibility === "omittable" ? "omittable" : "inline",
      previewText: typeof piece.previewText === "string" ? piece.previewText : "",
    });
  }
  return chronologicalPieces([...byId.values()]);
}

export function piecePayload(piece: Pick<MemoryPiece, "payloadInline">): unknown {
  return piece.payloadInline;
}

export function piecePreview(piece: Pick<MemoryPiece, "previewText" | "payloadInline">): string {
  if (typeof piece.previewText === "string" && piece.previewText.trim().length > 0) {
    return piece.previewText;
  }
  const payload = piece.payloadInline;
  const text = typeof payload === "string" ? payload : stableJson(payload);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
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
    if (piece.visibility !== "inline" && piece.visibility !== "omittable") {
      errors.push(`Piece ${piece.id} has invalid visibility`);
    }
    if (piece.byteSize < 0) {
      errors.push(`Piece ${piece.id} has invalid byteSize`);
    }
    if (!piece.payloadRef && piece.payloadInline === undefined) {
      errors.push(`Piece ${piece.id} must have payloadInline or payloadRef`);
    }
  }

  if ((state.processedSourceIds ?? []).some((id) => !id)) {
    errors.push("processedSourceIds must not contain empty values");
  }
  if ((state.inlinePieceIds ?? []).some((id) => !pieceIds.has(id))) {
    errors.push("inlinePieceIds must reference retained pieces");
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
