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
import { renderTextSelection, type TextSpanSelection } from "./source_selectors.ts";

export type TaskRouteRequest = {
  activeTask: ActiveTask | null;
  activePieces: Array<{
    id: string;
    sourceKind: SourceKind;
    sourceId: string;
    toolName?: string;
    createdSeq: number;
    byteSize: number;
    contentText: string;
  }>;
  archivePage: {
    offset: number;
    pageSize: number;
    hasMore: boolean;
    nextRelativeIndex: number | null;
  };
  archivedTasks: Array<{
    relativeIndex: number;
    id: string;
    title: string;
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

export type TaskRouteModelResponse =
  | TaskRouteResponse
  | { kind: "more_archived_tasks" };

export type DropReason =
  | "exact_duplicate"
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
  duplicateSources?: DuplicateSource[];
  byteSize: number;
  fullPayloadIncludedInThisBatch: boolean;
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
    chunks: string[];
  }>;
};

export type MemoryManagerClients = {
  taskRoute: (request: TaskRouteRequest, attempt?: number) => Promise<unknown>;
  sourceChunkBatch: (
    request: SourceChunkBatchRequest,
    attempt?: number,
  ) => Promise<SourceChunkBatchResponse>;
  pieceDropBatch: (
    request: PieceDropBatchRequest,
    attempt?: number,
  ) => Promise<PieceDropBatchResponse>;
  pruneBatchTokenLimit?: number;
  pruneSingleBatchTokenLimit?: number;
};

export type AppliedWorkingSetUpdate = {
  memory: MemoryState;
  taskRoute: TaskRouteResponse;
  newDropDecisions: PieceDropBatchResponse;
  oldDropDecisions: PieceDropBatchResponse;
  pruneCandidatePieceIds: string[];
  acceptedPruneDropPieceIds: string[];
  sanityRejectedDropPieceIds: string[];
  keptOldPieceIds: string[];
  droppedOldPieceIds: string[];
  keptNewPieceIds: string[];
  droppedNewPieceIds: string[];
  duplicateDroppedPieceIds: string[];
};

const ACCEPTED_DROP_REASONS = new Set<DropReason>([
  "exact_duplicate",
  "explicitly_invalidated_by_user",
  "old_task_after_confirmed_task_switch",
  "pure_ack_or_chatter",
  "transient_format_request_only",
  "clearly_unrelated_to_current_work",
  "empty_or_invalid",
]);
const STRUCTURAL_DROP_REASONS = new Set<DropReason>([
  "exact_duplicate",
  "explicitly_invalidated_by_user",
  "old_task_after_confirmed_task_switch",
  "pure_ack_or_chatter",
  "transient_format_request_only",
  "empty_or_invalid",
]);
const DEFAULT_PRUNE_BATCH_TOKEN_LIMIT = 180_000;
const DEFAULT_PRUNE_SINGLE_BATCH_TOKEN_LIMIT = 996_000;
const APPROX_CHARS_PER_TOKEN = 4;
const ARCHIVED_TASK_ROUTE_PAGE_SIZE = 5;

export async function requestTaskRoute(
  state: MemoryState,
  newUserPieces: TaskRouteRequest["newUserPieces"],
  clients: MemoryManagerClients,
  materializedPriorPieces: MaterializedMemoryPiece[] = [],
): Promise<TaskRouteResponse> {
  if (!state.activeTask) {
    return { kind: "new_task" };
  }
  if (newUserPieces.length === 0) {
    return { kind: "same_task" };
  }
  let archiveOffset = 0;
  try {
    while (true) {
      const routeRequest = {
        activeTask: state.activeTask,
        activePieces: activePieceRoutePayload(state, materializedPriorPieces),
        archivePage: archivedTaskRoutePage(state.archivedTasks, archiveOffset),
        archivedTasks: archivedTaskRouteCards(state.archivedTasks, archiveOffset),
        newUserPieces,
      };
      const response = await requestWithSingleRetry(
        (attempt) => clients.taskRoute(routeRequest, attempt),
        parseAndValidateTaskRoute,
        "task_route",
      );
      if (response.kind !== "more_archived_tasks") {
        return response;
      }
      if (!routeRequest.archivePage.hasMore) {
        return { kind: "same_task" };
      }
      archiveOffset += ARCHIVED_TASK_ROUTE_PAGE_SIZE;
    }
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

  const routed = applyTaskRoute(state, taskRoute, nextSeq, titleFromNewPieces(newPieces, nextSeq));
  const collapseDuplicatesAfterPrune = routed.effectiveRoute.kind === "new_task";
  const baseDeduped = routed.prePruneDuplicatePreferredPieceIds.size > 0
    ? collapseDuplicatePiecesPreferNew(
      routed.baseOldPieces,
      routed.prePruneDuplicatePreferredPieceIds,
    )
    : { pieces: routed.baseOldPieces.map(cloneMemoryPiece), duplicateIds: new Set<string>() };
  const deduped = collapseDuplicatesAfterPrune
    ? {
      oldPieces: baseDeduped.pieces,
      newPieces: newMemoryPieces.map(cloneMemoryPiece),
      duplicateIds: new Set<string>(),
    }
    : markDuplicateNewPieces(baseDeduped.pieces, newMemoryPieces);
  const duplicateNewIds = deduped.duplicateIds;
  const nonDuplicateNewPieces = deduped.newPieces.filter((piece) => !duplicateNewIds.has(piece.id));
  const candidateBaseOldPieces = deduped.oldPieces;
  const candidatePieces = chronologicalPieces([
    ...candidateBaseOldPieces,
    ...nonDuplicateNewPieces,
  ]);
  const pruneBatches = buildPruneBatches({
    activeTask: routed.activeTask,
    taskRoute: routed.effectiveRoute,
    candidatePieces,
    renderedById,
    latestUserPieceIds: newMemoryPieces
      .filter((piece) => piece.sourceKind === "user")
      .map((piece) => piece.id),
    tokenLimit: clients.pruneBatchTokenLimit ?? DEFAULT_PRUNE_BATCH_TOKEN_LIMIT,
    singleBatchTokenLimit: clients.pruneSingleBatchTokenLimit ??
      clients.pruneBatchTokenLimit ??
      DEFAULT_PRUNE_SINGLE_BATCH_TOKEN_LIMIT,
  });

  const dropDecisions: PieceDropDecision[] = [];
  for (const batch of pruneBatches) {
    const response = await requestPruneBatchKeepOnFailure(batch, clients);
    dropDecisions.push(...response.decisions);
  }
  const dropAcceptanceContext = {
    taskRoute: routed.effectiveRoute,
    activeTask: routed.activeTask,
    oldPieceIds: new Set(candidateBaseOldPieces.map((piece) => piece.id)),
  };
  const acceptedModelExactDuplicateIds = new Set(
    acceptedDropDecisionsWithApplicability(
      candidatePieces,
      dropDecisions,
      dropAcceptanceContext,
    )
      .filter((decision) => decision.reason === "exact_duplicate")
      .map((decision) => decision.pieceId),
  );
  const nonDuplicateDropDecisions = dropDecisions.filter((decision) =>
    !(decision.drop === true && decision.reason === "exact_duplicate")
  );
  const pruneDropIds = acceptedDropIdsWithSanity(
    candidatePieces,
    nonDuplicateDropDecisions,
    dropAcceptanceContext,
  );
  const acceptedDropIdsBeforeSanity = new Set(
    acceptedDropDecisionsWithApplicability(
      candidatePieces,
      nonDuplicateDropDecisions,
      dropAcceptanceContext,
    ).map((decision) => decision.pieceId),
  );
  const sanityRejectedDropIds = [...acceptedDropIdsBeforeSanity].filter((pieceId) =>
    !pruneDropIds.has(pieceId)
  );

  const piecesBeforeDuplicateCollapse = chronologicalPieces(
    candidatePieces.filter((piece) => !pruneDropIds.has(piece.id)),
  );
  const postPruneDeduped = collapseDuplicatesAfterPrune
    ? collapseDuplicatePiecesPreferNew(
      piecesBeforeDuplicateCollapse,
      new Set(nonDuplicateNewPieces.map((piece) => piece.id)),
    )
    : { pieces: piecesBeforeDuplicateCollapse, duplicateIds: new Set<string>() };
  const verifiedModelExactDuplicates = collapseVerifiedExactDuplicateDrops(
    postPruneDeduped.pieces,
    acceptedModelExactDuplicateIds,
    new Set(nonDuplicateNewPieces.map((piece) => piece.id)),
    renderedById,
  );
  const postPruneDuplicateIds = postPruneDeduped.duplicateIds;
  const allDuplicateDropIds = new Set([
    ...baseDeduped.duplicateIds,
    ...duplicateNewIds,
    ...postPruneDuplicateIds,
    ...verifiedModelExactDuplicates.duplicateIds,
  ]);
  const pieces = verifiedModelExactDuplicates.pieces;
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

  const duplicateDropDecisions = [...allDuplicateDropIds].map((pieceId) => ({
    pieceId,
    drop: true,
    reason: "exact_duplicate" as const,
  }));
  const newDropIds = new Set([
    ...duplicateNewIds,
    ...nonDuplicateNewPieces.filter((piece) => allDuplicateDropIds.has(piece.id)).map((piece) =>
      piece.id
    ),
    ...nonDuplicateNewPieces.filter((piece) => pruneDropIds.has(piece.id)).map((piece) => piece.id),
  ]);
  const oldDropIds = new Set([
    ...candidateBaseOldPieces.filter((piece) => allDuplicateDropIds.has(piece.id)).map((piece) =>
      piece.id
    ),
    ...candidateBaseOldPieces.filter((piece) => pruneDropIds.has(piece.id)).map((piece) =>
      piece.id
    ),
  ]);

  return {
    memory,
    taskRoute: routed.effectiveRoute,
    newDropDecisions: {
      decisions: [
        ...duplicateDropDecisions.filter((decision) =>
          newMemoryPieces.some((piece) => piece.id === decision.pieceId)
        ),
        ...nonDuplicateDropDecisions.filter((decision) =>
          !allDuplicateDropIds.has(decision.pieceId) &&
          nonDuplicateNewPieces.some((piece) => piece.id === decision.pieceId)
        ),
      ],
    },
    oldDropDecisions: {
      decisions: [
        ...duplicateDropDecisions.filter((decision) =>
          candidateBaseOldPieces.some((piece) => piece.id === decision.pieceId)
        ),
        ...nonDuplicateDropDecisions.filter((decision) =>
          !allDuplicateDropIds.has(decision.pieceId) &&
          candidateBaseOldPieces.some((piece) => piece.id === decision.pieceId)
        ),
      ],
    },
    pruneCandidatePieceIds: candidatePieces.map((piece) => piece.id),
    acceptedPruneDropPieceIds: [...pruneDropIds],
    sanityRejectedDropPieceIds: sanityRejectedDropIds,
    keptOldPieceIds: candidateBaseOldPieces
      .filter((piece) => !oldDropIds.has(piece.id))
      .map((piece) => piece.id),
    droppedOldPieceIds: [...oldDropIds],
    keptNewPieceIds: nonDuplicateNewPieces
      .filter((piece) => !newDropIds.has(piece.id))
      .map((piece) => piece.id),
    droppedNewPieceIds: [...newDropIds],
    duplicateDroppedPieceIds: [...allDuplicateDropIds],
  };
}

function applyTaskRoute(
  state: MemoryState,
  route: TaskRouteResponse,
  nextSeq: number,
  newTaskTitle: string,
): {
  activeTask: ActiveTask;
  archivedTasks: ArchivedTaskBundle[];
  baseOldPieces: MemoryPiece[];
  effectiveRoute: TaskRouteResponse;
  prePruneDuplicatePreferredPieceIds: Set<string>;
} {
  if (route.kind === "same_task" && state.activeTask) {
    return {
      activeTask: state.activeTask,
      archivedTasks: state.archivedTasks,
      baseOldPieces: state.pieces,
      effectiveRoute: route,
      prePruneDuplicatePreferredPieceIds: new Set(),
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
          title: resolved.task.title,
          pieceIds: resolved.task.pieces.map((piece) => piece.id),
          startedRound: resolved.task.startedRound,
          lastRound: nextSeq,
        },
        archivedTasks: withCurrentArchived,
        baseOldPieces: chronologicalPieces([
          ...resolved.task.pieces,
          ...state.pieces,
        ]),
        effectiveRoute: route,
        prePruneDuplicatePreferredPieceIds: new Set(
          resolved.task.pieces.map((piece) => piece.id),
        ),
      };
    }
    if (state.activeTask) {
      return {
        activeTask: state.activeTask,
        archivedTasks: state.archivedTasks,
        baseOldPieces: state.pieces,
        effectiveRoute: { kind: "same_task" },
        prePruneDuplicatePreferredPieceIds: new Set(),
      };
    }
  }

  return {
    activeTask: {
      id: `task_${nextSeq}_${crypto.randomUUID().slice(0, 8)}`,
      title: newTaskTitle,
      pieceIds: [],
      startedRound: nextSeq,
      lastRound: nextSeq,
    },
    archivedTasks: archiveCurrentTask(state.archivedTasks, state.activeTask, state.pieces, nextSeq),
    baseOldPieces: state.pieces,
    effectiveRoute: route.kind === "new_task" ? route : { kind: "new_task" },
    prePruneDuplicatePreferredPieceIds: new Set(),
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
      title: activeTask.title,
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
  };
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

function collapseDuplicatePiecesPreferNew(
  pieces: MemoryPiece[],
  newPieceIds: ReadonlySet<string>,
): { pieces: MemoryPiece[]; duplicateIds: Set<string> } {
  const byHash = new Map<string, MemoryPiece>();
  const duplicateIds = new Set<string>();

  for (const piece of chronologicalPieces(pieces).map(cloneMemoryPiece)) {
    const canonical = byHash.get(piece.contentHash);
    if (!canonical) {
      byHash.set(piece.contentHash, piece);
      continue;
    }

    if (newPieceIds.has(piece.id) && !newPieceIds.has(canonical.id)) {
      addDuplicateSource(piece, duplicateSourceFromPiece(canonical));
      for (const duplicate of canonical.duplicateSources ?? []) {
        addDuplicateSource(piece, duplicate);
      }
      duplicateIds.add(canonical.id);
      byHash.set(piece.contentHash, piece);
      continue;
    }

    addDuplicateSource(canonical, duplicateSourceFromPiece(piece));
    for (const duplicate of piece.duplicateSources ?? []) {
      addDuplicateSource(canonical, duplicate);
    }
    duplicateIds.add(piece.id);
  }

  return {
    pieces: chronologicalPieces([...byHash.values()]),
    duplicateIds,
  };
}

function collapseVerifiedExactDuplicateDrops(
  pieces: MemoryPiece[],
  requestedDropIds: ReadonlySet<string>,
  newPieceIds: ReadonlySet<string>,
  renderedById: ReadonlyMap<string, string>,
): { pieces: MemoryPiece[]; duplicateIds: Set<string> } {
  if (requestedDropIds.size === 0) {
    return { pieces, duplicateIds: new Set<string>() };
  }

  const cloned = chronologicalPieces(pieces).map(cloneMemoryPiece);
  const groups = new Map<string, MemoryPiece[]>();
  for (const piece of cloned) {
    const comparable = comparableRenderedText(renderedById.get(piece.id));
    if (!comparable) {
      continue;
    }
    groups.set(comparable, [...(groups.get(comparable) ?? []), piece]);
  }

  const duplicateIds = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const requested = group.filter((piece) => requestedDropIds.has(piece.id));
    if (requested.length === 0) {
      continue;
    }
    const canonical = chooseCanonicalForVerifiedDuplicate(group, requestedDropIds, newPieceIds);
    for (const piece of requested) {
      if (piece.id === canonical.id) {
        continue;
      }
      addDuplicateSource(canonical, duplicateSourceFromPiece(piece));
      for (const duplicate of piece.duplicateSources ?? []) {
        addDuplicateSource(canonical, duplicate);
      }
      duplicateIds.add(piece.id);
    }
  }

  return {
    pieces: chronologicalPieces(cloned.filter((piece) => !duplicateIds.has(piece.id))),
    duplicateIds,
  };
}

function chooseCanonicalForVerifiedDuplicate(
  group: MemoryPiece[],
  requestedDropIds: ReadonlySet<string>,
  newPieceIds: ReadonlySet<string>,
): MemoryPiece {
  const ordered = chronologicalPieces(group);
  const unrequested = ordered.filter((piece) => !requestedDropIds.has(piece.id));
  if (unrequested.length > 0) {
    const newUnrequested = unrequested.filter((piece) => newPieceIds.has(piece.id));
    return newUnrequested.at(-1) ?? unrequested[0];
  }
  return ordered[0];
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
    createdSeq: piece.createdSeq,
    ...(piece.toolName ? { toolName: piece.toolName } : {}),
    pointer: piece.pointer ?? { selector: piece.selector },
  };
}

function buildPruneBatches(input: {
  activeTask: ActiveTask;
  taskRoute: TaskRouteResponse;
  candidatePieces: MemoryPiece[];
  renderedById: Map<string, string>;
  latestUserPieceIds: string[];
  tokenLimit: number;
  singleBatchTokenLimit: number;
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
      [full],
    );
    const singleTokens = estimatedTokens(asSingle);
    if (singleTokens > input.singleBatchTokenLimit) {
      continue;
    }
    if (singleTokens > input.tokenLimit) {
      flush();
      batches.push(asSingle);
      continue;
    }
    const next = batchRequest(
      input.activeTask,
      input.taskRoute,
      latestUserPieces,
      sharedUserSelection.pieces,
      input.candidatePieces,
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
      (value) => validateNormalizedPieceDropBatch(value, request.evaluatedPieces),
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
): { ok: true; value: TaskRouteModelResponse } | { ok: false; errors: string[] } {
  const response = coerceTaskRoute(value);
  if (!response) {
    return { ok: false, errors: ["task_route response must be an object"] };
  }
  return { ok: true, value: response };
}

function coerceTaskRoute(value: unknown): TaskRouteModelResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "new_task") {
    return { kind: "new_task" };
  }
  if (record.kind === "more_archived_tasks") {
    return { kind: "more_archived_tasks" };
  }
  if (record.kind === "revive_task") {
    const relativeIndex = typeof record.relativeIndex === "number"
      ? Math.trunc(record.relativeIndex)
      : -1;
    return relativeIndex < 0 ? { kind: "revive_task", relativeIndex } : { kind: "same_task" };
  }
  return { kind: "same_task" };
}

function validateNormalizedPieceDropBatch(
  value: unknown,
  evaluatedPieces: FullPayloadPiece[],
): { ok: true; value: PieceDropBatchResponse } | { ok: false; errors: string[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["piece_drop_batch response must be an object"] };
  }
  const response = value as PieceDropBatchResponse;
  if (!Array.isArray(response.decisions)) {
    return { ok: false, errors: ["piece_drop_batch.decisions must be an array"] };
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

function isAcceptedDropDecision(decision: PieceDropDecision): boolean {
  return decision.drop === true &&
    typeof decision.reason === "string" &&
    ACCEPTED_DROP_REASONS.has(decision.reason);
}

type DropAcceptanceContext = {
  taskRoute: TaskRouteResponse;
  activeTask: ActiveTask;
  oldPieceIds: ReadonlySet<string>;
};

function acceptedDropDecisionsWithApplicability(
  candidatePieces: MemoryPiece[],
  dropDecisions: PieceDropDecision[],
  context: DropAcceptanceContext,
): PieceDropDecision[] {
  const piecesById = new Map(candidatePieces.map((piece) => [piece.id, piece] as const));
  return dropDecisions.filter((decision) => {
    if (!isAcceptedDropDecision(decision)) {
      return false;
    }
    const piece = piecesById.get(decision.pieceId);
    if (!piece) {
      return false;
    }
    return dropReasonAppliesToPiece(decision.reason, piece, context);
  });
}

function dropReasonAppliesToPiece(
  reason: DropReason | null,
  piece: MemoryPiece,
  context: DropAcceptanceContext,
): boolean {
  if (reason !== "old_task_after_confirmed_task_switch") {
    return true;
  }
  return context.taskRoute.kind === "new_task" &&
    context.oldPieceIds.has(piece.id) &&
    piece.createdSeq < context.activeTask.startedRound;
}

function acceptedDropIdsWithSanity(
  candidatePieces: MemoryPiece[],
  dropDecisions: PieceDropDecision[],
  context: DropAcceptanceContext,
): Set<string> {
  const accepted = acceptedDropDecisionsWithApplicability(candidatePieces, dropDecisions, context);
  const initialDropIds = new Set(accepted.map((decision) => decision.pieceId));
  const survivors = candidatePieces.filter((piece) => !initialDropIds.has(piece.id));
  if (!collapsesToAssistantOnly(candidatePieces, survivors)) {
    return initialDropIds;
  }

  return new Set(
    accepted
      .filter((decision) =>
        decision.reason !== null && STRUCTURAL_DROP_REASONS.has(decision.reason)
      )
      .map((decision) => decision.pieceId),
  );
}

function collapsesToAssistantOnly(
  candidates: MemoryPiece[],
  survivors: MemoryPiece[],
): boolean {
  if (!candidates.some((piece) => piece.sourceKind !== "assistant")) {
    return false;
  }
  return survivors.length === 0 ||
    survivors.every((piece) => piece.sourceKind === "assistant");
}

function activePieceRoutePayload(
  state: MemoryState,
  materializedPriorPieces: MaterializedMemoryPiece[],
): TaskRouteRequest["activePieces"] {
  const renderedById = new Map(
    materializedPriorPieces.map((piece) => [piece.id, piece.renderText]),
  );
  return chronologicalPieces(state.pieces).map((piece) => ({
    id: piece.id,
    sourceKind: piece.sourceKind,
    sourceId: piece.sourceId,
    ...(piece.toolName ? { toolName: piece.toolName } : {}),
    createdSeq: piece.createdSeq,
    byteSize: piece.byteSize,
    contentText: renderedById.get(piece.id) ?? piece.previewText,
  }));
}

function archivedTaskRoutePage(
  archivedTasks: ArchivedTaskBundle[],
  offset: number,
): TaskRouteRequest["archivePage"] {
  const hasMore = offset + ARCHIVED_TASK_ROUTE_PAGE_SIZE < archivedTasks.length;
  return {
    offset,
    pageSize: ARCHIVED_TASK_ROUTE_PAGE_SIZE,
    hasMore,
    nextRelativeIndex: hasMore ? -(offset + ARCHIVED_TASK_ROUTE_PAGE_SIZE + 1) : null,
  };
}

function archivedTaskRouteCards(
  archivedTasks: ArchivedTaskBundle[],
  offset: number,
): TaskRouteRequest["archivedTasks"] {
  return archivedTasks.map((task, index) => ({
    relativeIndex: index - archivedTasks.length,
    id: task.id,
    title: task.title,
    pieceCount: task.pieces.length,
    startedRound: task.startedRound,
    archivedRound: task.archivedRound,
  })).reverse().slice(offset, offset + ARCHIVED_TASK_ROUTE_PAGE_SIZE);
}

function titleFromNewPieces(newPieces: PieceDraft[], roundSeq: number): string {
  const userPiece = newPieces.find((piece) => piece.sourceKind === "user");
  const raw = userPiece ? renderPieceContent(userPiece.content) : `Task ${roundSeq}`;
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? raw.trim();
  const collapsed = firstLine.replace(/\s+/g, " ").trim() || `Task ${roundSeq}`;
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}...` : collapsed;
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
  if (isTextSpanSelection(content)) {
    return renderTextSelection(content);
  }
  return JSON.stringify(content, null, 2);
}

function comparableRenderedText(text: string | undefined): string | null {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const jsonSelection = parseTextSpanSelection(text);
  if (jsonSelection) {
    return selectedTextForComparison(jsonSelection);
  }
  const segmentText = selectedTextFromRenderedSegments(text);
  return segmentText ?? text;
}

function parseTextSpanSelection(text: string): TextSpanSelection | null {
  try {
    const parsed = JSON.parse(text);
    return isTextSpanSelection(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTextSpanSelection(value: unknown): value is TextSpanSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "chunks" || !Array.isArray(record.segments)) {
    return false;
  }
  return record.segments.every((segment) =>
    segment && typeof segment === "object" && !Array.isArray(segment) &&
    Number.isInteger((segment as Record<string, unknown>).start) &&
    Number.isInteger((segment as Record<string, unknown>).end) &&
    typeof (segment as Record<string, unknown>).text === "string"
  );
}

function selectedTextForComparison(selection: TextSpanSelection): string {
  return selection.segments.map((segment) => segment.text).join("");
}

function selectedTextFromRenderedSegments(text: string): string | null {
  const matches = [...text.matchAll(/<segment start=\d+ end=\d+>\n([\s\S]*?)\n<\/segment>/g)];
  if (matches.length === 0) {
    return null;
  }
  return matches.map((match) => match[1] ?? "").join("");
}

function estimatedTokens(value: unknown): number {
  return Math.ceil(stableJson(value).length / APPROX_CHARS_PER_TOKEN);
}
