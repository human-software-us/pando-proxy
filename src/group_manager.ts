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
import type { TextSpan } from "./source_selectors.ts";

export type GroupIntentRequest = {
  groups: MemoryGroup[];
  retainedGroupAnchors: Array<{
    groupId: string;
    pieceId: string;
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
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
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
    sourceId: string;
    toolName?: string;
    previewText: string;
    createdSeq: number;
  }>;
  newPieces: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
    sourceId: string;
    toolName?: string;
    previewText: string;
    byteSize: number;
    selector: PieceDraft["selector"];
    pointer?: Record<string, unknown>;
  }>;
};

export type PieceRetentionDecision = {
  pieceId: string;
  keep: boolean;
  groupId: string | null;
  supersedesPieceIds: string[];
  dropConfidence?: DropConfidence;
  dropReason?: DropReason | null;
};

export type PieceRetentionBatchResponse = {
  decisions: PieceRetentionDecision[];
};

export type RetainedPiecePruneRequest = {
  groups: MemoryGroup[];
  retainedOldPieces: Array<{
    id: string;
    groupId: string;
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
    sourceId: string;
    toolName?: string;
    previewText: string;
    createdSeq: number;
  }>;
  keptNewPieces: Array<{
    id: string;
    groupId: string;
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
    sourceId: string;
    toolName?: string;
    previewText: string;
    createdSeq: number;
  }>;
};

export type RetainedPiecePruneResponse = {
  dropPieceIds: string[];
  dropDecisions?: RetainedPieceDropDecision[];
};

export type DropConfidence = "certain" | "probable" | "uncertain";

export type DropReason =
  | "duplicate"
  | "transient_formatting"
  | "ack_only"
  | "tool_noise"
  | "superseded"
  | "synthetic_memory"
  | "empty_or_invalid";

export type RetainedPieceDropDecision = {
  pieceId: string;
  dropConfidence: DropConfidence;
  dropReason: DropReason;
};

export type SourceChunkBatchRequest = {
  sources: Array<{
    sourceId: string;
    sourceKind: "user" | "assistant" | "tool" | "tool_call";
    toolName?: string;
    contentText: string;
    pointer?: Record<string, unknown>;
  }>;
};

export type SourceChunkBatchResponse = {
  results: Array<{
    sourceId: string;
    selectors: Array<
      | { kind: "whole" }
      | { kind: "text_spans"; spans: TextSpan[] }
    >;
  }>;
};

export type GroupMemoryClients = {
  groupIntent: (request: GroupIntentRequest, attempt?: number) => Promise<unknown>;
  pieceRetentionBatch: (request: PieceRetentionBatchRequest, attempt?: number) => Promise<unknown>;
  retainedPiecePrune: (request: RetainedPiecePruneRequest, attempt?: number) => Promise<unknown>;
};

export type AppliedGroupUpdate = {
  memory: MemoryState;
  groupIntent: GroupIntentResponse;
  pieceRetention: PieceRetentionBatchResponse;
  retainedPiecePrune: RetainedPiecePruneResponse;
  keptOldPieceIds: string[];
  droppedOldPieceIds: string[];
  keptNewPieceIds: string[];
  droppedNewPieceIds: string[];
};

export async function requestGroupIntent(
  state: MemoryState,
  newUserPieces: GroupIntentRequest["newUserPieces"],
  clients: GroupMemoryClients,
): Promise<GroupIntentResponse> {
  const groupIntent = await requestWithSingleRetry(
    (attempt) =>
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
        newUserPieces,
      }, attempt),
    parseAndValidateGroupIntent,
    "group_intent",
  );
  return {
    ...groupIntent,
    groupsAfter: dedupeGroups(groupIntent.groupsAfter),
  };
}

// Sentinel group id holding tool-call (function_call) pieces. Tool calls are always
// added to memory on first capture and bypass the LLM keep/drop decision; they
// remain subject to retainedPiecePrune in subsequent rounds like everything else.
// Tool *outputs* (function_call_output) follow the normal LLM-driven retention path.
export const TOOL_CALL_GROUP_ID = "_tool_calls";
const DEFAULT_RETAINED_GROUP_ID = "_retained";
const CERTAIN_DROP_REASONS = new Set<DropReason>([
  "duplicate",
  "transient_formatting",
  "ack_only",
  "tool_noise",
  "superseded",
  "synthetic_memory",
  "empty_or_invalid",
]);

function ensureToolCallGroup(groups: MemoryGroup[], roundSeq: number): MemoryGroup[] {
  if (groups.some((group) => group.id === TOOL_CALL_GROUP_ID)) {
    return groups;
  }
  return [
    ...groups,
    {
      id: TOOL_CALL_GROUP_ID,
      status: "active",
      routingLabel: "tool_calls",
      summary: "Retained exact tool call invocations.",
      lastTouchedSeq: roundSeq,
    },
  ];
}

function ensureDefaultRetainedGroup(groups: MemoryGroup[], roundSeq: number): MemoryGroup[] {
  if (activeGroups(groups).length > 0) {
    return groups;
  }
  if (groups.some((group) => group.id === DEFAULT_RETAINED_GROUP_ID)) {
    return groups.map((group) =>
      group.id === DEFAULT_RETAINED_GROUP_ID ? { ...group, status: "active" } : group
    );
  }
  return [
    ...groups,
    {
      id: DEFAULT_RETAINED_GROUP_ID,
      status: "active",
      routingLabel: "retained_context",
      summary: "Conservatively retained exact context pieces.",
      lastTouchedSeq: roundSeq,
    },
  ];
}

function preserveRetainedGroups(
  groupIntent: GroupIntentResponse,
  state: MemoryState,
  needsDefaultGroup: boolean,
  roundSeq: number,
): GroupIntentResponse {
  const groupsWithDefault = needsDefaultGroup
    ? ensureDefaultRetainedGroup(groupIntent.groupsAfter, roundSeq)
    : groupIntent.groupsAfter;
  const groupsById = new Map(groupsWithDefault.map((group) => [group.id, group] as const));
  const pieceGroupIds = new Set(state.pieces.map((piece) => piece.groupId));
  for (const group of state.groups) {
    if (!pieceGroupIds.has(group.id) || groupsById.has(group.id)) {
      continue;
    }
    groupsById.set(group.id, {
      ...group,
      status: "active",
      lastTouchedSeq: Math.max(group.lastTouchedSeq, roundSeq),
    });
  }
  return {
    groupsAfter: dedupeGroups([...groupsById.values()]),
    closedGroupIds: groupIntent.closedGroupIds.filter((id) => !pieceGroupIds.has(id)),
    replacedGroupIds: groupIntent.replacedGroupIds.filter((id) => !pieceGroupIds.has(id)),
  };
}

export async function applyGroupUpdate(
  state: MemoryState,
  newPieces: PieceDraft[],
  groupIntent: GroupIntentResponse,
  clients: GroupMemoryClients,
): Promise<AppliedGroupUpdate> {
  if (newPieces.length === 0) {
    return {
      memory: state,
      groupIntent,
      pieceRetention: { decisions: [] },
      retainedPiecePrune: { dropPieceIds: [] },
      keptOldPieceIds: state.pieces.map((piece) => piece.id),
      droppedOldPieceIds: [],
      keptNewPieceIds: [],
      droppedNewPieceIds: [],
    };
  }

  const nextSeq = state.roundSeq + 1;
  // Partition: tool *calls* (sourceKind "tool_call") are always kept on first capture
  // under a sentinel group. Everything else (user/assistant/tool-outputs) still goes
  // through the LLM keep/drop decision.
  const toolCallPieces = newPieces.filter((piece) => piece.sourceKind === "tool_call");
  const otherPieces = newPieces.filter((piece) => piece.sourceKind !== "tool_call");
  const hasOldToolCallPieces = state.pieces.some((piece) => piece.groupId === TOOL_CALL_GROUP_ID);
  const effectiveGroupIntent = preserveRetainedGroups(
    {
      ...groupIntent,
      groupsAfter: (toolCallPieces.length > 0 || hasOldToolCallPieces)
        ? ensureToolCallGroup(groupIntent.groupsAfter, nextSeq)
        : groupIntent.groupsAfter,
    },
    state,
    otherPieces.length > 0,
    nextSeq,
  );
  const groupsAfter = effectiveGroupIntent.groupsAfter;
  const activeGroupIds = new Set(activeGroups(groupsAfter).map((group) => group.id));

  const pieceRetention: PieceRetentionBatchResponse = otherPieces.length === 0
    ? { decisions: [] }
    : await requestWithSingleRetry(
      (attempt) =>
        clients.pieceRetentionBatch({
          groups: groupsAfter,
          retainedPieceAnchors: retainedPieceAnchors(state.pieces),
          newPieces: otherPieces.map((piece) => ({
            id: piece.id,
            sourceKind: piece.sourceKind,
            sourceId: piece.sourceId,
            ...(piece.toolName ? { toolName: piece.toolName } : {}),
            previewText: piece.previewText,
            byteSize: piece.byteSize,
            selector: piece.selector,
            ...(piece.pointer ? { pointer: piece.pointer } : {}),
          })),
        }, attempt),
      (value) => parseAndValidatePieceRetentionBatch(value, otherPieces, groupsAfter, state.pieces),
      "piece_retention_batch",
    );

  // Synthesize keep=true decisions for tool-call pieces so the rest of the function
  // treats them like any other kept piece. Subsequent rounds can prune them via
  // retainedPiecePrune like everything else.
  const synthesizedToolCallDecisions: PieceRetentionDecision[] = toolCallPieces.map((piece) => ({
    pieceId: piece.id,
    keep: true,
    groupId: TOOL_CALL_GROUP_ID,
    supersedesPieceIds: [],
  }));
  const allDecisions = [
    ...conservativePieceRetentionDecisions(pieceRetention.decisions, otherPieces, groupsAfter),
    ...synthesizedToolCallDecisions,
  ];
  const decisionsByPieceId = new Map(
    allDecisions.map((decision) => [decision.pieceId, decision] as const),
  );
  const supersededPieceIds = new Set(
    allDecisions.flatMap((decision) =>
      isCertainDropDecision(decision) && decision.dropReason === "superseded"
        ? decision.supersedesPieceIds
        : []
    ),
  );

  const prelimKeptOldPieces = state.pieces.filter((piece) =>
    activeGroupIds.has(piece.groupId) &&
    !supersededPieceIds.has(piece.id)
  );
  const keptNewPieces: MemoryPiece[] = newPieces
    .filter((piece) => decisionsByPieceId.get(piece.id)?.keep)
    .filter((piece) => !supersededPieceIds.has(piece.id))
    .map((piece) => {
      const decision = decisionsByPieceId.get(piece.id)!;
      return {
        id: piece.id,
        sourceKind: piece.sourceKind,
        sourceId: piece.sourceId,
        ...(piece.toolName ? { toolName: piece.toolName } : {}),
        previewText: piece.previewText,
        ...(piece.pointer ? { pointer: piece.pointer } : {}),
        byteSize: piece.byteSize,
        selector: piece.selector,
        groupId: decision.groupId!,
        createdSeq: nextSeq,
      };
    });

  const retainedPiecePrune = prelimKeptOldPieces.length === 0
    ? { dropPieceIds: [] }
    : await requestWithSingleRetry(
      (attempt) =>
        clients.retainedPiecePrune({
          groups: groupsAfter,
          retainedOldPieces: prelimKeptOldPieces.map((piece) => ({
            id: piece.id,
            groupId: piece.groupId,
            sourceKind: piece.sourceKind,
            sourceId: piece.sourceId,
            ...(piece.toolName ? { toolName: piece.toolName } : {}),
            previewText: piece.previewText,
            createdSeq: piece.createdSeq,
          })),
          keptNewPieces: keptNewPieces.map((piece) => ({
            id: piece.id,
            groupId: piece.groupId,
            sourceKind: piece.sourceKind,
            sourceId: piece.sourceId,
            ...(piece.toolName ? { toolName: piece.toolName } : {}),
            previewText: piece.previewText,
            createdSeq: piece.createdSeq,
          })),
        }, attempt),
      (value) => parseAndValidateRetainedPiecePrune(value, prelimKeptOldPieces, keptNewPieces),
      "retained_piece_prune",
    );

  const prunedPieceIds = new Set(retainedPiecePrune.dropPieceIds);
  const keptOldPieces = prelimKeptOldPieces.filter((piece) => !prunedPieceIds.has(piece.id));
  const memory = pruneMemoryState({
    roundSeq: nextSeq,
    groups: groupsAfter,
    pieces: chronologicalPieces([...keptOldPieces, ...keptNewPieces]),
    processedSourceIds: unique([
      ...state.processedSourceIds,
      ...newPieces.map((piece) => piece.sourceId),
    ]),
  });

  return {
    memory,
    groupIntent: effectiveGroupIntent,
    pieceRetention,
    retainedPiecePrune,
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
  invoke: (attempt: number) => Promise<unknown>,
  parse: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  name: string,
): Promise<T> {
  let lastErrors: string[] = [];
  let lastInvokeError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let raw: unknown;
    try {
      raw = await invoke(attempt);
    } catch (error) {
      lastInvokeError = error;
      continue;
    }
    const parsed = parse(raw);
    if (parsed.ok) {
      return parsed.value;
    }
    lastErrors = parsed.errors;
  }
  if (lastInvokeError && lastErrors.length === 0) {
    throw lastInvokeError;
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
  const conservative = {
    decisions: conservativePieceRetentionDecisions(response.decisions, newPieces, groupsAfter),
  };
  const errors = validatePieceRetentionBatch(conservative, newPieces, groupsAfter, retainedPieces);
  return errors.length === 0 ? { ok: true, value: conservative } : { ok: false, errors };
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
  const supersedablePieceIds = new Set([...retainedPieceIds, ...newPieceIds]);
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
    if (decision.keep && (!decision.groupId || !activeGroupIds.has(decision.groupId))) {
      errors.push(`kept piece ${decision.pieceId} must reference an active group`);
    }
    for (const supersededId of decision.supersedesPieceIds) {
      if (supersededId === decision.pieceId) {
        errors.push(`piece ${decision.pieceId} must not supersede itself`);
      } else if (!supersedablePieceIds.has(supersededId)) {
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

function conservativePieceRetentionDecisions(
  decisions: PieceRetentionDecision[],
  newPieces: PieceDraft[],
  groupsAfter: MemoryGroup[],
): PieceRetentionDecision[] {
  const activeGroupIds = activeGroups(groupsAfter).map((group) => group.id);
  const fallbackGroupId = activeGroupIds[0] ?? DEFAULT_RETAINED_GROUP_ID;
  const decisionsByPieceId = new Map(decisions.map((decision) => [decision.pieceId, decision]));
  return newPieces.map((piece) => {
    const decision = decisionsByPieceId.get(piece.id);
    if (!decision) {
      return keepPieceDecision(piece.id, fallbackGroupId);
    }
    if (decision.keep) {
      const groupId = decision.groupId && activeGroupIds.includes(decision.groupId)
        ? decision.groupId
        : fallbackGroupId;
      return {
        ...decision,
        keep: true,
        groupId,
        supersedesPieceIds: isCertainDropDecision(decision) &&
            decision.dropReason === "superseded"
          ? decision.supersedesPieceIds
          : [],
      };
    }
    if (!isCertainDropDecision(decision)) {
      return keepPieceDecision(piece.id, fallbackGroupId);
    }
    return {
      ...decision,
      keep: false,
      groupId: null,
      supersedesPieceIds: [],
    };
  });
}

function keepPieceDecision(pieceId: string, groupId: string): PieceRetentionDecision {
  return {
    pieceId,
    keep: true,
    groupId,
    supersedesPieceIds: [],
    dropConfidence: "uncertain",
    dropReason: null,
  };
}

function isCertainDropDecision(
  decision: Pick<PieceRetentionDecision, "dropConfidence" | "dropReason">,
): decision is PieceRetentionDecision & { dropConfidence: "certain"; dropReason: DropReason } {
  return decision.dropConfidence === "certain" &&
    typeof decision.dropReason === "string" &&
    CERTAIN_DROP_REASONS.has(decision.dropReason);
}

function parseAndValidateRetainedPiecePrune(
  value: unknown,
  retainedOldPieces: MemoryPiece[],
  keptNewPieces: MemoryPiece[],
): { ok: true; value: RetainedPiecePruneResponse } | { ok: false; errors: string[] } {
  const response = coerceRetainedPiecePrune(value);
  if (!response) {
    return { ok: false, errors: ["retained_piece_prune response must be an object"] };
  }
  const conservative = conservativeRetainedPiecePrune(response);
  const errors = validateRetainedPiecePrune(conservative, retainedOldPieces, keptNewPieces);
  return errors.length === 0 ? { ok: true, value: conservative } : { ok: false, errors };
}

function validateRetainedPiecePrune(
  response: RetainedPiecePruneResponse,
  retainedOldPieces: MemoryPiece[],
  keptNewPieces: MemoryPiece[],
): string[] {
  const retainedOldIds = new Set(retainedOldPieces.map((piece) => piece.id));
  const seenDropIds = new Set<string>();
  const errors: string[] = [];
  for (const pieceId of response.dropPieceIds) {
    if (!retainedOldIds.has(pieceId)) {
      const newPiece = keptNewPieces.some((piece) => piece.id === pieceId);
      errors.push(
        newPiece
          ? `retained_piece_prune cannot drop newly kept piece ${pieceId}`
          : `retained_piece_prune references unknown old piece ${pieceId}`,
      );
      continue;
    }
    if (seenDropIds.has(pieceId)) {
      errors.push(`retained_piece_prune duplicated piece ${pieceId}`);
    }
    seenDropIds.add(pieceId);
  }
  for (const decision of response.dropDecisions ?? []) {
    if (!isCertainRetainedDropDecision(decision)) {
      errors.push(
        `retained_piece_prune drop ${decision.pieceId} must be certain with a known reason`,
      );
    }
  }
  return errors;
}

function conservativeRetainedPiecePrune(
  response: RetainedPiecePruneResponse,
): RetainedPiecePruneResponse {
  const certainDropIds = unique(
    (response.dropDecisions ?? [])
      .filter(isCertainRetainedDropDecision)
      .map((decision) => decision.pieceId),
  );
  return {
    dropPieceIds: certainDropIds,
    dropDecisions: (response.dropDecisions ?? []).filter(isCertainRetainedDropDecision),
  };
}

function isCertainRetainedDropDecision(
  decision: RetainedPieceDropDecision,
): boolean {
  return decision.dropConfidence === "certain" && CERTAIN_DROP_REASONS.has(decision.dropReason);
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
          groupId: decision.groupId === null || decision.groupId === undefined
            ? null
            : String(decision.groupId),
          supersedesPieceIds: Array.isArray(decision.supersedesPieceIds)
            ? decision.supersedesPieceIds.map(String)
            : [],
          dropConfidence: coerceDropConfidence(decision.dropConfidence),
          dropReason: coerceDropReason(decision.dropReason),
        }))
      : [],
  };
}

function coerceRetainedPiecePrune(value: unknown): RetainedPiecePruneResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    dropPieceIds: Array.isArray(record.dropPieceIds) ? unique(record.dropPieceIds.map(String)) : [],
    dropDecisions: Array.isArray(record.dropDecisions)
      ? record.dropDecisions
        .filter((decision): decision is Record<string, unknown> =>
          Boolean(decision) && typeof decision === "object" && !Array.isArray(decision)
        )
        .map((decision) => ({
          pieceId: String(decision.pieceId ?? ""),
          dropConfidence: coerceDropConfidence(decision.dropConfidence),
          dropReason: coerceDropReason(decision.dropReason) ?? "empty_or_invalid",
        }))
      : [],
  };
}

function coerceDropConfidence(value: unknown): DropConfidence {
  return value === "certain" || value === "probable" || value === "uncertain" ? value : "uncertain";
}

function coerceDropReason(value: unknown): DropReason | null {
  return typeof value === "string" && CERTAIN_DROP_REASONS.has(value as DropReason)
    ? value as DropReason
    : null;
}
