import type { ProxyConfig } from "./config.ts";
import { resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import { stableJson } from "./json.ts";
import type { ProxyLogger } from "./logger.ts";
import { loggableBody, redactHeaders } from "./logger.ts";
import type { MemoryState } from "./memory_state.ts";
import { isRecord } from "./memory_state.ts";
import type { ExactPiece, SessionStore } from "./store.ts";
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
  requestedPieceIds: string[];
  returnedPieceIds: string[];
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
  store: SessionStore,
  sessionKey: string,
  memory: MemoryState,
): Promise<UpstreamLoopResult> {
  let requestBody: Record<string, unknown> = { ...options.body, stream: false, store: false };
  const fetches: LocalContextFetch[] = [];
  const assistantSources: RoundSource[] = [];
  const allowedPieceIds = new Set(memory.pieces.map((piece) => piece.id));

  for (let iteration = 0; iteration <= config.maxLocalContextToolCalls; iteration += 1) {
    const upstream = await postResponsesJson(config, options.authHeader, requestBody, options.logger);
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
      throw new Error("Exceeded max local context_get tool calls");
    }

    const outputs: Array<Record<string, unknown>> = [];
    for (const call of localCalls) {
      const validPieceIds = call.pieceIds.filter((pieceId) => allowedPieceIds.has(pieceId));
      const pieces = await store.getExactPieces(sessionKey, validPieceIds);
      fetches.push({
        requestedPieceIds: [...call.pieceIds],
        returnedPieceIds: pieces.map((piece) => piece.id),
      });
      await options.logger?.log("context_get", {
        sessionKey,
        requestedPieceIds: call.pieceIds,
        validPieceIds,
        returnedPieceIds: pieces.map((piece) => piece.id),
      });
      outputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output: stableJson({
          pieces: pieces.map(serializeExactPiece),
        }),
      });
    }

    requestBody = {
      ...baseLoopRequestBody(options.body),
      previous_response_id: responseIdFromBody(responseBody),
      input: outputs,
      stream: false,
      store: false,
    };
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

  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Upstream response was not a JSON object");
  }
  return { ok: true, body: parsed, response };
}

function parseContextGetCalls(responseBody: Record<string, unknown>): Array<{ callId: string; pieceIds: string[] }> {
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const out: Array<{ callId: string; pieceIds: string[] }> = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const type = typeof item.type === "string" ? item.type : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (type !== "function_call" || name !== "context_get" || typeof item.call_id !== "string") {
      continue;
    }
    const parsed = parsePieceIds(item.arguments);
    out.push({
      callId: item.call_id,
      pieceIds: parsed,
    });
  }
  return out;
}

function parsePieceIds(argumentsValue: unknown): string[] {
  let parsed: unknown = argumentsValue;
  if (typeof argumentsValue === "string") {
    parsed = JSON.parse(argumentsValue);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.pieceIds)) {
    return [];
  }
  return parsed.pieceIds.filter((value): value is string => typeof value === "string");
}

function responseForClient(body: Record<string, unknown>, stream: boolean): Response {
  if (!stream) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  const text = `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`;
  return new Response(text, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function serializeExactPiece(piece: ExactPiece): Record<string, unknown> {
  return {
    id: piece.id,
    sourceKind: piece.sourceKind,
    ...(piece.toolName ? { toolName: piece.toolName } : {}),
    taskIds: piece.taskIds,
    ...(piece.pointer ? { pointer: piece.pointer } : {}),
    selector: piece.selector,
    payload: piece.payload,
  };
}

function responseIdFromBody(body: Record<string, unknown>): string {
  if (typeof body.id !== "string" || !body.id) {
    throw new Error("Upstream response missing id for local tool loop");
  }
  return body.id;
}
