import { ProxyConfig, resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import {
  type GroupIntentRequest,
  type GroupIntentResponse,
  type PieceRetentionBatchRequest,
  type PieceRetentionBatchResponse,
  type RetainedPiecePruneRequest,
  type RetainedPiecePruneResponse,
  type SourceChunkBatchRequest,
  type SourceChunkBatchResponse,
} from "./group_manager.ts";
import { extractJsonObject, stableJson } from "./json.ts";
import { loggableBody, redactHeaders } from "./logger.ts";
import { extractUsageMetrics, type UsageMetrics } from "./metrics.ts";
import { type ChunkSelector } from "./memory_state.ts";

export type StructuredModelSelection = {
  classifier:
    | "group_intent"
    | "source_chunk_batch"
    | "piece_retention_batch"
    | "retained_piece_prune";
  requestModel: string | null;
  estimatedInputTokens: number;
  chosenModel: string;
  selectionReason: "fits_small_window" | "overflow_to_large";
};

export type StructuredModelUsage = {
  classifier: StructuredModelSelection["classifier"];
  requestModel: string | null;
  chosenModel: string;
  estimatedInputTokens: number;
  selectionReason: StructuredModelSelection["selectionReason"];
  attempt: number;
  durationMs: number;
  inputTokens?: number;
  inputTokenDelta?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type StructuredModelSkipped = {
  classifier: StructuredModelSelection["classifier"];
  requestModel: string | null;
  estimatedInputTokens: number;
  reason: "exceeds_overflow_window";
  fallback: "whole_selector_batch";
  sourceCount: number;
};

export type StructuredModelFailureDiagnostics = {
  classifier: StructuredModelSelection["classifier"];
  requestModel: string | null;
  chosenModel: string;
  estimatedInputTokens: number;
  selectionReason: StructuredModelSelection["selectionReason"];
  attempt: number;
  durationMs: number;
  failureKind: "http_error" | "no_output_text" | "invalid_json" | "unexpected_error";
  responseStatus?: number;
  responseContentType?: string | null;
  bodyBytes?: number;
  bodyLooksLikeEventStream?: boolean;
  sseEventCount?: number;
  sseEventTypes?: string[];
  responseApiStatus?: string;
  responseIncompleteDetails?: unknown;
  responseError?: unknown;
  outputItemTypes?: string[];
  outputContentTypes?: string[];
  usage?: UsageMetrics | null;
  message: string;
};

export type StructuredModelWireLog = {
  classifier: StructuredModelSelection["classifier"];
  requestModel: string | null;
  chosenModel: string;
  estimatedInputTokens: number;
  selectionReason: StructuredModelSelection["selectionReason"];
  attempt: number;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseStatus?: number;
  responseStatusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: string;
  durationMs?: number;
};
export type StructuredClients = {
  groupIntent: (request: GroupIntentRequest, attempt?: number) => Promise<GroupIntentResponse>;
  sourceChunkBatch: (
    request: SourceChunkBatchRequest,
    attempt?: number,
  ) => Promise<SourceChunkBatchResponse>;
  pieceRetentionBatch: (
    request: PieceRetentionBatchRequest,
    attempt?: number,
  ) => Promise<PieceRetentionBatchResponse>;
  retainedPiecePrune: (
    request: RetainedPiecePruneRequest,
    attempt?: number,
  ) => Promise<RetainedPiecePruneResponse>;
};

const OUTPUT_TOKEN_RESERVE = 4_096;
const APPROX_CHARS_PER_TOKEN = 4;

type JsonSchema = Record<string, unknown>;

type StructuredJsonCallResult<T> = {
  value: T;
  usage: UsageMetrics | null;
  selection: StructuredModelSelection;
  attempt: number;
  durationMs: number;
};

export function createStructuredClients(
  config: ProxyConfig,
  requestModel: string | null,
  authHeader: string | null,
  onSelection?: (selection: StructuredModelSelection) => Promise<void> | void,
  onUsage?: (usage: StructuredModelUsage) => Promise<void> | void,
  onSkipped?: (skipped: StructuredModelSkipped) => Promise<void> | void,
  onError?: (diagnostics: StructuredModelFailureDiagnostics) => Promise<void> | void,
  onWireRequest?: (wire: StructuredModelWireLog) => Promise<void> | void,
  onWireResponse?: (wire: StructuredModelWireLog) => Promise<void> | void,
): StructuredClients {
  return {
    groupIntent: async (request, attempt = 1) => {
      const result = await callStructuredJson<GroupIntentResponse>(
        config,
        requestModel,
        authHeader,
        groupIntentSystemPrompt,
        request,
        groupIntentJsonSchema,
        "group_intent",
        attempt,
        onSelection,
        onError,
        onWireRequest,
        onWireResponse,
      );
      await emitUsage(result, onUsage);
      return result.value;
    },
    sourceChunkBatch: async (request, attempt = 1) => {
      if (
        !canFitOverflowModel(
          config,
          sourceChunkBatchSystemPrompt,
          request,
          sourceChunkBatchJsonSchema,
        )
      ) {
        await onSkipped?.({
          classifier: "source_chunk_batch",
          requestModel,
          estimatedInputTokens: estimateStructuredInputTokens(
            sourceChunkBatchSystemPrompt,
            request,
            sourceChunkBatchJsonSchema,
          ),
          reason: "exceeds_overflow_window",
          fallback: "whole_selector_batch",
          sourceCount: request.sources.length,
        });
        return {
          results: request.sources.map((source) => ({
            sourceId: source.sourceId,
            selectors: [{ kind: "whole" } satisfies ChunkSelector],
          })),
        };
      }
      const result = await callStructuredJson<SourceChunkBatchResponse>(
        config,
        requestModel,
        authHeader,
        sourceChunkBatchSystemPrompt,
        request,
        sourceChunkBatchJsonSchema,
        "source_chunk_batch",
        attempt,
        onSelection,
        onError,
        onWireRequest,
        onWireResponse,
      );
      await emitUsage(result, onUsage);
      return normalizeSourceChunkBatchResponse(request, result.value);
    },
    pieceRetentionBatch: async (request, attempt = 1) => {
      const schema = pieceRetentionBatchJsonSchema(request);
      const result = await callStructuredJson<PieceRetentionBatchResponse>(
        config,
        requestModel,
        authHeader,
        pieceRetentionBatchSystemPrompt,
        request,
        schema,
        "piece_retention_batch",
        attempt,
        onSelection,
        onError,
        onWireRequest,
        onWireResponse,
      );
      await emitUsage(result, onUsage);
      return normalizePieceRetentionBatchResponse(request, result.value);
    },
    retainedPiecePrune: async (request, attempt = 1) => {
      const result = await callStructuredJson<RetainedPiecePruneResponse>(
        config,
        requestModel,
        authHeader,
        retainedPiecePruneSystemPrompt,
        request,
        retainedPiecePruneJsonSchema,
        "retained_piece_prune",
        attempt,
        onSelection,
        onError,
        onWireRequest,
        onWireResponse,
      );
      await emitUsage(result, onUsage);
      return result.value;
    },
  };
}

async function emitUsage<T>(
  result: StructuredJsonCallResult<T>,
  onUsage?: (usage: StructuredModelUsage) => Promise<void> | void,
): Promise<void> {
  await onUsage?.({
    classifier: result.selection.classifier,
    requestModel: result.selection.requestModel,
    chosenModel: result.selection.chosenModel,
    estimatedInputTokens: result.selection.estimatedInputTokens,
    selectionReason: result.selection.selectionReason,
    attempt: result.attempt,
    durationMs: result.durationMs,
    inputTokens: result.usage?.inputTokens,
    inputTokenDelta: result.usage?.inputTokens !== undefined
      ? result.usage.inputTokens - result.selection.estimatedInputTokens
      : undefined,
    cachedInputTokens: result.usage?.cachedInputTokens,
    outputTokens: result.usage?.outputTokens,
    totalTokens: result.usage?.totalTokens,
  });
}

export function canFitOverflowModel(
  config: ProxyConfig,
  system: string,
  payload: unknown,
  schema: JsonSchema,
): boolean {
  return estimateStructuredInputTokens(system, payload, schema) <=
    config.overflowStructuredContextWindow - OUTPUT_TOKEN_RESERVE;
}

export function estimateStructuredInputTokens(
  system: string,
  payload: unknown,
  schema: JsonSchema,
): number {
  return Math.ceil(
    (system.length + stableJson(payload).length + stableJson(schema).length) /
      APPROX_CHARS_PER_TOKEN,
  );
}

async function callStructuredJson<T>(
  config: ProxyConfig,
  requestModel: string | null,
  authHeader: string | null,
  system: string,
  payload: unknown,
  schema: JsonSchema,
  classifier: StructuredModelSelection["classifier"],
  attempt: number,
  onSelection?: (selection: StructuredModelSelection) => Promise<void> | void,
  onError?: (diagnostics: StructuredModelFailureDiagnostics) => Promise<void> | void,
  onWireRequest?: (wire: StructuredModelWireLog) => Promise<void> | void,
  onWireResponse?: (wire: StructuredModelWireLog) => Promise<void> | void,
): Promise<StructuredJsonCallResult<T>> {
  if (!authHeader) {
    throw new Error(
      "No Authorization header or OPENAI_API_KEY available for structured model calls",
    );
  }

  const selection = chooseStructuredModel(
    config,
    requestModel,
    system,
    payload,
    schema,
    classifier,
  );
  await onSelection?.(selection);
  const url = responsesUrl(resolveUpstreamBaseUrl(config.upstreamBaseUrl, authHeader));
  const requestBody = {
    model: selection.chosenModel,
    instructions: system,
    stream: true,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: classifier,
        strict: true,
        schema,
      },
    },
    input: [{
      role: "user",
      content: [{ type: "input_text", text: stableJson(payload) }],
    }],
  };
  await onWireRequest?.({
    ...baseWireLog(selection, attempt, url),
    requestHeaders: {
      authorization: "[redacted]",
      "content-type": "application/json",
    },
    requestBody: loggableBody(requestBody),
  });
  const startedAt = performance.now();
  let errorLogged = false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "authorization": authHeader,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(config.modelTimeoutMs),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const durationMs = Math.round(performance.now() - startedAt);
      await onWireResponse?.({
        ...baseWireLog(selection, attempt, url),
        responseStatus: response.status,
        responseStatusText: response.statusText,
        responseHeaders: redactHeaders(response.headers),
        responseBody: text,
        durationMs,
      });
      const message = `Structured model call failed: ${response.status} ${text.slice(0, 500)}`;
      errorLogged = true;
      await onError?.({
        ...baseFailureDiagnostics(selection, attempt, durationMs, "http_error", message),
        responseStatus: response.status,
        responseContentType: response.headers.get("content-type"),
        bodyBytes: byteLength(text),
      });
      throw new Error(message);
    }

    const bodyText = await response.text();
    const durationMs = Math.round(performance.now() - startedAt);
    await onWireResponse?.({
      ...baseWireLog(selection, attempt, url),
      responseStatus: response.status,
      responseStatusText: response.statusText,
      responseHeaders: redactHeaders(response.headers),
      responseBody: bodyText,
      durationMs,
    });
    const bodyLooksLikeEventStream = isEventStream(response, bodyText);
    let parsedBody: unknown = null;
    let text = "";
    try {
      if (bodyLooksLikeEventStream) {
        text = extractResponseTextFromSseText(bodyText);
      } else {
        parsedBody = JSON.parse(bodyText);
        text = extractResponseText(parsedBody);
      }
    } catch (error) {
      const message = `Structured model response was not parseable JSON: ${messageFor(error)}`;
      errorLogged = true;
      await onError?.({
        ...baseFailureDiagnostics(selection, attempt, durationMs, "invalid_json", message),
        responseStatus: response.status,
        responseContentType: response.headers.get("content-type"),
        bodyBytes: byteLength(bodyText),
        bodyLooksLikeEventStream,
      });
      throw new Error(message);
    }
    if (!text) {
      const usage = extractUsageMetricsFromStructuredResponse(response, bodyText);
      const message = "Structured model response did not include text";
      errorLogged = true;
      await onError?.({
        ...baseFailureDiagnostics(selection, attempt, durationMs, "no_output_text", message),
        ...summarizeStructuredResponseBody(response, bodyText, parsedBody),
        usage,
      });
      throw new Error(message);
    }
    const usage = extractUsageMetricsFromStructuredResponse(response, bodyText);
    return {
      value: extractJsonObject(text) as T,
      usage,
      selection,
      attempt,
      durationMs,
    };
  } catch (error) {
    if (!errorLogged) {
      const message = messageFor(error);
      await onError?.({
        ...baseFailureDiagnostics(
          selection,
          attempt,
          Math.round(performance.now() - startedAt),
          "unexpected_error",
          message,
        ),
      });
    }
    throw error;
  }
}

function baseWireLog(
  selection: StructuredModelSelection,
  attempt: number,
  url: string,
): Omit<
  StructuredModelWireLog,
  | "requestHeaders"
  | "requestBody"
  | "responseStatus"
  | "responseStatusText"
  | "responseHeaders"
  | "responseBody"
  | "durationMs"
> {
  return {
    classifier: selection.classifier,
    requestModel: selection.requestModel,
    chosenModel: selection.chosenModel,
    estimatedInputTokens: selection.estimatedInputTokens,
    selectionReason: selection.selectionReason,
    attempt,
    url,
  };
}

function baseFailureDiagnostics(
  selection: StructuredModelSelection,
  attempt: number,
  durationMs: number,
  failureKind: StructuredModelFailureDiagnostics["failureKind"],
  message: string,
): Omit<
  StructuredModelFailureDiagnostics,
  | "responseStatus"
  | "responseContentType"
  | "bodyBytes"
  | "bodyLooksLikeEventStream"
  | "sseEventCount"
  | "sseEventTypes"
  | "responseApiStatus"
  | "responseIncompleteDetails"
  | "responseError"
  | "outputItemTypes"
  | "outputContentTypes"
  | "usage"
> {
  return {
    classifier: selection.classifier,
    requestModel: selection.requestModel,
    chosenModel: selection.chosenModel,
    estimatedInputTokens: selection.estimatedInputTokens,
    selectionReason: selection.selectionReason,
    attempt,
    durationMs,
    failureKind,
    message,
  };
}

export function summarizeStructuredResponseBody(
  response: Pick<Response, "headers" | "status">,
  bodyText: string,
  parsedBody: unknown = null,
): Pick<
  StructuredModelFailureDiagnostics,
  | "responseStatus"
  | "responseContentType"
  | "bodyBytes"
  | "bodyLooksLikeEventStream"
  | "sseEventCount"
  | "sseEventTypes"
  | "responseApiStatus"
  | "responseIncompleteDetails"
  | "responseError"
  | "outputItemTypes"
  | "outputContentTypes"
> {
  const bodyLooksLikeEventStream = isEventStream(response as Response, bodyText);
  const summary: Pick<
    StructuredModelFailureDiagnostics,
    | "responseStatus"
    | "responseContentType"
    | "bodyBytes"
    | "bodyLooksLikeEventStream"
    | "sseEventCount"
    | "sseEventTypes"
    | "responseApiStatus"
    | "responseIncompleteDetails"
    | "responseError"
    | "outputItemTypes"
    | "outputContentTypes"
  > = {
    responseStatus: response.status,
    responseContentType: response.headers.get("content-type"),
    bodyBytes: byteLength(bodyText),
    bodyLooksLikeEventStream,
  };

  if (bodyLooksLikeEventStream) {
    const events = parseSseJsonEvents(bodyText);
    summary.sseEventCount = events.length;
    summary.sseEventTypes = uniqueStrings(
      events.map((event) =>
        stringField(event, "type") ??
          stringField(objectField(event, "response"), "status") ??
          "unknown"
      ),
    ).slice(0, 25);
    const finalResponse = lastObject(
      events.map((event) => objectField(event, "response")).filter(Boolean),
    );
    if (finalResponse) {
      addResponseShape(summary, finalResponse);
    }
    return summary;
  }

  const body = parsedBody ?? safeParseJson(bodyText);
  if (body && typeof body === "object") {
    addResponseShape(summary, body as Record<string, unknown>);
  }
  return summary;
}

function chooseStructuredModel(
  config: ProxyConfig,
  requestModel: string | null,
  system: string,
  payload: unknown,
  schema: JsonSchema,
  classifier: StructuredModelSelection["classifier"],
): StructuredModelSelection {
  const estimatedInputTokens = estimateStructuredInputTokens(system, payload, schema);
  if (estimatedInputTokens <= config.smallStructuredContextWindow - OUTPUT_TOKEN_RESERVE) {
    return {
      classifier,
      requestModel,
      estimatedInputTokens,
      chosenModel: config.smallStructuredModel,
      selectionReason: "fits_small_window",
    };
  }
  return {
    classifier,
    requestModel,
    estimatedInputTokens,
    chosenModel: config.overflowStructuredModel,
    selectionReason: "overflow_to_large",
  };
}

function isEventStream(response: Response, body: string): boolean {
  const contentTypeIsEventStream =
    response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
  return contentTypeIsEventStream ||
    body.startsWith("event:") ||
    body.startsWith("data:") ||
    body.includes("\ndata:");
}

function extractResponseTextFromSseText(streamText: string): string {
  const deltas: string[] = [];
  let completedText = "";

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

    const finalText = extractResponseTextFromEvent(parsed);
    if (finalText) {
      completedText = finalText;
    }
    const delta = extractTextDelta(parsed);
    if (delta) {
      deltas.push(delta);
    }
  }

  return completedText || deltas.join("");
}

function extractUsageMetricsFromStructuredResponse(
  response: Response,
  bodyText: string,
): UsageMetrics | null {
  if (isEventStream(response, bodyText)) {
    return extractUsageMetricsFromSseText(bodyText);
  }
  try {
    return extractUsageMetrics(JSON.parse(bodyText));
  } catch {
    return null;
  }
}

function extractUsageMetricsFromSseText(streamText: string): UsageMetrics | null {
  let usage: UsageMetrics | null = null;

  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(data);
      usage = extractUsageMetrics(parsed) ?? extractUsageMetrics(
        parsed && typeof parsed === "object" && "response" in parsed
          ? (parsed as Record<string, unknown>).response
          : parsed,
      ) ?? usage;
    } catch {
      continue;
    }
  }

  return usage;
}

function parseSseJsonEvents(streamText: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    const parsed = safeParseJson(data);
    if (parsed && typeof parsed === "object") {
      events.push(parsed as Record<string, unknown>);
    }
  }
  return events;
}

function extractResponseTextFromEvent(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  return extractResponseText(record.response ?? value);
}

function extractTextDelta(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.delta === "string") {
    return record.delta;
  }
  if (typeof record.text === "string" && String(record.type ?? "").endsWith(".delta")) {
    return record.text;
  }
  return "";
}

function extractResponseText(value: unknown): string {
  if (
    value && typeof value === "object" &&
    typeof (value as Record<string, unknown>).output_text === "string"
  ) {
    return String((value as Record<string, unknown>).output_text);
  }
  const output = value && typeof value === "object"
    ? (value as Record<string, unknown>).output
    : undefined;
  if (!Array.isArray(output)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        parts.push(String((part as Record<string, unknown>).text));
      }
    }
  }
  return parts.join("\n");
}

function addResponseShape(
  summary: Pick<
    StructuredModelFailureDiagnostics,
    | "responseApiStatus"
    | "responseIncompleteDetails"
    | "responseError"
    | "outputItemTypes"
    | "outputContentTypes"
  >,
  response: Record<string, unknown>,
): void {
  summary.responseApiStatus = stringField(response, "status") ?? undefined;
  summary.responseIncompleteDetails = response.incomplete_details;
  summary.responseError = response.error;

  const output = response.output;
  if (!Array.isArray(output)) {
    return;
  }
  summary.outputItemTypes = uniqueStrings(
    output.map((item) => stringField(item, "type") ?? "unknown"),
  ).slice(0, 25);
  const contentTypes: string[] = [];
  for (const item of output) {
    const content = arrayField(item, "content");
    for (const part of content) {
      contentTypes.push(stringField(part, "type") ?? "unknown");
    }
  }
  summary.outputContentTypes = uniqueStrings(contentTypes).slice(0, 25);
}

function objectField(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? child as Record<string, unknown> : null;
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" ? child : null;
}

function arrayField(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child) ? child : [];
}

function lastObject(values: (Record<string, unknown> | null)[]): Record<string, unknown> | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index]) {
      return values[index];
    }
  }
  return null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const chunkSelectorSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["whole"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["text_spans"] },
        spans: {
          type: "array",
          items: {
            type: "object",
            properties: {
              start: { type: "integer", minimum: 0 },
              end: { type: "integer", minimum: 0 },
            },
            required: ["start", "end"],
            additionalProperties: false,
          },
        },
      },
      required: ["kind", "spans"],
      additionalProperties: false,
    },
  ],
};

const groupSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["active", "closed"] },
    routingLabel: { type: "string" },
    summary: { type: "string" },
    lastTouchedSeq: { type: "integer", minimum: 0 },
  },
  required: ["id", "status", "routingLabel", "summary", "lastTouchedSeq"],
  additionalProperties: false,
};

const groupIntentJsonSchema = {
  type: "object",
  properties: {
    groupsAfter: { type: "array", items: groupSchema },
    closedGroupIds: { type: "array", items: { type: "string" } },
    replacedGroupIds: { type: "array", items: { type: "string" } },
  },
  required: ["groupsAfter", "closedGroupIds", "replacedGroupIds"],
  additionalProperties: false,
};

const sourceChunkBatchJsonSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceId: { type: "string" },
          selectors: { type: "array", items: chunkSelectorSchema },
        },
        required: ["sourceId", "selectors"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

function pieceRetentionBatchJsonSchema(request: PieceRetentionBatchRequest): JsonSchema {
  const decisionSchema = {
    type: "object",
    properties: {
      keep: { type: "boolean" },
      groupId: {
        anyOf: [
          { type: "string" },
          { type: "null" },
        ],
      },
      supersedesPieceIds: { type: "array", items: { type: "string" } },
    },
    required: ["keep", "groupId", "supersedesPieceIds"],
    additionalProperties: false,
  };

  return {
    type: "object",
    properties: {
      decisionsByPieceId: {
        type: "object",
        properties: Object.fromEntries(
          request.newPieces.map((piece) => [piece.id, decisionSchema]),
        ),
        required: request.newPieces.map((piece) => piece.id),
        additionalProperties: false,
      },
    },
    required: ["decisionsByPieceId"],
    additionalProperties: false,
  };
}

const retainedPiecePruneJsonSchema = {
  type: "object",
  properties: {
    dropPieceIds: { type: "array", items: { type: "string" } },
  },
  required: ["dropPieceIds"],
  additionalProperties: false,
};

const groupIntentSystemPrompt = `
You maintain durable active memory groups for a coding session.

Return JSON matching the supplied schema.

Rules:
- You are given the current groups, retained exact anchor previews for those groups, and the new user pieces from the latest round.
- groupsAfter must be the full post-round group list.
- Keep groupsAfter small and concrete.
- Preserve active groups by default when their retained anchor facts may still matter later, even if the current round also asks for new inspection work.
- Do not discard an active group just because the user asks another repo-inspection question in the same broader thread.
- Continue an existing group when the user is still working on the same thread, including follow-up questions about facts, tokens, notes, or markers already established there.
- If the user updates or replaces an exact value inside the same ongoing thread (for example "forget token B, remember token C instead"), keep the same group id and update that group's summary rather than retiring the group and creating a fresh one.
- Use replacedGroupIds only when the broader thread itself is being abandoned in favor of a distinct new thread, not for ordinary within-thread value updates.
- Replace or close obsolete groups when the user moves on.
- closedGroupIds and replacedGroupIds retire prior groups and those ids must not appear in groupsAfter.
- routingLabel should be short and operational.
- summary should say what durable exact evidence matters in that group.
- summary should describe durable task state, not transient answer wording.
- summary must not include one-turn reply instructions, stale formatting requirements, obsolete answer text commands such as "reply STEP-4 only", or transient current-turn response-shape requests such as "return exact JSON only", requested key names, formatting wrappers, or output-slot templates when they do not add durable facts.
- Do not invent vague meta-groups.
- Return JSON only.
`.trim();

const sourceChunkBatchSystemPrompt = `
You split user, assistant, and tool payloads into exact retained pieces.

Return JSON matching the supplied schema.

Rules:
- Process all listed sources together.
- Do not summarize, paraphrase, or rewrite content.
- Return exact selectors only:
  - whole
  - text_spans using exact character offsets into the provided contentText
- Each text_spans selector may contain multiple ordered non-overlapping spans for one conceptual piece.
- Keep spans in original order.
- Do not invent or rewrite missing text. Select exact spans only.
- Prefer a few meaningful exact pieces over many tiny fragments.
- When a source contains wrapper instructions around a clearly delimited exact block, snippet, template, or data payload, select the payload block itself instead of the wrapper instructions.
- For user messages that say things like "remember this exact block" or "use this exact snippet", prefer text_spans covering the exact block/snippet/data and exclude transient wrapper lines such as "Reply X only" when the block boundaries are clear.
- When the payload is delimited by clear markers such as fenced code blocks, BEGIN/END markers, XML-like tags, or repeated stanza boundaries, select the complete intended interior block instead of a partial prefix.
- Exclude delimiter markers themselves when the user says they are wrapper text and not part of the exact retained content.
- When a clearly delimited block or stanza sequence is selected, include the full intended block boundaries. Do not truncate mid-line, mid-stanza, or mid-block.
- For structured JSON data, prefer whole objects or boundary-safe spans that keep complete fields/entries together.
- For binary-like, base64-like, hex-dump-like, byte-array-like, image-metadata-like, or file-payload-like content, prefer whole unless there is an obvious safe boundary. Never split mid-token or mid-byte-sequence.
- If splitting would be lossy or ambiguous, use whole.
- Return JSON only.
`.trim();

const pieceRetentionBatchSystemPrompt = `
You decide which exact new pieces should be retained in durable memory groups.

Return JSON matching the supplied schema.

Rules:
- You are given post-round groups, retained anchors, and preview/pointer/selector anchors for all new exact pieces.
- Return a decision for every new piece id under decisionsByPieceId.
- Keep only exact pieces that materially matter later.
- Prefer original user literals and original tool results over assistant restatements.
- Keep original raw sources when they may matter later for verbatim, byte-sensitive, spacing-sensitive, punctuation-sensitive, indentation-sensitive, or line-break-exact reproduction.
- Do not treat a group summary as a replacement for a canonical raw source when exact reproduction of the original text may matter later.
- Do not retain transient one-turn response-formatting instructions such as "reply X only", "answer UNKNOWN only", or "do not reveal it this round" unless they also contain durable facts that will matter later.
- Do not retain current-turn answer-shape requests that only specify how to format this response, such as exact JSON wrappers, requested output key names, placeholder templates, or "return X only" instructions, when the underlying durable evidence already exists elsewhere.
- Queries, questions, and answer-shape prompts with placeholders such as "...", "<...>", "<full ...>", or requested key names are not durable evidence and must keep=false unless they also introduce brand-new exact source material to remember.
- Example of keep=false: a piece whose only purpose is "Return exact JSON only: {\"a\":\"<...>\",\"c\":\"<...>\"}" or similar current-turn output-shape instructions.
- Also keep=false for a current-turn output template that embeds concrete values but is still only asking for this round's answer shape, for example "Return exact JSON only: {\"alpha_token\":\"ALPHA-7741\",\"beta_port\":9443}". That is not a new remembered source unless the user explicitly says to remember/store it.
- When a round contains both durable exact evidence and transient answer-formatting instructions, keep the durable evidence and drop the transient control chatter.
- groupId must be an active group when keep=true.
- When keep=false, set groupId to null and supersedesPieceIds to [].
- supersedesPieceIds should only list older retained pieces or earlier same-round new pieces made obsolete by the new piece.
- Never supersede older retained pieces with a query, question, or answer-shape request. Only supersede when the new piece itself contains replacement exact evidence that should now be remembered instead.
- Return JSON only.
`.trim();

function normalizePieceRetentionBatchResponse(
  request: PieceRetentionBatchRequest,
  value: unknown,
): PieceRetentionBatchResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { decisions: [] };
  }
  const record = value as Record<string, unknown>;
  const decisionsByPieceId = (
      record.decisionsByPieceId &&
      typeof record.decisionsByPieceId === "object" &&
      !Array.isArray(record.decisionsByPieceId)
    )
    ? record.decisionsByPieceId as Record<string, unknown>
    : {};

  return {
    decisions: request.newPieces.map((piece) => {
      const rawDecision = decisionsByPieceId[piece.id];
      const decision = rawDecision && typeof rawDecision === "object" && !Array.isArray(rawDecision)
        ? rawDecision as Record<string, unknown>
        : {};
      return {
        pieceId: piece.id,
        keep: decision.keep === true,
        groupId: typeof decision.groupId === "string" ? decision.groupId : null,
        supersedesPieceIds: Array.isArray(decision.supersedesPieceIds)
          ? decision.supersedesPieceIds.map(String)
          : [],
      };
    }),
  };
}

const retainedPiecePruneSystemPrompt = `
You prune kept exact pieces that are no longer worth sending next round.

Return JSON matching the supplied schema.

Rules:
- You are given the current groups, surviving old pieces, and newly kept pieces.
- dropPieceIds must be a subset of ids from retainedOldPieces only.
- Newly kept pieces are shown as context only; do not drop them in this call.
- Drop only old pieces that are clearly obsolete now.
- Prefer to keep earlier original user literals, tokens, constraints, and exact values when later rounds may still depend on them.
- Prefer to drop transient response-formatting, acknowledgment, or answer-shape pieces before dropping earlier durable exact evidence.
- Drop current-turn answer-shape requests such as exact JSON wrappers, requested output key names, placeholder templates, or "return X only" prompts before dropping durable exact evidence.
- Drop queries/questions whose only purpose is to ask for already-known values in a specific shape, especially when they contain placeholders like "...", "<...>", or "<full ...>".
- Drop current-turn output templates even when they embed concrete values, unless the user explicitly framed that template itself as new exact source material to remember later.
- Do not drop the only remaining canonical raw source for material that may need verbatim, byte-sensitive, spacing-sensitive, punctuation-sensitive, indentation-sensitive, or line-break-exact reproduction later.
- For formatting-sensitive blocks or snippets, prefer to keep the original raw source piece rather than relying on the group summary alone.
- If unsure, keep the old piece.
- Return JSON only.
`.trim();

function normalizeSourceChunkBatchResponse(
  request: SourceChunkBatchRequest,
  value: unknown,
): SourceChunkBatchResponse {
  if (!value || typeof value !== "object") {
    return defaultSourceChunkBatchResponse(request);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    return defaultSourceChunkBatchResponse(request);
  }
  const requestedIds = new Set(request.sources.map((source) => source.sourceId));
  const byId = new Map<string, SourceChunkBatchResponse["results"][number]["selectors"]>();
  for (const entry of record.results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const sourceId = typeof item.sourceId === "string" ? item.sourceId : "";
    if (!sourceId || !requestedIds.has(sourceId)) {
      continue;
    }
    const selectors = Array.isArray(item.selectors)
      ? item.selectors
        .map(coerceChunkSelector)
        .filter((
          selector,
        ): selector is SourceChunkBatchResponse["results"][number]["selectors"][number] =>
          Boolean(selector)
        )
      : [];
    byId.set(sourceId, selectors.length > 0 ? selectors : [{ kind: "whole" }]);
  }
  return {
    results: request.sources.map((source) => ({
      sourceId: source.sourceId,
      selectors: byId.get(source.sourceId) ?? [{ kind: "whole" }],
    })),
  };
}

function defaultSourceChunkBatchResponse(
  request: SourceChunkBatchRequest,
): SourceChunkBatchResponse {
  return {
    results: request.sources.map((source) => ({
      sourceId: source.sourceId,
      selectors: [{ kind: "whole" }],
    })),
  };
}

function coerceChunkSelector(
  value: unknown,
): SourceChunkBatchResponse["results"][number]["selectors"][number] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "whole") {
    return { kind: "whole" };
  }
  if (
    record.kind === "text_spans" &&
    Array.isArray(record.spans)
  ) {
    const spans = record.spans
      .filter((span): span is Record<string, unknown> =>
        Boolean(span) && typeof span === "object" && !Array.isArray(span)
      )
      .map((span) => ({
        start: typeof span.start === "number" ? Math.trunc(span.start) : -1,
        end: typeof span.end === "number" ? Math.trunc(span.end) : -1,
      }))
      .filter((span) => span.start >= 0 && span.end > span.start);
    return spans.length > 0 ? { kind: "text_spans", spans } : null;
  }
  return null;
}
