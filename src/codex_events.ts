import { ProxyLogger } from "./logger.ts";
import { isRecord } from "./memory_state.ts";

export type AppServerDirection = "client_to_server" | "server_to_client";

export class CodexEventObserver {
  #logger: ProxyLogger;
  #latestExecThreadId: string | null = null;

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
