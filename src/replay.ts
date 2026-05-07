import { loadConfig, type ProxyConfig } from "./config.ts";
import type {
  DropReason,
  PieceDropBatchRequest,
  PieceDropBatchResponse,
  SourceChunkBatchRequest,
  SourceChunkBatchResponse,
  TaskRouteRequest,
  TaskRouteResponse,
} from "./working_set_manager.ts";
import { updateMemoryForCompletedRound } from "./memory_pipeline.ts";
import { estimateTokensForValue, requestContextMetrics } from "./metrics.ts";
import { emptyMemoryState, type MemoryState } from "./memory_state.ts";
import { rewriteRequestWithMemory } from "./prompt_view.ts";
import { type ArchivedSource, materializeMemoryFromArchivedSources } from "./store.ts";
import {
  createStructuredClients,
  type StructuredClients,
  type StructuredModelUsage,
} from "./structured_model.ts";

type RolloutEvent = {
  timestamp?: string;
  type: string;
  payload?: Record<string, unknown>;
};

type Round = {
  index: number;
  userItem: Record<string, unknown> | null;
  userText: string;
  assistantItems: Record<string, unknown>[];
  recordedInputTokens: number | null;
  recordedOutputTokens: number | null;
  recordedCachedInputTokens: number | null;
  compactionReplacement: Record<string, unknown>[] | null;
};

export type ReplayTurnResult = {
  turn: number;
  userPreview: string;
  compactionBefore: boolean;
  baselineApproxInputTokens: number;
  baselineInputItemCount: number;
  pandoApproxInputTokens: number;
  pandoInputItemCount: number;
  pandoMemoryPieceCount: number;
  pandoActiveTaskId: string | null;
  pandoPieceCount: number;
  pandoPieceBytes: number;
  recordedInputTokens: number | null;
  recordedOutputTokens: number | null;
  recordedCachedInputTokens: number | null;
};

export type ReplayStats = {
  rollout: string;
  rounds: number;
  compactions: number;
  baseline: {
    min: number;
    avg: number;
    max: number;
    totalApprox: number;
  };
  pando: {
    min: number;
    avg: number;
    max: number;
    totalApprox: number;
  };
  recorded: {
    min: number | null;
    avg: number | null;
    max: number | null;
  };
  savingsAvgTokens: number;
  savingsMaxTokens: number;
  policy: string;
};

export type StubPolicy =
  | "retain-all"
  | "retain-recent"
  | "drop-tools"
  | "keep-none"
  | "cap-bytes";

export type RealLlmOpts = {
  authHeader: string;
  requestModel?: string;
  onProgress?: (turn: ReplayTurnResult) => void | Promise<void>;
  onManagerUsage?: (usage: StructuredModelUsage) => void | Promise<void>;
};

export function parseRollout(text: string): RolloutEvent[] {
  const out: RolloutEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines.
    }
  }
  return out;
}

export function segmentRounds(
  events: RolloutEvent[],
): { prefixItems: Record<string, unknown>[]; rounds: Round[] } {
  const prefixItems: Record<string, unknown>[] = [];
  const rounds: Round[] = [];
  let current: Round | null = null;
  let sawFirstUser = false;
  let pendingReplacement: Record<string, unknown>[] | null = null;

  for (const event of events) {
    if (event.type === "compacted" && event.payload && typeof event.payload === "object") {
      const replacementHistory = (event.payload as Record<string, unknown>).replacement_history;
      if (Array.isArray(replacementHistory)) {
        pendingReplacement = replacementHistory.filter((item) =>
          item && typeof item === "object"
        ) as Record<string, unknown>[];
      }
      continue;
    }

    if (event.type === "response_item" && event.payload && typeof event.payload === "object") {
      const item = event.payload as Record<string, unknown>;
      const type = typeof item.type === "string" ? item.type : "";
      const role = typeof item.role === "string" ? item.role : "";

      if (type === "message" && role === "user" && isLikelyUserPrompt(item)) {
        sawFirstUser = true;
        current = {
          index: rounds.length,
          userItem: item,
          userText: extractUserText(item),
          assistantItems: [],
          recordedInputTokens: null,
          recordedOutputTokens: null,
          recordedCachedInputTokens: null,
          compactionReplacement: pendingReplacement,
        };
        pendingReplacement = null;
        rounds.push(current);
        continue;
      }

      if (!sawFirstUser) {
        prefixItems.push(item);
        continue;
      }

      if (current) {
        current.assistantItems.push(item);
      }
      continue;
    }

    if (
      event.type === "event_msg" && event.payload && typeof event.payload === "object" && current
    ) {
      const payload = event.payload as Record<string, unknown>;
      if (payload.type !== "token_count") {
        continue;
      }
      const info = (payload.info as Record<string, unknown>) ?? {};
      const lastUsage = (info.last_token_usage as Record<string, unknown>) ?? {};
      const input = numberOrNull(lastUsage.input_tokens);
      const cached = numberOrNull(lastUsage.cached_input_tokens);
      const output = numberOrNull(lastUsage.output_tokens);
      if (input !== null) {
        current.recordedInputTokens = Math.max(current.recordedInputTokens ?? 0, input);
      }
      if (output !== null) {
        current.recordedOutputTokens = (current.recordedOutputTokens ?? 0) + output;
      }
      if (cached !== null) {
        current.recordedCachedInputTokens = Math.max(
          current.recordedCachedInputTokens ?? 0,
          cached,
        );
      }
    }
  }

  return { prefixItems, rounds };
}

export async function replayRollout(
  path: string,
  opts: {
    policy?: StubPolicy;
    maxRounds?: number;
    config?: ProxyConfig;
    realLlm?: RealLlmOpts;
  } = {},
): Promise<{ stats: ReplayStats; turns: ReplayTurnResult[] }> {
  const policy = opts.policy ?? "drop-tools";
  const effectivePolicy = opts.realLlm ? "real-llm" : policy;
  const text = await Deno.readTextFile(path);
  const events = parseRollout(text);
  const { prefixItems, rounds } = segmentRounds(events);
  const roundsToRun = typeof opts.maxRounds === "number" ? rounds.slice(0, opts.maxRounds) : rounds;
  const config = opts.config ?? loadConfig({ memoryEnabled: true });
  const clients = opts.realLlm
    ? createStructuredClients(
      config,
      opts.realLlm.requestModel ?? "gpt-5.4",
      opts.realLlm.authHeader,
      undefined,
      opts.realLlm.onManagerUsage,
    )
    : buildStubClients(policy);

  const accumulated = [...prefixItems];
  const turns: ReplayTurnResult[] = [];
  let memory: MemoryState = emptyMemoryState();
  const archivedSources = new Map<string, ArchivedSource>();

  for (const round of roundsToRun) {
    if (!round.userItem) {
      continue;
    }

    if (round.compactionReplacement) {
      accumulated.length = 0;
      accumulated.push(...prefixItems);
      accumulated.push(...round.compactionReplacement);
    }

    accumulated.push(round.userItem);

    const baselineBody: Record<string, unknown> = {
      model: "gpt-5.4",
      input: accumulated.map((item) => item),
      stream: true,
    };

    const baselineMetrics = requestContextMetrics(baselineBody);
    const promptMemory = materializeMemoryFromArchivedSources(memory, archivedSources);
    const rewrite = await rewriteRequestWithMemory(baselineBody, promptMemory, config);
    const pandoMetrics = requestContextMetrics(rewrite.body);
    const fakeResponse = {
      id: `replay_${round.index}`,
      output: round.assistantItems,
    };

    const updated = await updateMemoryForCompletedRound(
      baselineBody,
      memory,
      fakeResponse,
      [],
      clients,
      { sessionKey: `replay_${round.index}`, requestId: `replay_${round.index}` },
      promptMemory.pieces,
    );
    for (const source of updated.sources) {
      archivedSources.set(source.sourceId, source);
    }
    memory = updated.memory;

    const turnResult: ReplayTurnResult = {
      turn: round.index,
      userPreview: round.userText.split("\n")[0].slice(0, 80),
      compactionBefore: Boolean(round.compactionReplacement),
      baselineApproxInputTokens: baselineMetrics.approxInputTokens as number,
      baselineInputItemCount: baselineMetrics.inputItemCount as number,
      pandoApproxInputTokens: pandoMetrics.approxInputTokens as number,
      pandoInputItemCount: pandoMetrics.inputItemCount as number,
      pandoMemoryPieceCount: rewrite.diff.memoryPieceCount,
      pandoActiveTaskId: memory.activeTask?.id ?? null,
      pandoPieceCount: memory.pieces.length,
      pandoPieceBytes: memory.pieces.reduce((total, piece) => total + piece.byteSize, 0),
      recordedInputTokens: round.recordedInputTokens,
      recordedOutputTokens: round.recordedOutputTokens,
      recordedCachedInputTokens: round.recordedCachedInputTokens,
    };
    turns.push(turnResult);
    if (opts.realLlm?.onProgress) {
      await opts.realLlm.onProgress(turnResult);
    }

    accumulated.push(...round.assistantItems);
  }

  const baselineSeries = turns.map((turn) => turn.baselineApproxInputTokens);
  const pandoSeries = turns.map((turn) => turn.pandoApproxInputTokens);
  const recordedSeries = turns.map((turn) => turn.recordedInputTokens).filter(
    (value): value is number => typeof value === "number",
  );

  return {
    stats: {
      rollout: path,
      rounds: turns.length,
      compactions: turns.filter((turn) => turn.compactionBefore).length,
      baseline: {
        min: minOf(baselineSeries),
        avg: avgOf(baselineSeries),
        max: maxOf(baselineSeries),
        totalApprox: sumOf(baselineSeries),
      },
      pando: {
        min: minOf(pandoSeries),
        avg: avgOf(pandoSeries),
        max: maxOf(pandoSeries),
        totalApprox: sumOf(pandoSeries),
      },
      recorded: {
        min: recordedSeries.length > 0 ? minOf(recordedSeries) : null,
        avg: recordedSeries.length > 0 ? avgOf(recordedSeries) : null,
        max: recordedSeries.length > 0 ? maxOf(recordedSeries) : null,
      },
      savingsAvgTokens: avgOf(baselineSeries) - avgOf(pandoSeries),
      savingsMaxTokens: maxOf(baselineSeries) - maxOf(pandoSeries),
      policy: effectivePolicy,
    },
    turns,
  };
}

function buildStubClients(policy: StubPolicy): StructuredClients {
  return {
    taskRoute: (request: TaskRouteRequest, _attempt = 1) =>
      Promise.resolve(applyStubTaskRoute(request)),
    sourceChunkBatch: (
      request: SourceChunkBatchRequest,
      _attempt = 1,
    ): Promise<SourceChunkBatchResponse> =>
      Promise.resolve({
        results: request.sources.map((source) => ({
          sourceId: source.sourceId,
          selectors: [{ kind: "whole" }],
        })),
      }),
    pieceDropBatch: (
      request: PieceDropBatchRequest,
      _attempt = 1,
    ): Promise<PieceDropBatchResponse> => Promise.resolve(applyStubDropPolicy(policy, request)),
  };
}

function applyStubTaskRoute(request: TaskRouteRequest): TaskRouteResponse {
  if (request.activeTask) {
    return { kind: "same_task" };
  }
  return { kind: "new_task" };
}

function applyStubDropPolicy(
  policy: StubPolicy,
  request: PieceDropBatchRequest,
): PieceDropBatchResponse {
  const keepIds = selectKeptCandidateIds(policy, request);
  return dropResponse(
    request,
    request.evaluatedPieces
      .filter((piece) => !keepIds.includes(piece.id))
      .map((piece) => piece.id),
    "clearly_unrelated_to_current_work",
  );
}

function selectKeptCandidateIds(policy: StubPolicy, request: PieceDropBatchRequest): string[] {
  switch (policy) {
    case "retain-all":
      return request.evaluatedPieces.map((piece) => piece.id);
    case "drop-tools":
      return request.evaluatedPieces.filter((piece) => piece.sourceKind === "user").map((piece) =>
        piece.id
      );
    case "retain-recent":
      return request.evaluatedPieces.slice(-12).map((piece) => piece.id);
    case "keep-none":
      return [];
    case "cap-bytes": {
      const keepIds: string[] = [];
      let used = 0;
      for (const piece of [...request.evaluatedPieces].reverse()) {
        const bytes = piece.byteSize;
        if (used + bytes > 32_768) {
          continue;
        }
        used += bytes;
        keepIds.unshift(piece.id);
      }
      return keepIds;
    }
  }
}

function dropResponse(
  request: PieceDropBatchRequest,
  dropPieceIds: string[],
  dropReason: DropReason,
): PieceDropBatchResponse {
  const dropIds = new Set(dropPieceIds);
  return {
    decisions: request.evaluatedPieces.map((piece) => ({
      pieceId: piece.id,
      drop: dropIds.has(piece.id),
      reason: dropIds.has(piece.id) ? dropReason : null,
    })),
  };
}

function isLikelyUserPrompt(item: Record<string, unknown>): boolean {
  const text = extractUserText(item);
  if (!text) {
    return false;
  }
  if (text.startsWith("<environment_context>")) {
    return false;
  }
  if (text.startsWith("<turn_aborted>")) {
    return false;
  }
  if (text.trim().startsWith("<user_interrupt>")) {
    return false;
  }
  return true;
}

function extractUserText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (entry && typeof entry === "object") {
      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") {
        return record.text;
      }
      if (typeof record.input_text === "string") {
        return record.input_text;
      }
    }
    return "";
  }).join("\n");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumOf(values: number[]): number {
  return values.reduce((left, right) => left + right, 0);
}

function avgOf(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.round(sumOf(values) / values.length);
}

function minOf(values: number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

function maxOf(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function unusedEstimate(): number {
  return estimateTokensForValue({});
}

void unusedEstimate;
