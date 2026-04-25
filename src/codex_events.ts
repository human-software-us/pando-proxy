import { ProxyLogger } from "./logger.ts";
import { isRecord } from "./memory_state.ts";
import type { RoundSource } from "./tool_results.ts";

export type AppServerDirection = "client_to_server" | "server_to_client";

type ObservedExecTurnState = {
  sources: RoundSource[];
  eventTypeCounts: Record<string, number>;
  rolloutEnvelopeTypeCounts: Record<string, number>;
  responseItemTypeCounts: Record<string, number>;
  responseMessageRoleCounts: Record<string, number>;
  eventMsgTypeCounts: Record<string, number>;
  observedToolNames: Set<string>;
};

export class CodexEventObserver {
  #logger: ProxyLogger;
  #latestExecThreadId: string | null = null;
  #currentExecTurnStateByThread = new Map<string, ObservedExecTurnState>();
  #completedExecTurnsByThread = new Map<string, RoundSource[][]>();
  #waitersByThread = new Map<string, Array<(sources: RoundSource[]) => void>>();

  constructor(logger: ProxyLogger) {
    this.#logger = logger;
  }

  async observeExecJsonLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    const parsed = parseJson(trimmed);
    const payload = normalizeObserverPayload(parsed);
    const threadId = extractExecThreadId(payload);
    if (threadId) {
      this.#latestExecThreadId = threadId;
    }
    const activeThreadId = threadId ?? this.#latestExecThreadId;
    if (activeThreadId && isRecord(payload) && payload.type === "turn.started") {
      this.#currentExecTurnStateByThread.set(activeThreadId, emptyObservedExecTurnState());
    }
    await this.#observeExecTurnArtifacts(parsed, payload, activeThreadId);
    const toolSource = extractExecToolSource(payload);
    if (toolSource && activeThreadId) {
      const state = this.#currentExecTurnStateByThread.get(activeThreadId);
      if (state) {
        state.sources.push(toolSource);
      }
    }
    await this.#logger.log("codex_exec_event", {
      source: "codex_exec_json",
      ...summaryFor(payload),
      payload,
    });
    await this.#observeExecTurnBoundary(payload, activeThreadId);
  }

  async observeAppServerFrame(direction: AppServerDirection, frame: unknown): Promise<void> {
    const payload = await payloadForFrame(frame);
    const threadId = extractExecThreadId(payload);
    if (threadId) {
      this.#latestExecThreadId = threadId;
    }
    await this.#logger.log("codex_app_server_frame", {
      source: "codex_app_server_ws",
      direction,
      ...summaryFor(payload),
      payload,
    });
  }

  latestExecThreadId(): string | null {
    return this.#latestExecThreadId;
  }

  waitForExecTurn(threadId: string, timeoutMs: number): Promise<RoundSource[]> {
    const completed = this.#completedExecTurnsByThread.get(threadId);
    if (completed && completed.length > 0) {
      const next = completed.shift() ?? [];
      if (completed.length === 0) {
        this.#completedExecTurnsByThread.delete(threadId);
      }
      return Promise.resolve(next);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiters = this.#waitersByThread.get(threadId) ?? [];
        this.#waitersByThread.set(
          threadId,
          waiters.filter((waiter) => waiter !== onReady),
        );
        resolve([]);
      }, timeoutMs);

      const onReady = (sources: RoundSource[]) => {
        clearTimeout(timer);
        resolve(sources);
      };

      const waiters = this.#waitersByThread.get(threadId) ?? [];
      waiters.push(onReady);
      this.#waitersByThread.set(threadId, waiters);
    });
  }

  async #observeExecTurnArtifacts(
    rawPayload: unknown,
    payload: unknown,
    threadId: string | null,
  ): Promise<void> {
    if (!threadId) {
      return;
    }
    const state = this.#currentExecTurnStateByThread.get(threadId);
    if (!state) {
      return;
    }
    recordPayloadCounts(state, rawPayload, payload);
  }

  async #observeExecTurnBoundary(payload: unknown, threadId: string | null): Promise<void> {
    if (!threadId || !isRecord(payload) || typeof payload.type !== "string") {
      return;
    }
    if (payload.type === "turn.completed") {
      const state = this.#currentExecTurnStateByThread.get(threadId) ??
        emptyObservedExecTurnState();
      this.#currentExecTurnStateByThread.delete(threadId);
      await this.#logger.log("codex_exec_turn_summary", {
        threadId,
        sourceCount: state.sources.length,
        sourceIds: state.sources.map((source) => source.sourceId),
        sourceKindCounts: countBySourceKind(state.sources),
        eventTypeCounts: state.eventTypeCounts,
        rolloutEnvelopeTypeCounts: state.rolloutEnvelopeTypeCounts,
        responseItemTypeCounts: state.responseItemTypeCounts,
        responseMessageRoleCounts: state.responseMessageRoleCounts,
        eventMsgTypeCounts: state.eventMsgTypeCounts,
        observedToolNames: [...state.observedToolNames].sort(),
        toolCallCount: state.responseItemTypeCounts.function_call ?? 0,
        toolResultCount: observedToolResultCount(state),
        reasoningCount: state.responseItemTypeCounts.reasoning ?? 0,
        assistantMessageCount: (state.responseMessageRoleCounts.assistant ?? 0) +
          (state.eventMsgTypeCounts.agent_message ?? 0),
        userMessageCount: (state.responseMessageRoleCounts.user ?? 0) +
          (state.eventMsgTypeCounts.user_message ?? 0),
      });
      this.#enqueueCompletedExecTurn(threadId, state.sources);
    }
  }

  #enqueueCompletedExecTurn(threadId: string, sources: RoundSource[]): void {
    const waiters = this.#waitersByThread.get(threadId);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift();
      if (waiters.length === 0) {
        this.#waitersByThread.delete(threadId);
      } else {
        this.#waitersByThread.set(threadId, waiters);
      }
      next?.(sources);
      return;
    }

    const completed = this.#completedExecTurnsByThread.get(threadId) ?? [];
    completed.push(sources);
    this.#completedExecTurnsByThread.set(threadId, completed);
  }
}

function emptyObservedExecTurnState(): ObservedExecTurnState {
  return {
    sources: [],
    eventTypeCounts: {},
    rolloutEnvelopeTypeCounts: {},
    responseItemTypeCounts: {},
    responseMessageRoleCounts: {},
    eventMsgTypeCounts: {},
    observedToolNames: new Set<string>(),
  };
}

async function payloadForFrame(frame: unknown): Promise<unknown> {
  if (typeof frame === "string") {
    return parseJson(frame);
  }
  if (frame instanceof ArrayBuffer) {
    return { binaryBase64: base64(frame), bytes: frame.byteLength };
  }
  if (frame instanceof Blob) {
    const buffer = await frame.arrayBuffer();
    return { binaryBase64: base64(buffer), bytes: buffer.byteLength };
  }
  return frame;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeObserverPayload(value: unknown): unknown {
  const rolloutPayload = rolloutEnvelopeToExecPayload(value);
  return rolloutPayload ?? value;
}

function rolloutEnvelopeToExecPayload(value: unknown): unknown | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  if (!isRecord(value.payload)) {
    return null;
  }

  const payload = value.payload;
  if (value.type === "session_meta" && typeof payload.id === "string") {
    return { type: "thread.started", thread_id: payload.id };
  }

  if (value.type !== "event_msg" || typeof payload.type !== "string") {
    return null;
  }

  if (payload.type === "task_started") {
    return {
      type: "turn.started",
      params: {
        turnId: stringField(payload, "turn_id"),
      },
    };
  }

  if (payload.type === "task_complete") {
    return {
      type: "turn.completed",
      params: {
        turnId: stringField(payload, "turn_id"),
      },
    };
  }

  if (payload.type === "exec_command_end") {
    const output = typeof payload.aggregated_output === "string" ? payload.aggregated_output : "";
    if (!output) {
      return null;
    }
    return {
      type: "item.completed",
      item: {
        type: "command_execution",
        status: "completed",
        aggregated_output: output,
        id: stringField(payload, "call_id") ?? stringField(payload, "process_id") ??
          stringField(payload, "turn_id"),
        command: Array.isArray(payload.command)
          ? payload.command.filter((part) => typeof part === "string").join(" ")
          : stringField(payload, "command"),
      },
    };
  }

  return null;
}

function extractExecThreadId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (payload.type === "thread.started" && typeof payload.thread_id === "string") {
    return payload.thread_id;
  }
  const params = isRecord(payload.params) ? payload.params : null;
  if (params && typeof params.threadId === "string") {
    return params.threadId;
  }
  const thread = params && isRecord(params.thread) ? params.thread : null;
  if (thread && typeof thread.id === "string") {
    return thread.id;
  }
  return null;
}

function extractExecToolSource(payload: unknown): RoundSource | null {
  if (!isRecord(payload) || payload.type !== "item.completed") {
    return null;
  }
  const item = isRecord(payload.item) ? payload.item : null;
  if (!item || item.type !== "command_execution" || item.status !== "completed") {
    return null;
  }
  const output = typeof item.aggregated_output === "string" ? item.aggregated_output : "";
  if (!output) {
    return null;
  }
  const itemId = typeof item.id === "string" && item.id ? item.id : null;
  const command = typeof item.command === "string" ? item.command : null;
  return {
    sourceId: itemId ? `exec_observed_${itemId}` : `exec_observed_${shortHashString(output)}`,
    sourceKind: "tool",
    toolName: "exec_command",
    payload: output,
    pointer: {
      itemType: "command_execution",
      ...(itemId ? { itemId } : {}),
      ...(command ? { command } : {}),
    },
  };
}

function recordPayloadCounts(
  state: ObservedExecTurnState,
  rawPayload: unknown,
  payload: unknown,
): void {
  if (isRecord(rawPayload) && typeof rawPayload.type === "string") {
    incrementCount(state.rolloutEnvelopeTypeCounts, rawPayload.type);
  }

  if (!isRecord(payload) || typeof payload.type !== "string") {
    return;
  }
  incrementCount(state.eventTypeCounts, payload.type);

  if (payload.type === "item.completed") {
    const item = isRecord(payload.item) ? payload.item : null;
    if (item && item.type === "command_execution") {
      state.observedToolNames.add("exec_command");
    }
    return;
  }

  if (payload.type === "response_item") {
    const item = isRecord(payload.payload) ? payload.payload : null;
    if (!item || typeof item.type !== "string") {
      return;
    }
    incrementCount(state.responseItemTypeCounts, item.type);
    if (item.type === "message" && typeof item.role === "string") {
      incrementCount(state.responseMessageRoleCounts, item.role);
    }
    const toolName = toolNameForObservedItem(item);
    if (toolName) {
      state.observedToolNames.add(toolName);
    }
    return;
  }

  if (payload.type === "event_msg") {
    const message = isRecord(payload.payload) ? payload.payload : null;
    if (!message || typeof message.type !== "string") {
      return;
    }
    incrementCount(state.eventMsgTypeCounts, message.type);
  }
}

function summaryFor(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    return { parsed: false };
  }

  const params = isRecord(payload.params) ? payload.params : {};
  const item = isRecord(params.item) ? params.item : {};
  const turn = isRecord(params.turn) ? params.turn : {};
  const thread = isRecord(params.thread) ? params.thread : {};

  return {
    parsed: true,
    method: stringField(payload, "method"),
    id: payload.id,
    eventType: stringField(payload, "type"),
    threadId: stringField(params, "threadId") ?? stringField(thread, "id"),
    turnId: stringField(params, "turnId") ?? stringField(turn, "id"),
    itemId: stringField(params, "itemId") ?? stringField(item, "id"),
    itemType: stringField(item, "type"),
    itemStatus: stringField(item, "status"),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function countBySourceKind(sources: RoundSource[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const source of sources) {
    incrementCount(counts, source.sourceKind);
  }
  return counts;
}

function observedToolResultCount(state: ObservedExecTurnState): number {
  let count = state.eventTypeCounts["item.completed"] ?? 0;
  for (const [itemType, itemCount] of Object.entries(state.responseItemTypeCounts)) {
    if (isToolResultItemType(itemType)) {
      count += itemCount;
    }
  }
  return count;
}

function toolNameForObservedItem(item: Record<string, unknown>): string | null {
  const directName = stringField(item, "name");
  if (directName) {
    return directName;
  }
  if (item.type === "function_call" || isToolResultItemType(stringField(item, "type") ?? "")) {
    return "unknown_tool";
  }
  return null;
}

function isToolResultItemType(type: string): boolean {
  return type === "function_call_output" ||
    type.endsWith("_tool_call_output") ||
    type === "custom_tool_call_output" ||
    type === "mcp_tool_call_output";
}

function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function shortHashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0).toString(16);
}
