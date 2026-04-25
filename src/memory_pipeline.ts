import { chunkRoundSources } from "./chunking.ts";
import { applyGroupUpdate } from "./group_manager.ts";
import type { ProxyLogger } from "./logger.ts";
import { memoryStateMetrics } from "./metrics.ts";
import type { MemoryState } from "./memory_state.ts";
import type { StructuredClients } from "./structured_model.ts";
import {
  extractAssistantSourcesFromResponse,
  extractNewRequestSources,
  type RoundSource,
} from "./tool_results.ts";

export type MemoryLogContext = {
  logger?: ProxyLogger;
  sessionKey?: string;
  requestId?: string;
};

export type CompletedRoundMemoryResult = {
  memory: MemoryState;
  changed: boolean;
  newPieceIds: string[];
  droppedPieceIds: string[];
  sources: RoundSource[];
};

export async function updateMemoryForCompletedRound(
  body: Record<string, unknown>,
  previous: MemoryState,
  response: unknown,
  assistantSources: RoundSource[] = [],
  clients: StructuredClients,
  logContext: MemoryLogContext = {},
): Promise<CompletedRoundMemoryResult> {
  const requestSources = await extractNewRequestSources(body, new Set(previous.processedSourceIds));
  const resolvedAssistantSources = assistantSources.length > 0
    ? assistantSources
    : await extractAssistantSourcesFromResponse(response);
  const assistantNew = resolvedAssistantSources.filter((source) =>
    !previous.processedSourceIds.includes(source.sourceId)
  );
  const sources = [...requestSources, ...assistantNew];

  await logContext.logger?.log("memory_round_sources", {
    sessionKey: logContext.sessionKey,
    requestId: logContext.requestId,
    groupIdsBefore: previous.groups.map((group) => group.id),
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
      toolName: source.toolName ?? null,
      pointer: source.pointer ?? null,
    })),
  });

  if (sources.length === 0) {
    await logContext.logger?.log("memory_round_skipped", {
      sessionKey: logContext.sessionKey,
      requestId: logContext.requestId,
      reason: "no_new_sources",
    });
    return {
      memory: previous,
      changed: false,
      newPieceIds: [],
      droppedPieceIds: [],
      sources,
    };
  }

  const beforePieceIds = new Set(previous.pieces.map((piece) => piece.id));
  const chunked = await chunkRoundSources(sources, clients);

  await logContext.logger?.log("memory_round_chunked", {
    sessionKey: logContext.sessionKey,
    requestId: logContext.requestId,
    pieceCount: chunked.length,
    pieces: chunked.map((piece) => ({
      id: piece.id,
      sourceId: piece.sourceId,
      sourceKind: piece.sourceKind,
      toolName: piece.toolName ?? null,
      selector: piece.selector,
      byteSize: piece.byteSize,
      pointer: piece.pointer ?? null,
    })),
  });

  const applied = await applyGroupUpdate(
    previous,
    chunked,
    clients,
  );
  const next = applied.memory;
  const afterPieceIds = new Set(next.pieces.map((piece) => piece.id));

  const newPieceIds = [...afterPieceIds].filter((pieceId) => !beforePieceIds.has(pieceId));
  const droppedPieceIds = [...beforePieceIds].filter((pieceId) => !afterPieceIds.has(pieceId));

  await logContext.logger?.log("memory_round_decision", {
    sessionKey: logContext.sessionKey,
    requestId: logContext.requestId,
    groupsBefore: previous.groups,
    groupsAfter: applied.groupIntent.groupsAfter,
    closedGroupIds: applied.groupIntent.closedGroupIds,
    replacedGroupIds: applied.groupIntent.replacedGroupIds,
    pieceRetention: applied.pieceRetention.decisions,
    prunedOldPieceIds: applied.retainedPiecePrune.dropPieceIds,
    keptOldPieceIds: applied.keptOldPieceIds,
    droppedOldPieceIds: applied.droppedOldPieceIds,
    keptNewPieceIds: applied.keptNewPieceIds,
    droppedNewPieceIds: applied.droppedNewPieceIds,
  });

  await logContext.logger?.log("memory_round_updated", {
    sessionKey: logContext.sessionKey,
    requestId: logContext.requestId,
    newPieceIds,
    droppedPieceIds,
    ...memoryStateMetrics(next),
  });

  return {
    memory: next,
    changed: true,
    newPieceIds,
    droppedPieceIds,
    sources,
  };
}

export function filterPersistableRoundSources(
  sources: RoundSource[],
  processedSourceIds: Set<string>,
): RoundSource[] {
  return sources.filter((source) => !processedSourceIds.has(source.sourceId));
}
