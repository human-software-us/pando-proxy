import { loadConfig, type ProxyConfig } from "./config.ts";
import type {
  GroupIntentRequest,
  GroupIntentResponse,
  PieceRetentionBatchRequest,
  PieceRetentionBatchResponse,
  RetainedPiecePruneRequest,
  RetainedPiecePruneResponse,
  SourceChunkBatchRequest,
  SourceChunkBatchResponse,
} from "./group_manager.ts";
import { updateMemoryForCompletedRound } from "./memory_pipeline.ts";
import { estimateTokensForValue, requestContextMetrics } from "./metrics.ts";
import { emptyMemoryState, type MemoryGroup, type MemoryState } from "./memory_state.ts";
import { rewriteRequestWithMemory } from "./prompt_view.ts";
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
  pandoGroupCount: number;
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
    const rewrite = await rewriteRequestWithMemory(baselineBody, memory, config);
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
    );
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
      pandoGroupCount: memory.groups.length,
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
    groupIntent: (request: GroupIntentRequest, _attempt = 1) =>
      Promise.resolve(applyStubGroupIntent(request)),
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
    pieceRetentionBatch: (
      request: PieceRetentionBatchRequest,
      _attempt = 1,
    ): Promise<PieceRetentionBatchResponse> =>
      Promise.resolve(applyStubRetentionPolicy(policy, request)),
    retainedPiecePrune: (
      request: RetainedPiecePruneRequest,
      _attempt = 1,
    ): Promise<RetainedPiecePruneResponse> =>
      Promise.resolve(applyStubRetainedPiecePrune(policy, request)),
  };
}

function applyStubGroupIntent(request: GroupIntentRequest): GroupIntentResponse {
  const activeGroup = request.groups.find((group) => group.status === "active");
  const group = activeGroup ?? deriveGroupFromRequest(request);
  return {
    groupsAfter: group ? [group] : [],
    closedGroupIds: [],
    replacedGroupIds: [],
  };
}

function applyStubRetentionPolicy(
  policy: StubPolicy,
  request: PieceRetentionBatchRequest,
): PieceRetentionBatchResponse {
  const activeGroupId = request.groups.find((group) => group.status === "active")?.id ?? "group_1";
  const keepIds = selectKeptNewPieceIds(policy, request);
  return {
    decisions: request.newPieces.map((piece) => ({
      pieceId: piece.id,
      keep: keepIds.includes(piece.id),
      groupId: keepIds.includes(piece.id) ? activeGroupId : null,
      supersedesPieceIds: [],
    })),
  };
}

function selectKeptNewPieceIds(policy: StubPolicy, request: PieceRetentionBatchRequest): string[] {
  switch (policy) {
    case "retain-all":
      return request.newPieces.map((piece) => piece.id);
    case "drop-tools":
      return request.newPieces.filter((piece) => piece.sourceKind === "user").map((piece) =>
        piece.id
      );
    case "retain-recent":
      return request.newPieces.slice(-12).map((piece) => piece.id);
    case "keep-none":
      return [];
    case "cap-bytes": {
      const keepIds: string[] = [];
      let used = 0;
      for (const piece of [...request.newPieces].reverse()) {
        const bytes = approxBytes(piece.content);
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

function applyStubRetainedPiecePrune(
  policy: StubPolicy,
  request: RetainedPiecePruneRequest,
): RetainedPiecePruneResponse {
  switch (policy) {
    case "retain-all":
      return { dropPieceIds: [] };
    case "keep-none":
      return { dropPieceIds: request.retainedOldPieces.map((piece) => piece.id) };
    case "drop-tools":
      return { dropPieceIds: selectDropToolsPrunedIds(request) };
    case "retain-recent":
      return { dropPieceIds: selectRecentPrunedIds(request, 12, 32_768) };
    case "cap-bytes":
      return { dropPieceIds: selectRecentPrunedIds(request, Number.POSITIVE_INFINITY, 32_768) };
  }
}

function selectDropToolsPrunedIds(request: RetainedPiecePruneRequest): string[] {
  if (request.keptNewPieces.length > 0) {
    return request.retainedOldPieces.map((piece) => piece.id);
  }
  return selectRecentPrunedIds(request, 1, 8_192);
}

function selectRecentPrunedIds(
  request: RetainedPiecePruneRequest,
  maxPieces: number,
  maxBytes: number,
): string[] {
  const keep = new Set<string>();
  let used = sumOf(request.keptNewPieces.map((piece) => approxBytes(piece.previewText)));
  let keptCount = 0;
  for (const piece of [...request.retainedOldPieces].reverse()) {
    if (keptCount >= maxPieces) {
      continue;
    }
    const bytes = approxBytes(piece.previewText);
    if (used + bytes > maxBytes) {
      continue;
    }
    used += bytes;
    keptCount += 1;
    keep.add(piece.id);
  }
  return request.retainedOldPieces.filter((piece) => !keep.has(piece.id)).map((piece) => piece.id);
}

function deriveGroupFromRequest(request: GroupIntentRequest): MemoryGroup | null {
  const text = firstLineOfNewUserText(request) ?? "Continue the current task";
  return {
    id: "group_1",
    status: "active",
    routingLabel: slug(text),
    summary: text,
    lastTouchedSeq: 0,
  };
}

function firstLineOfNewUserText(
  request: Pick<GroupIntentRequest, "newUserPieces">,
): string | null {
  const userPiece = request.newUserPieces[0];
  if (!userPiece) {
    return null;
  }
  const payload = userPiece.content;
  if (typeof payload === "string") {
    return payload.split("\n")[0]?.slice(0, 120) ?? null;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const content = (payload as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return null;
  }
  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string"
      ? record.text
      : typeof record.input_text === "string"
      ? record.input_text
      : "";
    if (text) {
      return text.split("\n")[0].slice(0, 120);
    }
  }
  return null;
}

function slug(text: string): string {
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "current-work";
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

function approxBytes(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
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
