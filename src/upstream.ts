import type { ProxyConfig } from "./config.ts";
import { resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import { stableJson } from "./json.ts";
import type { ProxyLogger } from "./logger.ts";
import { loggableBody, redactHeaders } from "./logger.ts";
import { chronologicalChunks, type ChunkRecord, type MemoryState } from "./memory_state.ts";
import { isRecord } from "./memory_state.ts";
import { buildDerivedPrompt, makeWorkingMemoryItem } from "./prompt_view.ts";
import type { RoundSource } from "./tool_results.ts";
import { extractAssistantSourcesFromResponse } from "./tool_results.ts";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export type UpstreamOptions = {
  authHeader: string | null;
  body: Record<string, unknown>;
  logger?: ProxyLogger;
};

export type LocalContextFetch = {
  offset: number;
  limit: number;
  requestedChunkIds?: string[];
  returnedChunkIds: string[];
};

export type UpstreamLoopResult =
  | {
    ok: true;
    finalBody: Record<string, unknown>;
    response: Response;
    assistantSources: RoundSource[];
    fetches: LocalContextFetch[];
  }
  | {
    ok: false;
    response: Response;
    fetches: LocalContextFetch[];
  };

export async function forwardResponsesRequest(
  config: ProxyConfig,
  options: UpstreamOptions,
): Promise<Response> {
  const headers = new Headers({ "content-type": "application/json" });
  if (options.authHeader) {
    headers.set("authorization", options.authHeader);
  }
  const url = responsesUrl(resolveUpstreamBaseUrl(config.upstreamBaseUrl, options.authHeader));
  await options.logger?.log("upstream_request", {
    url,
    headers: redactHeaders(headers),
    body: loggableBody(options.body),
  });

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(options.body),
  });

  await options.logger?.log("upstream_response", {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: redactHeaders(upstream.headers),
  });

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!hopByHopHeaders.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  }
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function runResponsesLoop(
  config: ProxyConfig,
  options: UpstreamOptions,
  memory: MemoryState,
  inlineChunkIds: string[],
  sessionKey?: string,
): Promise<UpstreamLoopResult> {
  let requestBody: Record<string, unknown> = { ...options.body, stream: true, store: false };
  const fetches: LocalContextFetch[] = [];
  const assistantSources: RoundSource[] = [];
  const visibleChunkIds = new Set(inlineChunkIds);
  const loopOutputs: Record<string, unknown>[] = [];

  for (let iteration = 0; iteration <= config.maxLocalContextToolCalls; iteration += 1) {
    requestBody = await rebuildLoopRequestBody(options.body, memory, visibleChunkIds, loopOutputs);
    const upstream = await postResponsesJson(config, options.authHeader, requestBody, options.logger);
    if (!upstream.ok) {
      return { ok: false, response: upstream.response, fetches };
    }

    const responseBody = upstream.body;
    assistantSources.push(...await extractAssistantSourcesFromResponse(responseBody));
    const localCalls = parseMemoryCalls(responseBody);
    if (localCalls.length === 0) {
      return {
        ok: true,
        finalBody: responseBody,
        response: responseForClient(responseBody, Boolean(options.body.stream)),
        assistantSources,
        fetches,
      };
    }
    if (iteration === config.maxLocalContextToolCalls) {
      throw new Error("Exceeded max local memory tool calls");
    }

    const outputs: Array<Record<string, unknown>> = [];
    for (const call of localCalls) {
      const items = resolveMemoryCallItems(memory, visibleChunkIds, call)
        .map((chunk) => ({ id: chunk.id, content: chunk.payload }));
      for (const item of items) {
        visibleChunkIds.add(item.id);
      }
      fetches.push({
        offset: call.offset,
        limit: call.limit,
        ...(call.chunkIds.length > 0 ? { requestedChunkIds: call.chunkIds } : {}),
        returnedChunkIds: items.map((item) => item.id),
      });
      await options.logger?.log("memory_fetch", {
        sessionKey,
        offset: call.offset,
        limit: call.limit,
        ...(call.chunkIds.length > 0 ? { requestedChunkIds: call.chunkIds } : {}),
        returnedChunkIds: items.map((item) => item.id),
      });
      outputs.push(call.item);
      outputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output: stableJson({
          items,
        }),
      });
    }
    loopOutputs.push(...outputs);
  }

  throw new Error("Unreachable local tool loop state");
}

function baseLoopRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  delete next.previous_response_id;
  delete next.input;
  delete next.stream;
  delete next.store;
  return next;
}

function inputItems(input: unknown): unknown[] {
  return Array.isArray(input) ? [...input] : [];
}

async function postResponsesJson(
  config: ProxyConfig,
  authHeader: string | null,
  body: Record<string, unknown>,
  logger?: ProxyLogger,
): Promise<
  | { ok: true; body: Record<string, unknown>; response: Response }
  | { ok: false; response: Response }
> {
  const headers = new Headers({ "content-type": "application/json" });
  if (authHeader) {
    headers.set("authorization", authHeader);
  }
  const url = responsesUrl(resolveUpstreamBaseUrl(config.upstreamBaseUrl, authHeader));
  await logger?.log("upstream_request", {
    url,
    headers: redactHeaders(headers),
    body: loggableBody(body),
  });

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await upstream.text();
  await logger?.log("upstream_response", {
    status: upstream.status,
    statusText: upstream.statusText,
    contentType: upstream.headers.get("content-type"),
    bodyPreview: text.slice(0, 2_000),
  });

  const response = new Response(text, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });
  if (!upstream.ok) {
    return { ok: false, response };
  }

  const parsed = parseResponsesBody(upstream.headers.get("content-type"), text);
  if (!isRecord(parsed)) {
    throw new Error("Upstream response was not a JSON object");
  }
  return { ok: true, body: parsed, response };
}

function parseMemoryCalls(
  responseBody: Record<string, unknown>,
): Array<{ callId: string; offset: number; limit: number; chunkIds: string[]; item: Record<string, unknown> }> {
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const out: Array<{ callId: string; offset: number; limit: number; chunkIds: string[]; item: Record<string, unknown> }> = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const type = typeof item.type === "string" ? item.type : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (type !== "function_call" || name !== "memory" || typeof item.call_id !== "string") {
      continue;
    }
    const parsed = parseMemoryArguments(item.arguments);
    out.push({
      callId: item.call_id,
      offset: parsed.offset,
      limit: parsed.limit,
      chunkIds: parsed.chunkIds,
      item,
    });
  }
  return out;
}

function parseMemoryArguments(argumentsValue: unknown): { offset: number; limit: number; chunkIds: string[] } {
  let parsed: unknown = argumentsValue;
  if (typeof argumentsValue === "string") {
    parsed = JSON.parse(argumentsValue);
  }
  if (!isRecord(parsed)) {
    return { offset: 0, limit: 10, chunkIds: [] };
  }
  const chunkIds = Array.isArray(parsed.chunkIds)
    ? parsed.chunkIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const offset = typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0
    ? parsed.offset
    : 0;
  const rawLimit = typeof parsed.limit === "number" && Number.isInteger(parsed.limit) ? parsed.limit : 10;
  const limit = Math.max(1, Math.min(50, rawLimit));
  return { offset, limit, chunkIds };
}

function responseForClient(body: Record<string, unknown>, stream: boolean): Response {
  if (!stream) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const events: string[] = [];
  const output = Array.isArray(body.output) ? body.output : [];
  for (let index = 0; index < output.length; index += 1) {
    const item = output[index];
    events.push(sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: index,
      item,
    }));
    events.push(sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: index,
      item,
    }));
  }
  events.push(sseEvent("response.completed", {
    type: "response.completed",
    response: body,
  }));
  events.push("data: [DONE]\n\n");
  const text = events.join("");
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function parseResponsesBody(contentType: string | null, text: string): unknown {
  if (isEventStream(contentType, text)) {
    return extractResponseFromSseText(text);
  }
  return JSON.parse(text);
}

function isEventStream(contentType: string | null, text: string): boolean {
  return (contentType?.toLowerCase().includes("text/event-stream") ?? false) ||
    text.startsWith("event:") ||
    text.startsWith("data:") ||
    text.includes("\ndata:");
}

function extractResponseFromSseText(streamText: string): Record<string, unknown> {
  let latestResponse: Record<string, unknown> | null = null;
  const outputItems = new Map<number, unknown>();

  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const candidate = responseObjectFromEvent(parsed);
    if (candidate) {
      latestResponse = candidate;
    }

    const itemEvent = outputItemFromEvent(parsed);
    if (itemEvent) {
      outputItems.set(itemEvent.outputIndex, itemEvent.item);
    }
  }

  if (!latestResponse) {
    throw new Error("Upstream SSE response did not include a final response object");
  }
  if (outputItems.size > 0) {
    latestResponse.output = [...outputItems.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, item]) => item);
  }
  return latestResponse;
}

function responseObjectFromEvent(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  if (isRecord(value.response)) {
    return value.response;
  }
  if (Array.isArray(value.output) || typeof value.output_text === "string") {
    return value;
  }
  return null;
}

function outputItemFromEvent(value: unknown): { outputIndex: number; item: unknown } | null {
  if (!isRecord(value) || typeof value.output_index !== "number" || !("item" in value)) {
    return null;
  }
  return {
    outputIndex: value.output_index,
    item: value.item,
  };
}

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function buildAvailableMemoryChunks(memory: MemoryState, inlineChunkIds: string[]): ChunkRecord[] {
  const inlineIds = new Set(inlineChunkIds);
  return chronologicalChunks(memory.chunks).filter((chunk) => !inlineIds.has(chunk.id));
}

function resolveMemoryCallItems(
  memory: MemoryState,
  visibleChunkIds: Set<string>,
  call: { offset: number; limit: number; chunkIds: string[] },
): ChunkRecord[] {
  const availableChunks = chronologicalChunks(memory.chunks)
    .filter((chunk) => !visibleChunkIds.has(chunk.id));
  if (call.chunkIds.length > 0) {
    const byId = new Map(availableChunks.map((chunk) => [chunk.id, chunk] as const));
    return call.chunkIds
      .map((chunkId) => byId.get(chunkId))
      .filter((chunk): chunk is ChunkRecord => Boolean(chunk));
  }
  return availableChunks.slice(call.offset, call.offset + call.limit);
}

async function rebuildLoopRequestBody(
  originalBody: Record<string, unknown>,
  memory: MemoryState,
  visibleChunkIds: Set<string>,
  loopOutputs: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const ordered = chronologicalChunks(memory.chunks);
  const inlineChunks = ordered.filter((chunk) => visibleChunkIds.has(chunk.id));
  const memoryItem = makeWorkingMemoryItem(memory, inlineChunks);
  const derived = await buildDerivedPrompt(
    [...inputItems(originalBody.input), ...loopOutputs],
    memoryItem,
  );
  return {
    ...baseLoopRequestBody(originalBody),
    input: derived.input,
    stream: true,
    store: false,
  };
}
