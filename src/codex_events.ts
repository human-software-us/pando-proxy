import { ProxyLogger } from "./logger.ts";
import { isRecord } from "./memory_state.ts";
import type { RoundSource } from "./tool_results.ts";

export type AppServerDirection = "client_to_server" | "server_to_client";

export class CodexEventObserver {
  #logger: ProxyLogger;
  #latestExecThreadId: string | null = null;
  #currentExecTurnSourcesByThread = new Map<string, RoundSource[]>();
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

    const payload = parseJson(trimmed);
    const threadId = extractExecThreadId(payload);
    if (threadId) {
      this.#latestExecThreadId = threadId;
    }
    this.#observeExecTurnBoundary(payload, this.#latestExecThreadId);
    const toolSource = extractExecToolSource(payload);
    if (toolSource && this.#latestExecThreadId) {
      const existing = this.#currentExecTurnSourcesByThread.get(this.#latestExecThreadId) ?? [];
      existing.push(toolSource);
      this.#currentExecTurnSourcesByThread.set(this.#latestExecThreadId, existing);
    }
    await this.#logger.log("codex_exec_event", {
      source: "codex_exec_json",
      ...summaryFor(payload),
      payload,
    });
  }

  async observeAppServerFrame(direction: AppServerDirection, frame: unknown): Promise<void> {
    const payload = await payloadForFrame(frame);
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

  #observeExecTurnBoundary(payload: unknown, threadId: string | null): void {
    if (!threadId || !isRecord(payload) || typeof payload.type !== "string") {
      return;
    }
    if (payload.type === "turn.started") {
      this.#currentExecTurnSourcesByThread.set(threadId, []);
      return;
    }
    if (payload.type === "turn.completed") {
      const sources = this.#currentExecTurnSourcesByThread.get(threadId) ?? [];
      this.#currentExecTurnSourcesByThread.delete(threadId);
      this.#enqueueCompletedExecTurn(threadId, sources);
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
