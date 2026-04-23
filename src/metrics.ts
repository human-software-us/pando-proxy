import { stableJson } from "./json.ts";
import { isRecord, MemoryState } from "./memory_state.ts";

export const METRICS_EVENT_PREFIX = "pando_proxy_metrics_";
export const METRICS_MARKER = "PANDO_PROXY_METRICS";

const APPROX_CHARS_PER_TOKEN = 4;

export type UsageMetrics = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  raw: Record<string, unknown>;
};

export type UsageTotals = {
  responsesWithUsage: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export class TokenUsageTracker {
  #bySession = new Map<string, UsageTotals>();

  add(sessionKey: string, usage: UsageMetrics): UsageTotals {
    const previous = this.#bySession.get(sessionKey) ?? {
      responsesWithUsage: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const next = {
      responsesWithUsage: previous.responsesWithUsage + 1,
      inputTokens: previous.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: previous.outputTokens + (usage.outputTokens ?? 0),
      totalTokens: previous.totalTokens + (usage.totalTokens ?? 0),
    };
    this.#bySession.set(sessionKey, next);
    return next;
  }
}

export function estimateTokensForValue(value: unknown): number {
  return estimateTokensForText(typeof value === "string" ? value : stableJson(value));
}

export function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

export function requestContextMetrics(body: Record<string, unknown>): Record<string, unknown> {
  const input = body.input;
  const items = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let developerMessageCount = 0;
  let systemMessageCount = 0;
  let toolCallCount = 0;
  let toolOutputCount = 0;

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const type = String(item.type ?? "");
    const role = String(item.role ?? "");
    if (type === "message" && role === "user") {
      userMessageCount += 1;
    } else if (type === "message" && role === "assistant") {
      assistantMessageCount += 1;
    } else if (type === "message" && role === "developer") {
      developerMessageCount += 1;
    } else if (type === "message" && role === "system") {
      systemMessageCount += 1;
    }

    if (type.endsWith("_tool_call") || type === "function_call" || type === "mcp_tool_call") {
      toolCallCount += 1;
    } else if (type.endsWith("_tool_call_output") || type === "function_call_output") {
      toolOutputCount += 1;
    }
  }

  return {
    model: typeof body.model === "string" ? body.model : undefined,
    stream: typeof body.stream === "boolean" ? body.stream : undefined,
    bodyChars: stableJson(body).length,
    approxInputTokens: estimateTokensForValue(body),
    inputItemCount: items.length,
    userMessageCount,
    assistantMessageCount,
    developerMessageCount,
    systemMessageCount,
    toolCallCount,
    toolOutputCount,
  };
}

export function memoryStateMetrics(
  state: MemoryState,
  handledInputIds: string[],
): Record<string, unknown> {
  return {
    taskUpdateSeq: state.taskUpdateSeq,
    taskCount: state.tasks.length,
    openTaskCount: state.tasks.filter((task) => task.status === "open").length,
    inProgressTaskCount: state.tasks.filter((task) => task.status === "in_progress").length,
    activeTaskId: state.activeTaskId,
    keptUserMessageCount: state.keptUserMessages.length,
    memoryChunkCount: state.memoryLibrary.length,
    memoryChunkTaskLinkCount: state.memoryLibrary.reduce(
      (total, chunk) => total + chunk.taskIds.length,
      0,
    ),
    handledInputCount: handledInputIds.length,
    approxMemoryStateTokens: estimateTokensForValue(state),
  };
}

export function extractUsageMetrics(value: unknown): UsageMetrics | null {
  const usage = findUsageObject(value);
  if (!usage) {
    return null;
  }
  return {
    inputTokens: numberField(usage, ["input_tokens", "prompt_tokens"]),
    outputTokens: numberField(usage, ["output_tokens", "completion_tokens"]),
    totalTokens: numberField(usage, ["total_tokens"]),
    raw: usage,
  };
}

export function extractUsageMetricsFromResponseText(text: string): UsageMetrics | null {
  const fromSse = extractUsageMetricsFromSse(text);
  if (fromSse) {
    return fromSse;
  }

  try {
    return extractUsageMetrics(JSON.parse(text));
  } catch {
    return null;
  }
}

function extractUsageMetricsFromSse(text: string): UsageMetrics | null {
  let latest: UsageMetrics | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      latest = extractUsageMetrics(JSON.parse(data)) ?? latest;
    } catch {
      continue;
    }
  }
  return latest;
}

function findUsageObject(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  if (isUsageObject(value)) {
    return value;
  }

  for (const key of ["usage", "response"]) {
    const child = value[key];
    if (isRecord(child)) {
      const found = findUsageObject(child);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function isUsageObject(value: Record<string, unknown>): boolean {
  return typeof value.input_tokens === "number" ||
    typeof value.output_tokens === "number" ||
    typeof value.total_tokens === "number" ||
    typeof value.prompt_tokens === "number" ||
    typeof value.completion_tokens === "number";
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
