import type { ProxyConfig } from "./config.ts";
import { resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import { stableJson } from "./json.ts";
import type { ProxyLogger } from "./logger.ts";
import { loggableBody, redactHeaders } from "./logger.ts";
import { isRecord, type MaterializedMemoryState } from "./memory_state.ts";
import { buildDerivedPrompt, makePromptMemoryItem } from "./prompt_view.ts";
import type { ArchivedSource } from "./store.ts";
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

const MAX_LOCAL_RECALLS_PER_ROUND = 3;
const MAX_UPSTREAM_ATTEMPTS = 2;
const UPSTREAM_RETRY_DELAY_MS = 500;

export type UpstreamOptions = {
  authHeader: string | null;
  body: Record<string, unknown>;
  logger?: ProxyLogger;
};

export type ArchiveRecall = {
  offset: number;
  limit: number;
  returnedSourceIds: string[];
  returnedBytes: number;
};

export type ResolveArchivedSources = (sourceIds: string[]) => Promise<ArchivedSource[]>;

export type UpstreamLoopResult =
  | {
    ok: true;
    finalBody: Record<string, unknown>;
    response: Response;
    assistantSources: RoundSource[];
    recalls: ArchiveRecall[];
  }
  | {
    ok: false;
    response: Response;
    recalls: ArchiveRecall[];
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
  const bodyText = JSON.stringify(options.body);
  const upstream = await fetchResponsesWithRetry({
    url,
    headers,
    bodyText,
    logger: options.logger,
    logBody: options.body,
  });

  let responseBody = upstream.body;
  if (options.logger && upstream.body) {
    const [clientBody, logBody] = upstream.body.tee();
    responseBody = clientBody;
    void new Response(logBody).text()
      .then((body) =>
        options.logger?.log("upstream_response_body", {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: redactHeaders(upstream.headers),
          body,
        })
      )
      .catch((error) =>
        options.logger?.log("upstream_response_body_failed", {
          status: upstream.status,
          message: error instanceof Error ? error.message : String(error),
        })
      );
  }

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

  return new Response(responseBody, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export async function runResponsesLoop(
  config: ProxyConfig,
  options: UpstreamOptions,
  memory: MaterializedMemoryState,
  resolveArchivedSources: ResolveArchivedSources,
  sessionKey?: string,
): Promise<UpstreamLoopResult> {
  const recalls: ArchiveRecall[] = [];
  const assistantSources: RoundSource[] = [];
  const loopOutputs: Record<string, unknown>[] = [];

  for (let iteration = 0; iteration <= MAX_LOCAL_RECALLS_PER_ROUND; iteration += 1) {
    const requestBody = await rebuildLoopRequestBody(
      options.body,
      memory,
      loopOutputs,
    );
    await options.logger?.log("upstream_loop_iteration", {
      sessionKey,
      iteration,
      loopOutputCount: loopOutputs.length,
      requestBody,
    });
    const upstream = await postResponsesJson(
      config,
      options.authHeader,
      requestBody,
      options.logger,
    );
    if (!upstream.ok) {
      return { ok: false, response: upstream.response, recalls };
    }

    const responseBody = upstream.body;
    assistantSources.push(...await extractAssistantSourcesFromResponse(responseBody));
    const localCalls = parseRecallCalls(responseBody);
    if (localCalls.length === 0) {
      return {
        ok: true,
        finalBody: responseBody,
        response: responseForClient(responseBody, Boolean(options.body.stream)),
        assistantSources,
        recalls,
      };
    }
    if (recalls.length + localCalls.length > MAX_LOCAL_RECALLS_PER_ROUND) {
      throw new Error(
        `Exceeded max local recall calls (${MAX_LOCAL_RECALLS_PER_ROUND})`,
      );
    }

    for (const call of localCalls) {
      const recallResult = await resolveSourcesForCall(
        memory,
        call,
        resolveArchivedSources,
      );
      const archivedSources = recallResult.items;
      recalls.push({
        offset: call.offset,
        limit: call.limit,
        returnedSourceIds: archivedSources.map((source) => source.sourceId),
        returnedBytes: bytesForValue(archivedSources.map((source) => source.payload)),
      });
      await options.logger?.log("archive_recall", {
        sessionKey,
        offset: call.offset,
        limit: call.limit,
        returnedSourceIds: archivedSources.map((source) => source.sourceId),
        returnedBytes: bytesForValue(archivedSources.map((source) => source.payload)),
        returnedSources: archivedSources,
      });
      loopOutputs.push(call.item);
      loopOutputs.push({
        type: "function_call_output",
        call_id: call.callId,
        output: stableJson({
          source: "archive",
          remainingArchivedSourceCount: recallResult.remainingArchivedSourceCount,
          requestedOffset: call.offset,
          requestedLimit: call.limit,
          returnedCount: archivedSources.length,
          note:
            "The following items are from the per-session archive, not active memory. They were dropped from working memory earlier and will not automatically persist in future prompts.",
          items: archivedSources.map((source) => ({
            sourceId: source.sourceId,
            sourceKind: source.sourceKind,
            ...(source.toolName ? { toolName: source.toolName } : {}),
            payload: source.payload,
          })),
        }),
      });
    }
  }

  throw new Error("Unreachable local tool loop state");
}

async function rebuildLoopRequestBody(
  originalBody: Record<string, unknown>,
  memory: MaterializedMemoryState,
  loopOutputs: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const memoryItem = makePromptMemoryItem(memory, memory.pieces);
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

async function resolveSourcesForCall(
  memory: MaterializedMemoryState,
  call: { offset: number; limit: number },
  resolveArchivedSources: ResolveArchivedSources,
): Promise<{ remainingArchivedSourceCount: number; items: ArchivedSource[] }> {
  const activeSourceIds = new Set(memory.pieces.map((piece) => piece.sourceId));
  const availableSourceIds = memory.processedSourceIds.filter((sourceId) =>
    !activeSourceIds.has(sourceId)
  );
  const selectedIds = availableSourceIds.slice(call.offset, call.offset + call.limit);
  return {
    remainingArchivedSourceCount: Math.max(
      0,
      availableSourceIds.length - (call.offset + selectedIds.length),
    ),
    items: await resolveArchivedSources(selectedIds),
  };
}

function parseRecallCalls(
  responseBody: Record<string, unknown>,
): Array<
  {
    callId: string;
    offset: number;
    limit: number;
    item: Record<string, unknown>;
  }
> {
  const output = Array.isArray(responseBody.output) ? responseBody.output : [];
  const out: Array<
    {
      callId: string;
      offset: number;
      limit: number;
      item: Record<string, unknown>;
    }
  > = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    if (
      item.type !== "function_call" || item.name !== "recall" ||
      typeof item.call_id !== "string"
    ) {
      continue;
    }
    const parsed = parseRecallArguments(item.arguments);
    out.push({
      callId: item.call_id,
      offset: parsed.offset,
      limit: parsed.limit,
      item,
    });
  }
  return out;
}

function parseRecallArguments(argumentsValue: unknown): { offset: number; limit: number } {
  let parsed: unknown = argumentsValue;
  if (typeof argumentsValue === "string") {
    parsed = JSON.parse(argumentsValue);
  }
  if (!isRecord(parsed)) {
    return { offset: 0, limit: 5 };
  }
  const offset =
    typeof parsed.offset === "number" && Number.isInteger(parsed.offset) && parsed.offset >= 0
      ? parsed.offset
      : 0;
  const rawLimit = typeof parsed.limit === "number" && Number.isInteger(parsed.limit)
    ? parsed.limit
    : 5;
  const limit = Math.max(1, rawLimit);
  return { offset, limit };
}

function bytesForValue(value: unknown): number {
  return new TextEncoder().encode(stableJson(value)).byteLength;
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
  const bodyText = JSON.stringify(body);
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    await logger?.log("upstream_request", {
      attempt,
      maxAttempts: MAX_UPSTREAM_ATTEMPTS,
      url,
      headers: redactHeaders(headers),
      body: loggableBody(body),
    });
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: "POST",
        headers,
        body: bodyText,
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_UPSTREAM_ATTEMPTS) {
        await logger?.log("upstream_failed", {
          attempt,
          maxAttempts: MAX_UPSTREAM_ATTEMPTS,
          reason: "fetch_error",
          message: messageFor(error),
        });
        throw error;
      }
      await logger?.log("upstream_retry", {
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: MAX_UPSTREAM_ATTEMPTS,
        reason: "fetch_error",
        message: messageFor(error),
        delayMs: UPSTREAM_RETRY_DELAY_MS,
      });
      await delay(UPSTREAM_RETRY_DELAY_MS);
      continue;
    }

    const text = await upstream.text();
    await logger?.log("upstream_response", {
      attempt,
      maxAttempts: MAX_UPSTREAM_ATTEMPTS,
      status: upstream.status,
      statusText: upstream.statusText,
      contentType: upstream.headers.get("content-type"),
      headers: redactHeaders(upstream.headers),
      body: text,
    });

    const response = new Response(text, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
    if (!upstream.ok) {
      if (isRetryableUpstreamStatus(upstream.status) && attempt < MAX_UPSTREAM_ATTEMPTS) {
        await logger?.log("upstream_retry", {
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts: MAX_UPSTREAM_ATTEMPTS,
          reason: "retryable_status",
          status: upstream.status,
          statusText: upstream.statusText,
          headers: redactHeaders(upstream.headers),
          body: text,
          delayMs: UPSTREAM_RETRY_DELAY_MS,
        });
        await delay(UPSTREAM_RETRY_DELAY_MS);
        continue;
      }
      return { ok: false, response };
    }

    try {
      const parsed = parseResponsesBody(upstream.headers.get("content-type"), text);
      if (!isRecord(parsed)) {
        throw new Error("Upstream response was not a JSON object");
      }
      return { ok: true, body: parsed, response };
    } catch (error) {
      lastError = error;
      if (attempt === MAX_UPSTREAM_ATTEMPTS) {
        await logger?.log("upstream_failed", {
          attempt,
          maxAttempts: MAX_UPSTREAM_ATTEMPTS,
          reason: "invalid_response_body",
          message: messageFor(error),
          status: upstream.status,
          statusText: upstream.statusText,
          contentType: upstream.headers.get("content-type"),
          headers: redactHeaders(upstream.headers),
          body: text,
        });
        throw error;
      }
      await logger?.log("upstream_retry", {
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: MAX_UPSTREAM_ATTEMPTS,
        reason: "invalid_response_body",
        message: messageFor(error),
        status: upstream.status,
        statusText: upstream.statusText,
        contentType: upstream.headers.get("content-type"),
        headers: redactHeaders(upstream.headers),
        body: text,
        delayMs: UPSTREAM_RETRY_DELAY_MS,
      });
      await delay(UPSTREAM_RETRY_DELAY_MS);
    }
  }
  throw lastError ?? new Error("Upstream response was not parseable");
}

async function fetchResponsesWithRetry(options: {
  url: string;
  headers: Headers;
  bodyText: string;
  logger?: ProxyLogger;
  logBody: Record<string, unknown>;
}): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    await options.logger?.log("upstream_request", {
      attempt,
      maxAttempts: MAX_UPSTREAM_ATTEMPTS,
      url: options.url,
      headers: redactHeaders(options.headers),
      body: loggableBody(options.logBody),
    });
    try {
      const response = await fetch(options.url, {
        method: "POST",
        headers: options.headers,
        body: options.bodyText,
      });
      if (!isRetryableUpstreamStatus(response.status) || attempt === MAX_UPSTREAM_ATTEMPTS) {
        return response;
      }
      const retryBody = await response.text().catch(() => "");
      await options.logger?.log("upstream_retry", {
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: MAX_UPSTREAM_ATTEMPTS,
        reason: "retryable_status",
        status: response.status,
        statusText: response.statusText,
        headers: redactHeaders(response.headers),
        body: retryBody,
        delayMs: UPSTREAM_RETRY_DELAY_MS,
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_UPSTREAM_ATTEMPTS) {
        await options.logger?.log("upstream_failed", {
          attempt,
          maxAttempts: MAX_UPSTREAM_ATTEMPTS,
          reason: "fetch_error",
          message: messageFor(error),
        });
        throw error;
      }
      await options.logger?.log("upstream_retry", {
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: MAX_UPSTREAM_ATTEMPTS,
        reason: "fetch_error",
        message: messageFor(error),
        delayMs: UPSTREAM_RETRY_DELAY_MS,
      });
    }
    await delay(UPSTREAM_RETRY_DELAY_MS);
  }
  throw lastError ?? new Error("Upstream request failed without a response");
}

function isRetryableUpstreamStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
