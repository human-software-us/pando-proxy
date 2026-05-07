import { shortHash } from "./hash.ts";
import { stableJson } from "./json.ts";
import {
  type ActiveTask,
  type ArchivedTaskBundle,
  chronologicalPieces,
  type DuplicateSource,
  type MaterializedMemoryPiece,
  type MemoryPiece,
  type MemoryState,
  type PieceDraft,
  pruneMemoryState,
  type SourceKind,
  unique,
} from "./memory_state.ts";
import type { TextSpan } from "./source_selectors.ts";

export type TaskRouteRequest = {
  activeTask: ActiveTask | null;
  archivedTasks: Array<{
    relativeIndex: number;
    id: string;
    pieceCount: number;
    startedRound: number;
    archivedRound: number;
  }>;
  newUserPieces: Array<{
    id: string;
    sourceId: string;
    content: unknown;
    previewText: string;
    pointer?: Record<string, unknown>;
  }>;
};

export type TaskRouteResponse =
  | { kind: "same_task" }
  | { kind: "new_task" }
  | { kind: "revive_task"; relativeIndex: number };

export type DropReason =
  | "exact_duplicate"
  | "superseded_by_newer_exact_source"
  | "explicitly_invalidated_by_user"
  | "old_task_after_confirmed_task_switch"
  | "pure_ack_or_chatter"
  | "transient_format_request_only"
  | "clearly_unrelated_to_current_work"
  | "empty_or_invalid";

export type PieceDropDecision = {
  pieceId: string;
  drop: boolean;
  reason: DropReason | null;
};

export type PieceDropBatchRequest = {
  activeTask: ActiveTask | null;
  taskRoute: TaskRouteResponse;
  latestUserPieces: FullPayloadPiece[];
  sharedUserPieces: FullPayloadPiece[];
  candidateManifest: PieceManifestEntry[];
  supersessionHints: SupersessionHint[];
  evaluatedPieces: FullPayloadPiece[];
};

export type PieceDropBatchResponse = {
  decisions: PieceDropDecision[];
};

export type FullPayloadPiece = {
  id: string;
  sourceKind: SourceKind;
  sourceId: string;
  toolName?: string;
  createdSeq?: number;
  primaryKey?: string;
  duplicateSources?: DuplicateSource[];
  byteSize: number;
  contentText: string;
};

export type PieceManifestEntry = {
  id: string;
  sourceKind: SourceKind;
  sourceId: string;
  toolName?: string;
  createdSeq: number;
  primaryKey?: string;
  duplicateSources?: DuplicateSource[];
  byteSize: number;
  fullPayloadIncludedInThisBatch: boolean;
};

export type SupersessionHint = {
  olderPieceId: string;
  newerPieceId: string;
  primaryKey: string;
};

export type SourceChunkBatchRequest = {
  sources: Array<{
    sourceId: string;
    sourceKind: SourceKind;
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

export type MemoryManagerClients = {
  taskRoute: (request: TaskRouteRequest, attempt?: number) => Promise<unknown>;
  sourceChunkBatch: (
    request: SourceChunkBatchRequest,
    attempt?: number,
  ) => Promise<SourceChunkBatchResponse>;
  pieceDropBatch: (request: PieceDropBatchRequest, attempt?: number) => Promise<unknown>;
  pruneBatchTokenLimit?: number;
};

export type AppliedWorkingSetUpdate = {
  memory: MemoryState;
  taskRoute: TaskRouteResponse;
  newDropDecisions: PieceDropBatchResponse;
  oldDropDecisions: PieceDropBatchResponse;
  keptOldPieceIds: string[];
  droppedOldPieceIds: string[];
  keptNewPieceIds: string[];
  droppedNewPieceIds: string[];
  duplicateDroppedPieceIds: string[];
};

const ACCEPTED_DROP_REASONS = new Set<DropReason>([
  "exact_duplicate",
  "superseded_by_newer_exact_source",
  "explicitly_invalidated_by_user",
  "old_task_after_confirmed_task_switch",
  "pure_ack_or_chatter",
  "transient_format_request_only",
  "clearly_unrelated_to_current_work",
  "empty_or_invalid",
]);
const DEFAULT_PRUNE_BATCH_TOKEN_LIMIT = 180_000;
const APPROX_CHARS_PER_TOKEN = 4;

export async function requestTaskRoute(
  state: MemoryState,
  newUserPieces: TaskRouteRequest["newUserPieces"],
  clients: MemoryManagerClients,
): Promise<TaskRouteResponse> {
  if (!state.activeTask) {
    return { kind: "new_task" };
  }
  if (newUserPieces.length === 0) {
    return { kind: "same_task" };
  }
  try {
    return await requestWithSingleRetry(
      (attempt) =>
        clients.taskRoute({
          activeTask: state.activeTask,
          archivedTasks: archivedTaskRouteCards(state.archivedTasks),
          newUserPieces,
        }, attempt),
      parseAndValidateTaskRoute,
      "task_route",
    );
  } catch {
    return { kind: "same_task" };
  }
}

export async function applyWorkingSetUpdate(
  state: MemoryState,
  newPieces: PieceDraft[],
  taskRoute: TaskRouteResponse,
  clients: MemoryManagerClients,
  materializedPriorPieces: MaterializedMemoryPiece[] = [],
): Promise<AppliedWorkingSetUpdate> {
  const nextSeq = state.roundSeq + 1;
  const renderedById = new Map<string, string>(
    materializedPriorPieces.map((piece) => [piece.id, piece.renderText] as const),
  );
  const newContentById = new Map(
    newPieces.map((piece) => [piece.id, renderPieceContent(piece.content)]),
  );
  const newMemoryPieces = await Promise.all(
    newPieces.map((piece) => memoryPieceFromDraft(piece, nextSeq)),
  );
  for (const piece of newMemoryPieces) {
    const rendered = newContentById.get(piece.id);
    if (rendered !== undefined) {
      renderedById.set(piece.id, rendered);
    }
  }

  const routed = applyTaskRoute(state, taskRoute, nextSeq);
  const deduped = markDuplicateNewPieces(routed.baseOldPieces, newMemoryPieces);
  const duplicateNewIds = deduped.duplicateIds;
  const nonDuplicateNewPieces = deduped.newPieces.filter((piece) => !duplicateNewIds.has(piece.id));
  const candidateBaseOldPieces = deduped.oldPieces;
  const candidatePieces = chronologicalPieces([
    ...candidateBaseOldPieces,
    ...nonDuplicateNewPieces,
  ]);
  const supersessionHints = supersessionHintsFor(candidatePieces);
  const pruneBatches = buildPruneBatches({
    activeTask: routed.activeTask,
    taskRoute: routed.effectiveRoute,
    candidatePieces,
    renderedById,
    latestUserPieceIds: newMemoryPieces
      .filter((piece) => piece.sourceKind === "user")
      .map((piece) => piece.id),
    supersessionHints,
    tokenLimit: clients.pruneBatchTokenLimit ?? DEFAULT_PRUNE_BATCH_TOKEN_LIMIT,
  });

  const dropDecisions: PieceDropDecision[] = [];
  for (const batch of pruneBatches) {
    const response = await requestPruneBatchKeepOnFailure(batch, clients);
    dropDecisions.push(...response.decisions);
  }
  const pruneDropIds = new Set(
    dropDecisions.filter(isAcceptedDropDecision).map((decision) => decision.pieceId),
  );

  const pieces = chronologicalPieces(
    candidatePieces.filter((piece) => !pruneDropIds.has(piece.id)),
  );
  const activeTask = pieces.length > 0
    ? {
      ...routed.activeTask,
      pieceIds: pieces.map((piece) => piece.id),
      lastRound: nextSeq,
    }
    : null;
  const memory = pruneMemoryState({
    roundSeq: nextSeq,
    activeTask,
    archivedTasks: routed.archivedTasks,
    pieces,
    processedSourceIds: unique([
      ...state.processedSourceIds,
      ...newPieces.map((piece) => piece.sourceId),
    ]),
  });

  const duplicateDropDecisions = [...duplicateNewIds].map((pieceId) => ({
    pieceId,
    drop: true,
    reason: "exact_duplicate" as const,
  }));
  const newDropIds = new Set([
    ...duplicateNewIds,
    ...nonDuplicateNewPieces.filter((piece) => pruneDropIds.has(piece.id)).map((piece) => piece.id),
  ]);
  const oldDropIds = new Set(
    candidateBaseOldPieces.filter((piece) => pruneDropIds.has(piece.id)).map((piece) => piece.id),
  );

  return {
    memory,
    taskRoute: routed.effectiveRoute,
    newDropDecisions: {
      decisions: [
        ...duplicateDropDecisions,
        ...dropDecisions.filter((decision) =>
          nonDuplicateNewPieces.some((piece) => piece.id === decision.pieceId)
        ),
      ],
    },
    oldDropDecisions: {
      decisions: dropDecisions.filter((decision) =>
        candidateBaseOldPieces.some((piece) => piece.id === decision.pieceId)
      ),
    },
    keptOldPieceIds: candidateBaseOldPieces
      .filter((piece) => !oldDropIds.has(piece.id))
      .map((piece) => piece.id),
    droppedOldPieceIds: [...oldDropIds],
    keptNewPieceIds: nonDuplicateNewPieces
      .filter((piece) => !newDropIds.has(piece.id))
      .map((piece) => piece.id),
    droppedNewPieceIds: [...newDropIds],
    duplicateDroppedPieceIds: [...duplicateNewIds],
  };
}

function applyTaskRoute(
  state: MemoryState,
  route: TaskRouteResponse,
  nextSeq: number,
): {
  activeTask: ActiveTask;
  archivedTasks: ArchivedTaskBundle[];
  baseOldPieces: MemoryPiece[];
  effectiveRoute: TaskRouteResponse;
} {
  if (route.kind === "same_task" && state.activeTask) {
    return {
      activeTask: state.activeTask,
      archivedTasks: state.archivedTasks,
      baseOldPieces: state.pieces,
      effectiveRoute: route,
    };
  }

  if (route.kind === "revive_task") {
    const resolved = resolveArchivedTask(state.archivedTasks, route.relativeIndex);
    if (resolved) {
      const archivedTasks = state.archivedTasks.filter((_, index) => index !== resolved.index);
      const withCurrentArchived = archiveCurrentTask(
        archivedTasks,
        state.activeTask,
        state.pieces,
        nextSeq,
      );
      return {
        activeTask: {
          id: resolved.task.id,
          pieceIds: resolved.task.pieces.map((piece) => piece.id),
          startedRound: resolved.task.startedRound,
          lastRound: nextSeq,
        },
        archivedTasks: withCurrentArchived,
        baseOldPieces: resolved.task.pieces,
        effectiveRoute: route,
      };
    }
    if (state.activeTask) {
      return {
        activeTask: state.activeTask,
        archivedTasks: state.archivedTasks,
        baseOldPieces: state.pieces,
        effectiveRoute: { kind: "same_task" },
      };
    }
  }

  return {
    activeTask: {
      id: `task_${nextSeq}_${crypto.randomUUID().slice(0, 8)}`,
      pieceIds: [],
      startedRound: nextSeq,
      lastRound: nextSeq,
    },
    archivedTasks: archiveCurrentTask(state.archivedTasks, state.activeTask, state.pieces, nextSeq),
    baseOldPieces: [],
    effectiveRoute: route.kind === "new_task" ? route : { kind: "new_task" },
  };
}

function archiveCurrentTask(
  archivedTasks: ArchivedTaskBundle[],
  activeTask: ActiveTask | null,
  activePieces: MemoryPiece[],
  nextSeq: number,
): ArchivedTaskBundle[] {
  if (!activeTask || activePieces.length === 0) {
    return archivedTasks;
  }
  return [
    ...archivedTasks.filter((task) => task.id !== activeTask.id),
    {
      id: activeTask.id,
      pieces: chronologicalPieces(activePieces),
      startedRound: activeTask.startedRound,
      archivedRound: nextSeq,
    },
  ];
}

function resolveArchivedTask(
  archivedTasks: ArchivedTaskBundle[],
  relativeIndex: number,
): { task: ArchivedTaskBundle; index: number } | null {
  if (!Number.isInteger(relativeIndex) || relativeIndex >= 0) {
    return null;
  }
  const index = archivedTasks.length + relativeIndex;
  const task = archivedTasks[index];
  return task ? { task, index } : null;
}

async function memoryPieceFromDraft(piece: PieceDraft, createdSeq: number): Promise<MemoryPiece> {
  const contentHash = await shortHash(stableJson(piece.content), 20);
  const primaryKey = primaryKeyForPiece(piece);
  return {
    id: piece.id,
    sourceKind: piece.sourceKind,
    sourceId: piece.sourceId,
    ...(piece.toolName ? { toolName: piece.toolName } : {}),
    previewText: piece.previewText,
    ...(piece.pointer ? { pointer: piece.pointer } : {}),
    byteSize: piece.byteSize,
    createdSeq,
    selector: piece.selector,
    contentHash,
    ...(primaryKey ? { primaryKey } : {}),
  };
}

function primaryKeyForPiece(piece: PieceDraft): string | null {
  if (!piece.pointer) {
    return null;
  }
  const explicit = piece.pointer.primaryKey;
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  const path = piece.pointer.path ?? piece.pointer.file ?? piece.pointer.filePath;
  if (typeof path === "string" && path.trim()) {
    return `${piece.sourceKind}:${piece.toolName ?? ""}:${path.trim()}`;
  }
  return null;
}

function markDuplicateNewPieces(
  oldPieces: MemoryPiece[],
  newPieces: MemoryPiece[],
): { oldPieces: MemoryPiece[]; newPieces: MemoryPiece[]; duplicateIds: Set<string> } {
  const oldOut = oldPieces.map(cloneMemoryPiece);
  const newOut = newPieces.map(cloneMemoryPiece);
  const oldById = new Map(oldOut.map((piece) => [piece.id, piece] as const));
  const newById = new Map(newOut.map((piece) => [piece.id, piece] as const));
  const byHash = new Map<string, { kind: "old" | "new"; pieceId: string }>();
  const duplicateIds = new Set<string>();

  for (const piece of oldOut) {
    if (!byHash.has(piece.contentHash)) {
      byHash.set(piece.contentHash, { kind: "old", pieceId: piece.id });
    }
  }

  for (const piece of newOut) {
    const canonical = byHash.get(piece.contentHash);
    if (canonical) {
      duplicateIds.add(piece.id);
      const canonicalPiece = canonical.kind === "old"
        ? oldById.get(canonical.pieceId)
        : newById.get(canonical.pieceId);
      if (canonicalPiece) {
        addDuplicateSource(canonicalPiece, duplicateSourceFromPiece(piece));
      }
      continue;
    }
    byHash.set(piece.contentHash, { kind: "new", pieceId: piece.id });
  }

  return { oldPieces: oldOut, newPieces: newOut, duplicateIds };
}

function cloneMemoryPiece(piece: MemoryPiece): MemoryPiece {
  return {
    ...piece,
    ...(piece.duplicateSources
      ? { duplicateSources: piece.duplicateSources.map((duplicate) => ({ ...duplicate })) }
      : {}),
  };
}

function addDuplicateSource(piece: MemoryPiece, duplicate: DuplicateSource): void {
  const existing = piece.duplicateSources ?? [];
  if (existing.some((candidate) => candidate.pieceId === duplicate.pieceId)) {
    return;
  }
  piece.duplicateSources = [...existing, duplicate];
}

function duplicateSourceFromPiece(piece: MemoryPiece): DuplicateSource {
  return {
    pieceId: piece.id,
    sourceId: piece.sourceId,
    sourceKind: piece.sourceKind,
    ...(piece.toolName ? { toolName: piece.toolName } : {}),
    ...(piece.pointer ? { pointer: piece.pointer } : {}),
  };
}

function supersessionHintsFor(pieces: MemoryPiece[]): SupersessionHint[] {
  const byKey = new Map<string, MemoryPiece>();
  const out: SupersessionHint[] = [];
  for (const piece of chronologicalPieces(pieces)) {
    if (!piece.primaryKey) {
      continue;
    }
    const older = byKey.get(piece.primaryKey);
    if (older && older.id !== piece.id) {
      out.push({
        olderPieceId: older.id,
        newerPieceId: piece.id,
        primaryKey: piece.primaryKey,
      });
    }
    byKey.set(piece.primaryKey, piece);
  }
  return out;
}

function buildPruneBatches(input: {
  activeTask: ActiveTask;
  taskRoute: TaskRouteResponse;
  candidatePieces: MemoryPiece[];
  renderedById: Map<string, string>;
  latestUserPieceIds: string[];
  supersessionHints: SupersessionHint[];
  tokenLimit: number;
}): PieceDropBatchRequest[] {
  const manifestBase = input.candidatePieces.map((piece) => pieceManifestEntry(piece, false));
  const latestUserPieces = input.latestUserPieceIds
    .map((id) => fullPayloadPiece(input.candidatePieces, input.renderedById, id))
    .filter((piece): piece is FullPayloadPiece => Boolean(piece));
  const sharedUserSelection = selectSharedUserPieces(input.candidatePieces, input.renderedById, {
    activeTask: input.activeTask,
    taskRoute: input.taskRoute,
    latestUserPieces,
    sharedUserPieces: [],
    candidateManifest: manifestBase,
    supersessionHints: input.supersessionHints,
    evaluatedPieces: [],
  }, input.tokenLimit);
  const allUserPiecesFit = sharedUserSelection.includedAllUserPieces;
  const evaluatedCandidates = input.candidatePieces.filter((piece) =>
    input.renderedById.has(piece.id) &&
    (allUserPiecesFit || piece.sourceKind === "user")
  );
  const batches: PieceDropBatchRequest[] = [];
  let current: FullPayloadPiece[] = [];

  const flush = () => {
    if (current.length === 0) {
      return;
    }
    batches.push(batchRequest(
      input.activeTask,
      input.taskRoute,
      latestUserPieces,
      sharedUserSelection.pieces,
      input.candidatePieces,
      input.supersessionHints,
      current,
    ));
    current = [];
  };

  for (const piece of evaluatedCandidates) {
    const full = fullPayloadPiece(input.candidatePieces, input.renderedById, piece.id);
    if (!full) {
      continue;
    }
    const asSingle = batchRequest(
      input.activeTask,
      input.taskRoute,
      latestUserPieces,
      sharedUserSelection.pieces,
      input.candidatePieces,
      input.supersessionHints,
      [full],
    );
    if (estimatedTokens(asSingle) > input.tokenLimit) {
      continue;
    }
    const next = batchRequest(
      input.activeTask,
      input.taskRoute,
      latestUserPieces,
      sharedUserSelection.pieces,
      input.candidatePieces,
      input.supersessionHints,
      [...current, full],
    );
    if (estimatedTokens(next) > input.tokenLimit) {
      flush();
      current.push(full);
      continue;
    }
    current.push(full);
  }
  flush();
  return batches;
}

function batchRequest(
  activeTask: ActiveTask,
  taskRoute: TaskRouteResponse,
  latestUserPieces: FullPayloadPiece[],
  sharedUserPieces: FullPayloadPiece[],
  candidatePieces: MemoryPiece[],
  supersessionHints: SupersessionHint[],
  evaluatedPieces: FullPayloadPiece[],
): PieceDropBatchRequest {
  const evaluatedIds = new Set(evaluatedPieces.map((piece) => piece.id));
  return {
    activeTask,
    taskRoute,
    latestUserPieces,
    sharedUserPieces,
    candidateManifest: candidatePieces.map((piece) =>
      pieceManifestEntry(piece, evaluatedIds.has(piece.id))
    ),
    supersessionHints,
    evaluatedPieces,
  };
}

function selectSharedUserPieces(
  candidatePieces: MemoryPiece[],
  renderedById: Map<string, string>,
  baseRequest: PieceDropBatchRequest,
  tokenLimit: number,
): { pieces: FullPayloadPiece[]; includedAllUserPieces: boolean } {
  const users = chronologicalPieces(candidatePieces)
    .filter((piece) => piece.sourceKind === "user" && renderedById.has(piece.id))
    .reverse();
  const selected: FullPayloadPiece[] = [];
  for (const piece of users) {
    const full = fullPayloadPiece(candidatePieces, renderedById, piece.id);
    if (!full) {
      continue;
    }
    const request = { ...baseRequest, sharedUserPieces: [...selected, full] };
    if (estimatedTokens(request) > tokenLimit) {
      continue;
    }
    selected.push(full);
  }
  return {
    pieces: selected.reverse(),
    includedAllUserPieces: selected.length === users.length,
  };
}

function pieceManifestEntry(
  piece: MemoryPiece,
  fullPayloadIncludedInThisBatch: boolean,
): PieceManifestEntry {
  return {
    id: piece.id,
    sourceKind: piece.sourceKind,
    sourceId: piece.sourceId,
    ...(piece.toolName ? { toolName: piece.toolName } : {}),
    createdSeq: piece.createdSeq,
    ...(piece.primaryKey ? { primaryKey: piece.primaryKey } : {}),
    ...(piece.duplicateSources ? { duplicateSources: piece.duplicateSources } : {}),
    byteSize: piece.byteSize,
    fullPayloadIncludedInThisBatch,
  };
}

function fullPayloadPiece(
  candidatePieces: MemoryPiece[],
  renderedById: Map<string, string>,
  id: string,
): FullPayloadPiece | null {
  const piece = candidatePieces.find((candidate) => candidate.id === id);
  const contentText = renderedById.get(id);
  if (!piece || contentText === undefined) {
    return null;
  }
  return {
    id: piece.id,
    sourceKind: piece.sourceKind,
    sourceId: piece.sourceId,
    ...(piece.toolName ? { toolName: piece.toolName } : {}),
    createdSeq: piece.createdSeq,
    ...(piece.primaryKey ? { primaryKey: piece.primaryKey } : {}),
    ...(piece.duplicateSources ? { duplicateSources: piece.duplicateSources } : {}),
    byteSize: piece.byteSize,
    contentText,
  };
}

async function requestPruneBatchKeepOnFailure(
  request: PieceDropBatchRequest,
  clients: MemoryManagerClients,
): Promise<PieceDropBatchResponse> {
  try {
    return await requestWithSingleRetry(
      (attempt) => clients.pieceDropBatch(request, attempt),
      (value) => parseAndValidatePieceDropBatch(value, request.evaluatedPieces),
      "piece_drop_batch",
    );
  } catch {
    return {
      decisions: request.evaluatedPieces.map((piece) => ({
        pieceId: piece.id,
        drop: false,
        reason: null,
      })),
    };
  }
}

function parseAndValidateTaskRoute(
  value: unknown,
): { ok: true; value: TaskRouteResponse } | { ok: false; errors: string[] } {
  const response = coerceTaskRoute(value);
  if (!response) {
    return { ok: false, errors: ["task_route response must be an object"] };
  }
  return { ok: true, value: response };
}

function coerceTaskRoute(value: unknown): TaskRouteResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "new_task") {
    return { kind: "new_task" };
  }
  if (record.kind === "revive_task") {
    const relativeIndex = typeof record.relativeIndex === "number"
      ? Math.trunc(record.relativeIndex)
      : -1;
    return relativeIndex < 0 ? { kind: "revive_task", relativeIndex } : { kind: "same_task" };
  }
  return { kind: "same_task" };
}

function parseAndValidatePieceDropBatch(
  value: unknown,
  evaluatedPieces: FullPayloadPiece[],
): { ok: true; value: PieceDropBatchResponse } | { ok: false; errors: string[] } {
  const response = coercePieceDropBatch(value, evaluatedPieces);
  if (!response) {
    return { ok: false, errors: ["piece_drop_batch response must be an object"] };
  }
  const errors = validatePieceDropBatch(response, evaluatedPieces);
  return errors.length === 0 ? { ok: true, value: response } : { ok: false, errors };
}

function validatePieceDropBatch(
  response: PieceDropBatchResponse,
  evaluatedPieces: FullPayloadPiece[],
): string[] {
  const candidateIds = new Set(evaluatedPieces.map((piece) => piece.id));
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const decision of response.decisions) {
    if (!candidateIds.has(decision.pieceId)) {
      errors.push(`piece_drop_batch references unknown piece ${decision.pieceId}`);
      continue;
    }
    if (seen.has(decision.pieceId)) {
      errors.push(`piece_drop_batch duplicated piece ${decision.pieceId}`);
    }
    seen.add(decision.pieceId);
  }
  return errors;
}

function coercePieceDropBatch(
  value: unknown,
  evaluatedPieces: FullPayloadPiece[],
): PieceDropBatchResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.decisions)) {
    const candidateIds = new Set(evaluatedPieces.map((piece) => piece.id));
    return {
      decisions: record.decisions
        .filter((decision): decision is Record<string, unknown> =>
          Boolean(decision) && typeof decision === "object" && !Array.isArray(decision)
        )
        .filter((decision) =>
          typeof decision.pieceId === "string" && candidateIds.has(decision.pieceId)
        )
        .map((decision) => ({
          pieceId: decision.pieceId as string,
          drop: decision.drop === true,
          reason: coerceDropReason(decision.reason),
        })),
    };
  }
  const defaultDecision = decisionObject(record.defaultDecision);
  const overrides = Array.isArray(record.overrides)
    ? record.overrides.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    : [];
  if (Object.keys(defaultDecision).length > 0 || Array.isArray(record.overrides)) {
    const overridesById = new Map<string, Record<string, unknown>>();
    for (const override of overrides) {
      if (typeof override.pieceId === "string") {
        overridesById.set(override.pieceId, override);
      }
    }
    return {
      decisions: evaluatedPieces.map((piece) => {
        const decision = overridesById.get(piece.id) ?? defaultDecision;
        return {
          pieceId: piece.id,
          drop: decision.drop === true,
          reason: coerceDropReason(decision.reason),
        };
      }),
    };
  }
  const byId = (
      record.decisionsByPieceId &&
      typeof record.decisionsByPieceId === "object" &&
      !Array.isArray(record.decisionsByPieceId)
    )
    ? record.decisionsByPieceId as Record<string, unknown>
    : {};
  return {
    decisions: evaluatedPieces.map((piece) => {
      const raw = byId[piece.id];
      const decision = raw && typeof raw === "object" && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      return {
        pieceId: piece.id,
        drop: decision.drop === true,
        reason: coerceDropReason(decision.reason),
      };
    }),
  };
}

function decisionObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isAcceptedDropDecision(decision: PieceDropDecision): boolean {
  return decision.drop === true &&
    typeof decision.reason === "string" &&
    ACCEPTED_DROP_REASONS.has(decision.reason);
}

function coerceDropReason(value: unknown): DropReason | null {
  return typeof value === "string" && ACCEPTED_DROP_REASONS.has(value as DropReason)
    ? value as DropReason
    : null;
}

function archivedTaskRouteCards(
  archivedTasks: ArchivedTaskBundle[],
): TaskRouteRequest["archivedTasks"] {
  return archivedTasks.map((task, index) => ({
    relativeIndex: index - archivedTasks.length,
    id: task.id,
    pieceCount: task.pieces.length,
    startedRound: task.startedRound,
    archivedRound: task.archivedRound,
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

function renderPieceContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return JSON.stringify(content, null, 2);
}

function estimatedTokens(value: unknown): number {
  return Math.ceil(stableJson(value).length / APPROX_CHARS_PER_TOKEN);
}
