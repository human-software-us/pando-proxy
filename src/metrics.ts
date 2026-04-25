import { stableJson } from "./json.ts";
import type { MemoryState } from "./memory_state.ts";

const APPROX_CHARS_PER_TOKEN = 4;

export type UsageMetrics = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  raw: Record<string, unknown>;
};

export type UsageTotals = {
  responsesWithUsage: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export class TokenUsageTracker {
  #bySession = new Map<string, UsageTotals>();

  add(sessionKey: string, usage: UsageMetrics): UsageTotals {
    const previous = this.#bySession.get(sessionKey) ?? {
      responsesWithUsage: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const next = {
      responsesWithUsage: previous.responsesWithUsage + 1,
      inputTokens: previous.inputTokens + (usage.inputTokens ?? 0),
      cachedInputTokens: previous.cachedInputTokens + (usage.cachedInputTokens ?? 0),
      outputTokens: previous.outputTokens + (usage.outputTokens ?? 0),
      totalTokens: previous.totalTokens + (
        usage.totalTokens ??
          ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
      ),
    };
    this.#bySession.set(sessionKey, next);
    return next;
  }
}

export function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

export function estimateBytesForText(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function estimateTokensForValue(value: unknown): number {
  return estimateTokensForText(stableJson(value));
}

export function estimateBytesForValue(value: unknown): number {
  return estimateBytesForText(stableJson(value));
}

export function requestContextMetrics(body: Record<string, unknown>): Record<string, unknown> {
  const items = Array.isArray(body.input)
    ? body.input
    : typeof body.input === "string"
    ? [body.input]
    : [];
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let developerMessageCount = 0;
  let toolOutputCount = 0;

  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "message" && record.role === "user") {
      userMessageCount += 1;
    } else if (record.type === "message" && record.role === "assistant") {
      assistantMessageCount += 1;
    } else if (record.type === "message" && record.role === "developer") {
      developerMessageCount += 1;
    } else if (
      typeof record.type === "string" &&
      (record.type === "function_call_output" || record.type.endsWith("_tool_call_output"))
    ) {
      toolOutputCount += 1;
    }
  }

  return {
    model: typeof body.model === "string" ? body.model : undefined,
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
    approxInputBytes: estimateBytesForValue(body),
    approxInputTokens: estimateTokensForValue(body),
    inputItemCount: items.length,
    userMessageCount,
    assistantMessageCount,
    developerMessageCount,
    toolOutputCount,
  };
}

export function memoryStateMetrics(state: MemoryState): Record<string, unknown> {
  return {
    roundSeq: state.roundSeq,
    groupCount: state.groups.length,
    groupIds: state.groups.map((group) => group.id),
    pieceCount: state.pieces.length,
    pieceIds: state.pieces.map((piece) => piece.id),
    pieceBytes: state.pieces.reduce((total, piece) => total + piece.byteSize, 0),
    processedSourceCount: state.processedSourceIds.length,
    inlinePieceCount: state.inlinePieceIds.length,
    inlinePieceIds: state.inlinePieceIds,
  };
}

export function extractUsageMetrics(value: unknown): UsageMetrics | null {
  const usage = findUsageObject(value);
  if (!usage) {
    return null;
  }
  return {
    inputTokens: numberField(usage, ["input_tokens", "prompt_tokens"]),
    cachedInputTokens: cachedInputTokensField(usage),
    outputTokens: numberField(usage, ["output_tokens", "completion_tokens"]),
    totalTokens: numberField(usage, ["total_tokens"]) ??
      sumDefined(
        numberField(usage, ["input_tokens", "prompt_tokens"]),
        numberField(usage, ["output_tokens", "completion_tokens"]),
      ),
    raw: usage,
  };
}

export function extractUsageMetricsFromResponseText(text: string): UsageMetrics | null {
  try {
    return extractUsageMetrics(JSON.parse(text));
  } catch {
    return null;
  }
}

function findUsageObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (!Array.isArray(value) && "usage" in value) {
    const usage = (value as Record<string, unknown>).usage;
    if (usage && typeof usage === "object" && !Array.isArray(usage)) {
      return usage as Record<string, unknown>;
    }
  }
  return null;
}

function numberField(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "number" && Number.isFinite(field)) {
      return field;
    }
  }
  return undefined;
}

function cachedInputTokensField(value: Record<string, unknown>): number | undefined {
  const direct = numberField(value, ["cached_input_tokens"]);
  if (direct !== undefined) {
    return direct;
  }
  const details = objectField(value, ["input_tokens_details", "prompt_tokens_details"]);
  if (!details) {
    return undefined;
  }
  return numberField(details, ["cached_tokens"]);
}

function objectField(
  value: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const field = value[key];
    if (field && typeof field === "object" && !Array.isArray(field)) {
      return field as Record<string, unknown>;
    }
  }
  return undefined;
}

function sumDefined(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) {
    return undefined;
  }
  return (a ?? 0) + (b ?? 0);
}
