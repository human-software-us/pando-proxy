// Replay a Codex rollout JSONL through the memory pipeline.
//
// For each user turn in the rollout we reconstruct the request body Codex would
// have sent, then measure:
//   baseline: approxInputTokens on the raw accumulated body
//   pando:    approxInputTokens after rewriteRequestWithMemory
//
// The memory manager's LLM calls are stubbed with a deterministic policy so the
// replay never talks to a real model. The assistant messages and tool outputs
// used to drive updateMemoryForCompletedRound come from the rollout itself.

import { chunkRoundSources } from "./chunking.ts";
import { loadConfig, type ProxyConfig } from "./config.ts";
import { estimateTokensForValue, requestContextMetrics } from "./metrics.ts";
import {
  type ChunkDraft,
  type ChunkRecord,
  dedupeChunks,
  emptyMemoryState,
  type MemoryState,
  unique,
} from "./memory_state.ts";
import { rewriteRequestWithMemory } from "./prompt_view.ts";
import {
  extractAssistantSourcesFromResponse,
  extractNewRequestSources,
  type RoundSource,
} from "./tool_results.ts";
import type {
  WorkingMemoryUpdateRequest,
  WorkingMemoryUpdateResponse,
} from "./round_update.ts";
import type { SourceChunkRequest, SourceChunkResponse, StructuredClients } from "./structured_model.ts";

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
  // If a compaction event arrived just before this round, the replay should
  // reset the baseline accumulator to this replacement history (it's what
  // Codex itself sent as the next request input). Pando replay keeps its own
  // memory state across the boundary.
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
  pandoInlineChunkCount: number;
  pandoOmittedChunkCount: number;
  pandoObjective: string | null;
  pandoChunkCount: number;
  pandoChunkBytes: number;
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

export function parseRollout(text: string): RolloutEvent[] {
  const out: RolloutEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

// Segment rollout into user-initiated rounds. Each round owns:
//   - the leading user input item (message/role=user)
//   - all subsequent response_items up to (but not including) the next user round
//   - the last recorded token_count event within that round (for baseline cross-check)
//
// Developer/system/user-with-environment_context items before the first user turn
// are kept as "prefix" items so they flow into every round's body, matching how
// Codex keeps system prompts in place across turns.
export function segmentRounds(
  events: RolloutEvent[],
): { prefixItems: Record<string, unknown>[]; rounds: Round[] } {
  const prefixItems: Record<string, unknown>[] = [];
  const rounds: Round[] = [];
  let current: Round | null = null;
  let sawFirstUser = false;
  let pendingReplacement: Record<string, unknown>[] | null = null;

  for (const ev of events) {
    if (ev.type === "compacted" && ev.payload && typeof ev.payload === "object") {
      const p = ev.payload as Record<string, unknown>;
      const rh = p.replacement_history;
      if (Array.isArray(rh)) {
        pendingReplacement = rh.filter((x) => x && typeof x === "object") as Record<
          string,
          unknown
        >[];
      }
      continue;
    }
    if (ev.type === "response_item" && ev.payload && typeof ev.payload === "object") {
      const item = ev.payload as Record<string, unknown>;
      const itype = typeof item.type === "string" ? item.type : "";
      const role = typeof item.role === "string" ? item.role : "";

      if (itype === "message" && role === "user" && isLikelyUserPrompt(item)) {
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
      } else {
        prefixItems.push(item);
      }
    } else if (ev.type === "event_msg" && ev.payload && typeof ev.payload === "object") {
      const p = ev.payload as Record<string, unknown>;
      if (p.type === "token_count" && current) {
        const info = (p.info as Record<string, unknown>) ?? {};
        const lastUsage = (info.last_token_usage as Record<string, unknown>) ?? {};
        const input = numberOrNull(lastUsage.input_tokens);
        const cached = numberOrNull(lastUsage.cached_input_tokens);
        const output = numberOrNull(lastUsage.output_tokens);
        // Keep the MAX input tokens observed during the round (peak context).
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
  }

  return { prefixItems, rounds };
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

function isLikelyUserPrompt(item: Record<string, unknown>): boolean {
  // Codex injects an <environment_context> user message at session start; skip it.
  const text = extractUserText(item);
  if (!text) return false;
  if (text.startsWith("<environment_context>")) return false;
  // Codex adds <turn_aborted> / <system-reminder> sentinel messages; not real prompts.
  if (text.startsWith("<turn_aborted>")) return false;
  if (text.trim().startsWith("<user_interrupt>")) return false;
  return true;
}

function extractUserText(item: Record<string, unknown>): string {
  const c = item.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((entry) => {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      if (typeof e.text === "string") return e.text;
      if (typeof e.input_text === "string") return e.input_text;
    }
    return "";
  }).join("\n");
}

function buildStubClients(policy: StubPolicy): StructuredClients {
  return {
    workingMemoryUpdate: (request: WorkingMemoryUpdateRequest) => {
      return Promise.resolve(applyStubPolicy(policy, request));
    },
    sourceChunk: (_req: SourceChunkRequest): Promise<SourceChunkResponse> => {
      return Promise.resolve({ chunks: [{ kind: "whole" }] });
    },
  };
}

function applyStubPolicy(
  policy: StubPolicy,
  request: WorkingMemoryUpdateRequest,
): WorkingMemoryUpdateResponse {
  const objective = request.objective ?? firstLineOfNewUserText(request);
  switch (policy) {
    case "retain-all":
      return {
        objectiveAfter: objective,
        keepOldChunkIds: request.chunks.map((c) => c.id),
        keepNewChunkIds: request.newChunks.map((c) => c.id),
      };
    case "drop-tools": {
      const keepOld = request.chunks.filter((c) => c.sourceKind !== "tool").map((c) => c.id);
      const keepNew = request.newChunks.filter((c) => c.sourceKind !== "tool").map((c) => c.id);
      return { objectiveAfter: objective, keepOldChunkIds: keepOld, keepNewChunkIds: keepNew };
    }
    case "retain-recent": {
      // Simulate a realistic "bounded working set": keep at most 12 chunks total,
      // preferring the most recent new chunks.
      const maxTotal = 12;
      const keepNewIds = request.newChunks.slice(-maxTotal).map((c) => c.id);
      const remaining = Math.max(0, maxTotal - keepNewIds.length);
      const keepOldIds = request.chunks.slice(-remaining).map((c) => c.id);
      return { objectiveAfter: objective, keepOldChunkIds: keepOldIds, keepNewChunkIds: keepNewIds };
    }
    case "keep-none":
      return { objectiveAfter: objective, keepOldChunkIds: [], keepNewChunkIds: [] };
    case "cap-bytes": {
      // Keep chunks so that total bytes <= 32KB. Prefer new chunks first (most
      // recent), then walk old chunks newest-first until cap is hit.
      const cap = 32_768;
      let used = 0;
      const keepNewIds: string[] = [];
      for (const c of [...request.newChunks].reverse()) {
        const bytes = approxBytes(c.content);
        if (used + bytes > cap) continue;
        used += bytes;
        keepNewIds.push(c.id);
      }
      const keepOldIds: string[] = [];
      for (const c of [...request.chunks].reverse()) {
        const bytes = approxBytes(c.content);
        if (used + bytes > cap) continue;
        used += bytes;
        keepOldIds.push(c.id);
      }
      return { objectiveAfter: objective, keepOldChunkIds: keepOldIds, keepNewChunkIds: keepNewIds };
    }
  }
}

function approxBytes(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
}

function firstLineOfNewUserText(request: WorkingMemoryUpdateRequest): string | null {
  const userNew = request.newChunks.find((c) => c.sourceKind === "user");
  if (!userNew) return null;
  const payload = userNew.content;
  if (typeof payload === "string") return payload.split("\n")[0]?.slice(0, 120) ?? null;
  if (payload && typeof payload === "object") {
    // message item
    const item = payload as Record<string, unknown>;
    const c = item.content;
    if (Array.isArray(c)) {
      for (const entry of c) {
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          const t = typeof e.text === "string"
            ? e.text
            : typeof e.input_text === "string"
            ? e.input_text
            : "";
          if (t) return t.split("\n")[0].slice(0, 120);
        }
      }
    }
  }
  return null;
}

export async function replayRollout(
  path: string,
  opts: { policy?: StubPolicy; maxRounds?: number; config?: ProxyConfig } = {},
): Promise<{ stats: ReplayStats; turns: ReplayTurnResult[] }> {
  const policy: StubPolicy = opts.policy ?? "drop-tools";
  const text = await Deno.readTextFile(path);
  const events = parseRollout(text);
  const { prefixItems, rounds } = segmentRounds(events);
  const config = opts.config ?? loadConfig({ memoryEnabled: true });
  const clients = buildStubClients(policy);

  // Accumulated response_items Codex would carry turn-to-turn (baseline path).
  // This includes: prefix items, then for each round the user item + all
  // assistant items (messages, function_calls, function_call_outputs, reasoning).
  const accumulated: Record<string, unknown>[] = [...prefixItems];

  let memory: MemoryState = emptyMemoryState();
  const turns: ReplayTurnResult[] = [];

  const roundsToRun = opts.maxRounds ? rounds.slice(0, opts.maxRounds) : rounds;

  for (const round of roundsToRun) {
    if (!round.userItem) continue;

    // If Codex compacted just before this round, reset the accumulator to the
    // replacement history Codex actually sent.
    if (round.compactionReplacement) {
      accumulated.length = 0;
      accumulated.push(...prefixItems);
      accumulated.push(...round.compactionReplacement);
    }

    // BEFORE sending this turn, Codex's body includes everything accumulated
    // plus the user message for this round. We add it now:
    accumulated.push(round.userItem);

    // Build the body as it would appear to the proxy right now.
    const baselineBody: Record<string, unknown> = {
      model: "gpt-5.4",
      input: accumulated.map((i) => i),
      stream: true,
    };

    // Baseline = what Codex would send without Pando.
    const baselineMetrics = requestContextMetrics(baselineBody);
    const baselineApprox = baselineMetrics.approxInputTokens as number;
    const baselineItemCount = baselineMetrics.inputItemCount as number;

    // Pando rewrite:
    const rewrite = await rewriteRequestWithMemory(baselineBody, memory, config);
    const pandoMetrics = requestContextMetrics(rewrite.body);
    const pandoApprox = pandoMetrics.approxInputTokens as number;
    const pandoItemCount = pandoMetrics.inputItemCount as number;

    // Fake response object built from the round's assistantItems, shaped so that
    // extractAssistantSourcesFromResponse() finds message + tool outputs.
    const fakeResponse: Record<string, unknown> = {
      id: `replay_${round.index}`,
      output: round.assistantItems,
    };

    try {
      memory = await directMemoryUpdate(
        baselineBody,
        memory,
        fakeResponse,
        clients,
        config,
        policy,
      );
    } catch (err) {
      console.error(`round ${round.index} memory update failed:`, err);
    }

    turns.push({
      turn: round.index,
      userPreview: round.userText.split("\n")[0].slice(0, 80),
      compactionBefore: Boolean(round.compactionReplacement),
      baselineApproxInputTokens: baselineApprox,
      baselineInputItemCount: baselineItemCount,
      pandoApproxInputTokens: pandoApprox,
      pandoInputItemCount: pandoItemCount,
      pandoInlineChunkCount: rewrite.diff.inlineChunkCount,
      pandoOmittedChunkCount: rewrite.diff.omittedChunkCount,
      pandoObjective: memory.objective,
      pandoChunkCount: memory.chunks.length,
      pandoChunkBytes: memory.chunks.reduce((acc, c) => acc + c.byteSize, 0),
      recordedInputTokens: round.recordedInputTokens,
      recordedOutputTokens: round.recordedOutputTokens,
      recordedCachedInputTokens: round.recordedCachedInputTokens,
    });

    // After the round, add assistant items to accumulated so the next round sees
    // the same conversation state Codex would have seen.
    for (const item of round.assistantItems) {
      accumulated.push(item);
    }
  }

  const baselineSeries = turns.map((t) => t.baselineApproxInputTokens);
  const pandoSeries = turns.map((t) => t.pandoApproxInputTokens);
  const recordedSeries = turns.map((t) => t.recordedInputTokens).filter(
    (v): v is number => typeof v === "number",
  );

  const stats: ReplayStats = {
    rollout: path,
    rounds: turns.length,
    compactions: turns.filter((t) => t.compactionBefore).length,
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
      min: recordedSeries.length ? minOf(recordedSeries) : null,
      avg: recordedSeries.length ? avgOf(recordedSeries) : null,
      max: recordedSeries.length ? maxOf(recordedSeries) : null,
    },
    savingsAvgTokens: avgOf(baselineSeries) - avgOf(pandoSeries),
    savingsMaxTokens: maxOf(baselineSeries) - maxOf(pandoSeries),
    policy,
  };

  return { stats, turns };
}

// Bypass updateMemoryForCompletedRound's structured-model path. We still use
// chunkRoundSources (with a whole-chunk stub) to get realistic chunk shapes,
// then apply the policy directly to build the next MemoryState.
async function directMemoryUpdate(
  body: Record<string, unknown>,
  previous: MemoryState,
  response: unknown,
  clients: StructuredClients,
  config: ProxyConfig,
  policy: StubPolicy,
): Promise<MemoryState> {
  const processed = new Set(previous.processedSourceIds);
  const requestSources = await extractNewRequestSources(body, processed);
  const assistantSources = await extractAssistantSourcesFromResponse(response);
  const newSources: RoundSource[] = [...requestSources, ...assistantSources].filter((s) =>
    !processed.has(s.sourceId)
  );
  if (newSources.length === 0) {
    return previous;
  }
  const drafts: ChunkDraft[] = await chunkRoundSources(newSources, config, clients);
  const kept = buildKeptChunks(policy, previous.chunks, drafts);
  const nextSeq = previous.roundSeq + 1;
  const newRecords: ChunkRecord[] = kept.newKeeps.map((c) => ({
    ...c,
    createdSeq: nextSeq,
  }));
  const combined = dedupeChunks([...kept.oldKeeps, ...newRecords]);
  const objectiveAfter = previous.objective ?? fallbackObjective(newSources);
  return {
    roundSeq: nextSeq,
    objective: objectiveAfter,
    chunks: objectiveAfter ? combined : [],
    processedSourceIds: unique([
      ...previous.processedSourceIds,
      ...drafts.map((d) => d.sourceId),
    ]),
  };
}

function buildKeptChunks(
  policy: StubPolicy,
  oldChunks: ChunkRecord[],
  newDrafts: ChunkDraft[],
): { oldKeeps: ChunkRecord[]; newKeeps: ChunkDraft[] } {
  switch (policy) {
    case "retain-all":
      return { oldKeeps: oldChunks, newKeeps: newDrafts };
    case "drop-tools":
      return {
        oldKeeps: oldChunks.filter((c) => c.sourceKind !== "tool"),
        newKeeps: newDrafts.filter((c) => c.sourceKind !== "tool"),
      };
    case "retain-recent": {
      const maxTotal = 12;
      const newKeeps = newDrafts.slice(-maxTotal);
      const remaining = Math.max(0, maxTotal - newKeeps.length);
      const oldKeeps = oldChunks.slice(-remaining);
      return { oldKeeps, newKeeps };
    }
    case "keep-none":
      return { oldKeeps: [], newKeeps: [] };
    case "cap-bytes": {
      const cap = 32_768;
      let used = 0;
      const newKeeps: ChunkDraft[] = [];
      for (const c of [...newDrafts].reverse()) {
        if (used + c.byteSize > cap) continue;
        used += c.byteSize;
        newKeeps.unshift(c);
      }
      const oldKeeps: ChunkRecord[] = [];
      for (const c of [...oldChunks].reverse()) {
        if (used + c.byteSize > cap) continue;
        used += c.byteSize;
        oldKeeps.unshift(c);
      }
      return { oldKeeps, newKeeps };
    }
  }
}

function fallbackObjective(sources: RoundSource[]): string | null {
  const userSource = sources.find((s) => s.sourceKind === "user");
  if (!userSource) return null;
  return "Continue the current user request.";
}

function sumOf(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function avgOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round(sumOf(xs) / xs.length);
}
function minOf(xs: number[]): number {
  return xs.length === 0 ? 0 : Math.min(...xs);
}
function maxOf(xs: number[]): number {
  return xs.length === 0 ? 0 : Math.max(...xs);
}

function unusedEstimate(): number {
  // retained to keep estimateTokensForValue in the import graph; value unused.
  return estimateTokensForValue({});
}
void unusedEstimate;
