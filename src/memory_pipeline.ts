import type { ProxyConfig } from "./config.ts";
import { chunkRoundSources } from "./chunking.ts";
import type { ProxyLogger } from "./logger.ts";
import { memoryStateMetrics } from "./metrics.ts";
import type { MemoryState } from "./memory_state.ts";
import { applyRoundUpdate } from "./round_update.ts";
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
  newChunkIds: string[];
  droppedChunkIds: string[];
};

export async function updateMemoryForCompletedRound(
  body: Record<string, unknown>,
  previous: MemoryState,
  response: unknown,
  assistantSources: RoundSource[] = [],
  clients: StructuredClients,
  config: ProxyConfig,
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
    objectiveBefore: previous.objective,
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
      newChunkIds: [],
      droppedChunkIds: [],
    };
  }

  const beforeChunkIds = new Set(previous.chunks.map((chunk) => chunk.id));
  const chunked = await chunkRoundSources(sources, config, clients);

  await logContext.logger?.log("memory_round_chunked", {
    sessionKey: logContext.sessionKey,
    requestId: logContext.requestId,
    chunkCount: chunked.length,
    chunks: chunked.map((piece) => ({
      id: piece.id,
      sourceId: piece.sourceId,
      sourceKind: piece.sourceKind,
      toolName: piece.toolName ?? null,
      selector: piece.selector,
      byteSize: piece.byteSize,
      pointer: piece.pointer ?? null,
    })),
  });

  const applied = await applyRoundUpdate(previous, chunked, clients.workingMemoryUpdate);
  const next = applied.memory;
  const afterChunkIds = new Set(next.chunks.map((chunk) => chunk.id));

  const newChunkIds = [...afterChunkIds].filter((chunkId) => !beforeChunkIds.has(chunkId));
  const droppedChunkIds = [...beforeChunkIds].filter((chunkId) => !afterChunkIds.has(chunkId));

  await logContext.logger?.log("memory_round_decision", {
    sessionKey: logContext.sessionKey,
    requestId: logContext.requestId,
    objectiveBefore: previous.objective,
    objectiveAfter: applied.response.objectiveAfter,
    keptOldChunkIds: applied.keptOldChunkIds,
    droppedOldChunkIds: applied.droppedOldChunkIds,
    keptNewChunkIds: applied.keptNewChunkIds,
    droppedNewChunkIds: applied.droppedNewChunkIds,
  });

  await logContext.logger?.log("memory_round_updated", {
    sessionKey: logContext.sessionKey,
    requestId: logContext.requestId,
    newChunkIds,
    droppedChunkIds,
    ...memoryStateMetrics(next),
  });

  return {
    memory: next,
    changed: true,
    newChunkIds,
    droppedChunkIds,
  };
}

export function filterPersistableRoundSources(
  sources: RoundSource[],
  processedSourceIds: Set<string>,
): RoundSource[] {
  return sources.filter((source) => !processedSourceIds.has(source.sourceId));
}
