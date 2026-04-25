import {
  activeGroups,
  chronologicalPieces,
  dedupeGroups,
  type MemoryGroup,
  type MemoryPiece,
  type MemoryState,
  type PieceDraft,
  pruneMemoryState,
  unique,
} from "./memory_state.ts";

export type GroupIntentRequest = {
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
    content: unknown;
    previewText: string;
    pointer?: Record<string, unknown>;
  }>;
};

export type GroupIntentResponse = {
  groupsAfter: MemoryGroup[];
  closedGroupIds: string[];
  replacedGroupIds: string[];
};

export type PieceRetentionBatchRequest = {
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

export type PieceRetentionDecision = {
  pieceId: string;
  keep: boolean;
  groupId?: string;
  supersedesPieceIds: string[];
  visibility: "inline" | "omittable";
};

export type PieceRetentionBatchResponse = {
  decisions: PieceRetentionDecision[];
};

export type PromptProjectionRequest = {
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

export type PromptProjectionResponse = {
  inlinePieceIds: string[];
};

export type SourceChunkBatchRequest = {
  sources: Array<{
    sourceId: string;
    sourceKind: "assistant" | "tool";
    toolName?: string;
    content: unknown;
    pointer?: Record<string, unknown>;
  }>;
};

export type SourceChunkBatchResponse = {
  results: Array<{
    sourceId: string;
    selectors: Array<
      | { kind: "whole" }
      | { kind: "line_range"; startLine: number; endLine: number }
      | { kind: "object_path"; path: Array<string | number> }
    >;
  }>;
};

export type GroupMemoryClients = {
  groupIntent: (request: GroupIntentRequest) => Promise<unknown>;
  pieceRetentionBatch: (request: PieceRetentionBatchRequest) => Promise<unknown>;
  promptProjection: (request: PromptProjectionRequest) => Promise<unknown>;
};

export type AppliedGroupUpdate = {
  memory: MemoryState;
  groupIntent: GroupIntentResponse;
  pieceRetention: PieceRetentionBatchResponse;
  promptProjection: PromptProjectionResponse;
  keptOldPieceIds: string[];
  droppedOldPieceIds: string[];
  keptNewPieceIds: string[];
  droppedNewPieceIds: string[];
};

export async function applyGroupUpdate(
  state: MemoryState,
  newPieces: PieceDraft[],
  clients: GroupMemoryClients,
  maxInlinePieces: number,
): Promise<AppliedGroupUpdate> {
  if (newPieces.length === 0) {
    return {
      memory: state,
      groupIntent: {
        groupsAfter: state.groups,
        closedGroupIds: [],
        replacedGroupIds: [],
      },
      pieceRetention: { decisions: [] },
      promptProjection: { inlinePieceIds: state.inlinePieceIds },
      keptOldPieceIds: state.pieces.map((piece) => piece.id),
      droppedOldPieceIds: [],
      keptNewPieceIds: [],
      droppedNewPieceIds: [],
    };
  }

  const nextSeq = state.roundSeq + 1;
  const groupIntent = await requestWithSingleRetry(
    () =>
      clients.groupIntent({
        groups: state.groups,
        retainedGroupAnchors: retainedPieceAnchors(state.pieces).map((anchor) => ({
          groupId: anchor.groupId,
          pieceId: anchor.id,
          sourceKind: anchor.sourceKind,
          sourceId: anchor.sourceId,
          ...(anchor.toolName ? { toolName: anchor.toolName } : {}),
          previewText: anchor.previewText,
          createdSeq: anchor.createdSeq,
        })),
        newUserPieces: newPieces
          .filter((piece) => piece.sourceKind === "user")
          .map((piece) => ({
            id: piece.id,
            sourceId: piece.sourceId,
            content: piece.payloadInline,
            previewText: piece.previewText,
            ...(piece.pointer ? { pointer: piece.pointer } : {}),
          })),
      }),
    (value) => parseAndValidateGroupIntent(value),
    "group_intent",
  );
  const groupsAfter = dedupeGroups(groupIntent.groupsAfter);
  const activeGroupIds = new Set(activeGroups(groupsAfter).map((group) => group.id));

  const pieceRetention = await requestWithSingleRetry(
    () =>
      clients.pieceRetentionBatch({
        groups: groupsAfter,
        retainedPieceAnchors: retainedPieceAnchors(state.pieces),
        newPieces: newPieces.map((piece) => ({
          id: piece.id,
          sourceKind: piece.sourceKind,
          sourceId: piece.sourceId,
          ...(piece.toolName ? { toolName: piece.toolName } : {}),
          content: piece.payloadInline,
          previewText: piece.previewText,
          ...(piece.pointer ? { pointer: piece.pointer } : {}),
        })),
      }),
    (value) => parseAndValidatePieceRetentionBatch(value, newPieces, groupsAfter, state.pieces),
    "piece_retention_batch",
  );

  const supersededPieceIds = new Set(
    pieceRetention.decisions.flatMap((decision) => decision.supersedesPieceIds),
  );
  const retiredGroupIds = new Set([
    ...groupIntent.closedGroupIds,
    ...groupIntent.replacedGroupIds,
  ]);
  const keptOldPieces = state.pieces.filter((piece) =>
    activeGroupIds.has(piece.groupId) &&
    !retiredGroupIds.has(piece.groupId) &&
    !supersededPieceIds.has(piece.id)
  );
  const decisionsByPieceId = new Map(
    pieceRetention.decisions.map((decision) => [decision.pieceId, decision] as const),
  );
  const keptNewPieces: MemoryPiece[] = newPieces
    .filter((piece) => decisionsByPieceId.get(piece.id)?.keep)
    .map((piece) => {
      const decision = decisionsByPieceId.get(piece.id)!;
      return {
        ...piece,
        groupId: decision.groupId!,
        visibility: decision.visibility,
        createdSeq: nextSeq,
      };
    });
  const retainedPieces = chronologicalPieces([...keptOldPieces, ...keptNewPieces]);
  const promptProjection = await requestWithSingleRetry(
    () =>
      clients.promptProjection({
        groups: groupsAfter,
        retainedPieces: retainedPieces.map((piece) => ({
          id: piece.id,
          groupId: piece.groupId,
          sourceKind: piece.sourceKind,
          previewText: piece.previewText,
          visibility: piece.visibility,
          createdSeq: piece.createdSeq,
        })),
        maxInlinePieces,
      }),
    (value) => parseAndValidatePromptProjection(value, retainedPieces, maxInlinePieces),
    "prompt_projection",
  );

  const memory = pruneMemoryState({
    roundSeq: nextSeq,
    groups: groupsAfter,
    pieces: retainedPieces,
    processedSourceIds: unique([
      ...state.processedSourceIds,
      ...newPieces.map((piece) => piece.sourceId),
    ]),
    inlinePieceIds: promptProjection.inlinePieceIds,
  });

  return {
    memory,
    groupIntent,
    pieceRetention,
    promptProjection,
    keptOldPieceIds: keptOldPieces.map((piece) => piece.id),
    droppedOldPieceIds: state.pieces.map((piece) => piece.id).filter((id) =>
      !keptOldPieces.some((piece) => piece.id === id)
    ),
    keptNewPieceIds: keptNewPieces.map((piece) => piece.id),
    droppedNewPieceIds: newPieces
      .map((piece) => piece.id)
      .filter((id) => !keptNewPieces.some((piece) => piece.id === id)),
  };
}

function retainedPieceAnchors(
  pieces: MemoryPiece[],
): PieceRetentionBatchRequest["retainedPieceAnchors"] {
  const byGroup = new Map<string, MemoryPiece[]>();
  for (const piece of chronologicalPieces(pieces)) {
    const groupPieces = byGroup.get(piece.groupId) ?? [];
    groupPieces.push(piece);
    byGroup.set(piece.groupId, groupPieces);
  }
  return [...byGroup.values()]
    .flatMap((groupPieces) => groupPieces.slice(-2))
    .map((piece) => ({
      id: piece.id,
      groupId: piece.groupId,
      sourceKind: piece.sourceKind,
      sourceId: piece.sourceId,
      ...(piece.toolName ? { toolName: piece.toolName } : {}),
      previewText: piece.previewText,
      createdSeq: piece.createdSeq,
    }));
}

async function requestWithSingleRetry<T>(
  invoke: () => Promise<unknown>,
  parse: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  name: string,
): Promise<T> {
  let lastErrors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await invoke();
    const parsed = parse(raw);
    if (parsed.ok) {
      return parsed.value;
    }
    lastErrors = parsed.errors;
  }
  throw new Error(`${name} validation failed: ${lastErrors.join("; ")}`);
}

function parseAndValidateGroupIntent(
  value: unknown,
): { ok: true; value: GroupIntentResponse } | { ok: false; errors: string[] } {
  const response = coerceGroupIntent(value);
  if (!response) {
    return { ok: false, errors: ["group_intent response must be an object"] };
  }
  const errors = validateGroupIntent(response);
  return errors.length === 0 ? { ok: true, value: response } : { ok: false, errors };
}

function validateGroupIntent(response: GroupIntentResponse): string[] {
  const errors: string[] = [];
  const groupIds = new Set<string>();
  for (const group of response.groupsAfter) {
    if (!group.id || groupIds.has(group.id)) {
      errors.push(`group ${group.id} must have a unique id`);
    }
    groupIds.add(group.id);
    if (group.status !== "active" && group.status !== "closed") {
      errors.push(`group ${group.id} has invalid status`);
    }
    if (!group.routingLabel) {
      errors.push(`group ${group.id} is missing routingLabel`);
    }
    if (!group.summary) {
      errors.push(`group ${group.id} is missing summary`);
    }
    if (!Number.isInteger(group.lastTouchedSeq) || group.lastTouchedSeq < 0) {
      errors.push(`group ${group.id} has invalid lastTouchedSeq`);
    }
  }
  const groupsAfterIds = new Set(response.groupsAfter.map((group) => group.id));
  for (const groupId of [...response.closedGroupIds, ...response.replacedGroupIds]) {
    if (!groupId) {
      errors.push("closed/replaced group ids must be non-empty");
    }
    if (groupsAfterIds.has(groupId)) {
      errors.push(`retired group ${groupId} must not also appear in groupsAfter`);
    }
  }
  return errors;
}

function parseAndValidatePieceRetentionBatch(
  value: unknown,
  newPieces: PieceDraft[],
  groupsAfter: MemoryGroup[],
  retainedPieces: MemoryPiece[],
): { ok: true; value: PieceRetentionBatchResponse } | { ok: false; errors: string[] } {
  const response = coercePieceRetentionBatch(value);
  if (!response) {
    return { ok: false, errors: ["piece_retention_batch response must be an object"] };
  }
  const errors = validatePieceRetentionBatch(response, newPieces, groupsAfter, retainedPieces);
  return errors.length === 0 ? { ok: true, value: response } : { ok: false, errors };
}

function validatePieceRetentionBatch(
  response: PieceRetentionBatchResponse,
  newPieces: PieceDraft[],
  groupsAfter: MemoryGroup[],
  retainedPieces: MemoryPiece[],
): string[] {
  const errors: string[] = [];
  const newPieceIds = new Set(newPieces.map((piece) => piece.id));
  const retainedPieceIds = new Set(retainedPieces.map((piece) => piece.id));
  const activeGroupIds = new Set(activeGroups(groupsAfter).map((group) => group.id));
  const seenDecisionIds = new Set<string>();

  for (const decision of response.decisions) {
    if (!newPieceIds.has(decision.pieceId)) {
      errors.push(`piece_retention_batch references unknown piece ${decision.pieceId}`);
      continue;
    }
    if (seenDecisionIds.has(decision.pieceId)) {
      errors.push(`piece_retention_batch duplicated piece ${decision.pieceId}`);
    }
    seenDecisionIds.add(decision.pieceId);
    if (decision.keep) {
      if (!decision.groupId || !activeGroupIds.has(decision.groupId)) {
        errors.push(`kept piece ${decision.pieceId} must reference an active group`);
      }
      if (decision.visibility !== "inline" && decision.visibility !== "omittable") {
        errors.push(`kept piece ${decision.pieceId} has invalid visibility`);
      }
    }
    for (const supersededId of decision.supersedesPieceIds) {
      if (!retainedPieceIds.has(supersededId)) {
        errors.push(`piece ${decision.pieceId} supersedes unknown piece ${supersededId}`);
      }
    }
  }

  for (const newPieceId of newPieceIds) {
    if (!seenDecisionIds.has(newPieceId)) {
      errors.push(`piece_retention_batch is missing a decision for ${newPieceId}`);
    }
  }

  return errors;
}

function parseAndValidatePromptProjection(
  value: unknown,
  retainedPieces: MemoryPiece[],
  maxInlinePieces: number,
): { ok: true; value: PromptProjectionResponse } | { ok: false; errors: string[] } {
  const response = coercePromptProjection(value);
  if (!response) {
    return { ok: false, errors: ["prompt_projection response must be an object"] };
  }
  const errors = validatePromptProjection(response, retainedPieces, maxInlinePieces);
  return errors.length === 0 ? { ok: true, value: response } : { ok: false, errors };
}

function validatePromptProjection(
  response: PromptProjectionResponse,
  retainedPieces: MemoryPiece[],
  maxInlinePieces: number,
): string[] {
  const retainedPieceIds = new Set(retainedPieces.map((piece) => piece.id));
  const errors: string[] = [];
  if (response.inlinePieceIds.length > Math.max(0, maxInlinePieces)) {
    errors.push("prompt_projection exceeded maxInlinePieces");
  }
  for (const pieceId of response.inlinePieceIds) {
    if (!retainedPieceIds.has(pieceId)) {
      errors.push(`prompt_projection references unknown retained piece ${pieceId}`);
    }
  }
  return errors;
}

function coerceGroupIntent(value: unknown): GroupIntentResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    groupsAfter: Array.isArray(record.groupsAfter)
      ? record.groupsAfter
        .filter((group): group is Record<string, unknown> =>
          Boolean(group) && typeof group === "object" && !Array.isArray(group)
        )
        .map((group) => ({
          id: String(group.id ?? ""),
          status: group.status === "closed" ? "closed" : "active",
          routingLabel: String(group.routingLabel ?? ""),
          summary: String(group.summary ?? ""),
          lastTouchedSeq: Math.max(0, Math.trunc(Number(group.lastTouchedSeq ?? 0))),
        }))
      : [],
    closedGroupIds: Array.isArray(record.closedGroupIds) ? record.closedGroupIds.map(String) : [],
    replacedGroupIds: Array.isArray(record.replacedGroupIds)
      ? record.replacedGroupIds.map(String)
      : [],
  };
}

function coercePieceRetentionBatch(value: unknown): PieceRetentionBatchResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    decisions: Array.isArray(record.decisions)
      ? record.decisions
        .filter((decision): decision is Record<string, unknown> =>
          Boolean(decision) && typeof decision === "object" && !Array.isArray(decision)
        )
        .map((decision) => ({
          pieceId: String(decision.pieceId ?? ""),
          keep: Boolean(decision.keep),
          ...(decision.groupId === null || decision.groupId === undefined
            ? { groupId: undefined }
            : { groupId: String(decision.groupId) }),
          supersedesPieceIds: Array.isArray(decision.supersedesPieceIds)
            ? decision.supersedesPieceIds.map(String)
            : [],
          visibility: decision.visibility === "omittable" ? "omittable" : "inline",
        }))
      : [],
  };
}

function coercePromptProjection(value: unknown): PromptProjectionResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    inlinePieceIds: Array.isArray(record.inlinePieceIds)
      ? unique(record.inlinePieceIds.map(String))
      : [],
  };
}
