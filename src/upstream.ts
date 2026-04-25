import type { ProxyConfig } from "./config.ts";
import { resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import { stableJson } from "./json.ts";
import type { ProxyLogger } from "./logger.ts";
import { loggableBody, redactHeaders } from "./logger.ts";
import {
  chronologicalPieces,
  isRecord,
  type MemoryState,
} from "./memory_state.ts";
import { buildDerivedPrompt, makeGroupMemoryItem } from "./prompt_view.ts";
import type { ExactPiece } from "./store.ts";
import type { RoundSource } from "./tool_results.ts";
import { extractAssistantSourcesFromResponse, inputItems } from "./tool_results.ts";

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
  requestedPieceIds?: string[];
  returnedPieceIds: string[];
};

export type ResolveExactPieces = (pieceIds: string[]) => Promise<ExactPiece[]>;

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
  inlinePieceIds: string[],
  resolveExactPieces: ResolveExactPieces,
  sessionKey?: string,
): Promise<UpstreamLoopResult> {
  const fetches: LocalContextFetch[] = [];
  const assistantSources: RoundSource[] = [];
  const visiblePieceIds = new Set(inlinePieceIds);
  const loopOutputs: Record<string, unknown>[] = [];

  for (let iteration = 0; iteration <= config.maxLocalContextToolCalls; iteration += 1) {
    const requestBody = await rebuildLoopRequestBody(
      options.body,
      memory,
      visiblePieceIds,
      loopOutputs,
    );
    const upstream = await postResponsesJson(
      config,
      options.authHeader,
      requestBody,
      options.logger,
    );
    if (!upstream.ok) {
      return { ok: false, response: upstream.response, fetches };
    }

    const responseBody = upstream.body;
    assistantSources.push(...await extractAssistantSourcesFromResponse(responseBody));
    const localCalls = parseContextGetCalls(responseBody);
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
      throw new Error("Exceeded max local context_get calls");
    }

    for (const call of localCalls) {
      const exactPieces = await resolvePiecesForCall(
        memory,
        visiblePieceIds,
        call,
        resolveExactPieces,
      );
      for (const piece of exactPieces) {
        visiblePieceIds.add(piece.id);
      }
      fetches.push({
        offset: call.offset,
        limit: call.limit,
        ...(call.pieceIds.length > 0 ? { requestedPieceIds: call.pieceIds } : {}),
        returnedPieceIds: exactPieces.map((piece) => piece.id),
      });
      await options.logger?.log("context_get_fetch", {
        sessionKey,
        offset: call.offset,
        limit: call.limit,
        ...(call.pieceIds.length > 0 ? { requestedPieceIds: call.pieceIds } : {}),
        returnedPieceIds: exactPieces.map((piece) => piece.id),
      });
      loopOutputs.push(call.item);
      loopOutputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output: stableJson({
          items: exactPieces.map((piece) => ({ id: piece.id, payload: piece.payload })),
        }),
      });
    }
  }

  throw new Error("Unreachable local tool loop state");
}

async function rebuildLoopRequestBody(
  originalBody: Record<string, unknown>,
  memory: MemoryState,
  visiblePieceIds: Set<string>,
  loopOutputs: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const ordered = chronologicalPieces(memory.pieces);
  const inlinePieces = ordered.filter((piece) => visiblePieceIds.has(piece.id));
  const memoryItem = makeGroupMemoryItem(memory, inlinePieces);
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

async function resolvePiecesForCall(
  memory: MemoryState,
  visiblePieceIds: Set<string>,
  call: { offset: number; limit: number; pieceIds: string[] },
  resolveExactPieces: ResolveExactPieces,
): Promise<ExactPiece[]> {
  const available = chronologicalPieces(memory.pieces).filter((piece) =>
    !visiblePieceIds.has(piece.id)
  );
  const selectedIds = call.pieceIds.length > 0
    ? call.pieceIds.filter((id) => available.some((piece) => piece.id === id))
    : available.slice(call.offset, call.offset + call.limit).map((piece) => piece.id);
  return await resolveExactPieces(selectedIds);
}

function parseContextGetCalls(
  responseBody: Record<string, unknown>,
): Array<
  {
    callId: string;
    offset: number;
    limit: number;
    pieceIds: string[];
    item: Record<string, unknown>;
  }
> {
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const out: Array<
    {
      callId: string;
      offset: number;
      limit: number;
      pieceIds: string[];
      item: Record<string, unknown>;
    }
  > = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    if (
      item.type !== "function_call" || item.name !== "context_get" ||
      typeof item.call_id !== "string"
    ) {
      continue;
    }
    const parsed = parseContextGetArguments(item.arguments);
    out.push({
      callId: item.call_id,
      offset: parsed.offset,
      limit: parsed.limit,
      pieceIds: parsed.pieceIds,
      item,
    });
  }
  return out;
}

function parseContextGetArguments(
  argumentsValue: unknown,
): { offset: number; limit: number; pieceIds: string[] } {
  let parsed: unknown = argumentsValue;
  if (typeof argumentsValue === "string") {
    parsed = JSON.parse(argumentsValue);
  }
  if (!isRecord(parsed)) {
    return { offset: 0, limit: 10, pieceIds: [] };
  }
  const pieceIds = Array.isArray(parsed.pieceIds)
    ? parsed.pieceIds.filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    )
    : [];
  const offset =
    typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0
      ? parsed.offset
      : 0;
  const rawLimit = typeof parsed.limit === "number" && Number.isInteger(parsed.limit)
    ? parsed.limit
    : 10;
  const limit = Math.max(1, Math.min(50, rawLimit));
  return { offset, limit, pieceIds };
}

function baseLoopRequestBody(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  delete next.previous_response_id;
  delete next.input;
  delete next.stream;
  delete next.store;
  return next;
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
  return new Response(events.join(""), {
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

    if (!isRecord(parsed)) {
      continue;
    }

    if (isRecord(parsed.response)) {
      latestResponse = parsed.response;
    } else if (Array.isArray(parsed.output) || typeof parsed.output_text === "string") {
      latestResponse = parsed;
    }

    if (typeof parsed.output_index === "number" && "item" in parsed) {
      outputItems.set(parsed.output_index, parsed.item);
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

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}
