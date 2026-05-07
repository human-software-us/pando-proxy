import { ProxyConfig, resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import {
  type DropReason,
  type PieceDropBatchRequest,
  type PieceDropBatchResponse,
  type SourceChunkBatchRequest,
  type SourceChunkBatchResponse,
  type TaskRouteRequest,
  type TaskRouteResponse,
} from "./working_set_manager.ts";
import { extractJsonObject, stableJson } from "./json.ts";
import { loggableBody, redactHeaders } from "./logger.ts";
import { extractUsageMetrics, type UsageMetrics } from "./metrics.ts";
import { type ChunkSelector } from "./memory_state.ts";

export type StructuredModelSelection = {
  classifier:
    | "task_route"
    | "source_chunk_batch"
    | "piece_drop_batch";
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
  taskRoute: (request: TaskRouteRequest, attempt?: number) => Promise<TaskRouteResponse>;
  sourceChunkBatch: (
    request: SourceChunkBatchRequest,
    attempt?: number,
  ) => Promise<SourceChunkBatchResponse>;
  pieceDropBatch: (
    request: PieceDropBatchRequest,
    attempt?: number,
  ) => Promise<PieceDropBatchResponse>;
  pruneBatchTokenLimit?: number;
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
    taskRoute: async (request, attempt = 1) => {
      const result = await callStructuredJson<TaskRouteResponse>(
        config,
        requestModel,
        authHeader,
        taskRouteSystemPrompt,
        request,
        taskRouteJsonSchema,
        "task_route",
        attempt,
        onSelection,
        onError,
        onWireRequest,
        onWireResponse,
      );
      await emitUsage(result, onUsage);
      assertValidTaskRouteResponse(result.value);
      return normalizeTaskRouteResponse(result.value);
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
      assertValidSourceChunkBatchResponse(request, result.value);
      return normalizeSourceChunkBatchResponse(request, result.value);
    },
    pieceDropBatch: async (request, attempt = 1) => {
      const schema = pieceDropBatchJsonSchema(request);
      const result = await callStructuredJson<PieceDropBatchResponse>(
        config,
        requestModel,
        authHeader,
        pieceDropBatchSystemPrompt,
        request,
        schema,
        "piece_drop_batch",
        attempt,
        onSelection,
        onError,
        onWireRequest,
        onWireResponse,
      );
      await emitUsage(result, onUsage);
      assertValidPieceDropBatchResponse(request, result.value);
      return normalizePieceDropBatchResponse(request, result.value);
    },
    pruneBatchTokenLimit: Math.max(
      1,
      Math.floor((config.smallStructuredContextWindow - OUTPUT_TOKEN_RESERVE) * 0.7),
    ),
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

const taskRouteJsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["same_task", "new_task", "revive_task"] },
    relativeIndex: { type: "integer" },
  },
  required: ["kind", "relativeIndex"],
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

function pieceDropBatchJsonSchema(request: PieceDropBatchRequest): JsonSchema {
  const decisionSchema = pieceDropDecisionSchema();
  const overrideSchema = pieceDropOverrideSchema(
    request.evaluatedPieces.map((piece) => piece.id),
  );

  return {
    type: "object",
    properties: {
      defaultDecision: decisionSchema,
      overrides: {
        type: "array",
        items: overrideSchema,
      },
    },
    required: ["defaultDecision", "overrides"],
    additionalProperties: false,
  };
}

function pieceDropOverrideSchema(pieceIds: string[]): JsonSchema {
  const pieceIdSchema = { type: "string", enum: pieceIds };
  const reasonSchema = pieceDropReasonSchema();
  return {
    anyOf: [
      {
        type: "object",
        properties: {
          pieceId: pieceIdSchema,
          drop: { type: "boolean", enum: [false] },
          reason: { type: "null" },
        },
        required: ["pieceId", "drop", "reason"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          pieceId: pieceIdSchema,
          drop: { type: "boolean", enum: [true] },
          reason: reasonSchema,
        },
        required: ["pieceId", "drop", "reason"],
        additionalProperties: false,
      },
    ],
  };
}

function pieceDropDecisionSchema(): JsonSchema {
  const dropReasonSchema = pieceDropReasonSchema();
  return {
    anyOf: [
      {
        type: "object",
        properties: {
          drop: { type: "boolean", enum: [false] },
          reason: { type: "null" },
        },
        required: ["drop", "reason"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          drop: { type: "boolean", enum: [true] },
          reason: dropReasonSchema,
        },
        required: ["drop", "reason"],
        additionalProperties: false,
      },
    ],
  };
}

function pieceDropReasonSchema(): JsonSchema {
  return {
    type: "string",
    enum: [
      "exact_duplicate",
      "explicitly_invalidated_by_user",
      "old_task_after_confirmed_task_switch",
      "pure_ack_or_chatter",
      "transient_format_request_only",
      "clearly_unrelated_to_current_work",
      "empty_or_invalid",
    ],
  };
}

const taskRouteSystemPrompt = `
You decide whether a new user turn continues the current executable task, starts a new task, or revives a prior task.

Return JSON matching the supplied schema.

Rules:
- Return same_task unless the new user turn clearly starts a different standalone task.
- Return new_task only when the new turn can be completed independently and needs a different active working set.
- Return revive_task only when the user clearly asks to return to a prior task. Use relativeIndex from the supplied archivedTasks list, such as -1 for the most recent previous task.
- Follow-up questions, refinements, debugging, verification, and requests about prior facts are same_task.
- For same_task and new_task, set relativeIndex to 0.
- Return JSON only.
`.trim();

const sourceChunkBatchSystemPrompt = `
You split user, assistant talk/reasoning, and tool-result payloads into exact retained pieces.

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
- Prefer boundary-safe exact pieces over one huge whole selector when the source is large.
- For large shell/search/test/log outputs, first split on conceptual boundaries: command sections, failure blocks, stack traces, assertion blocks, test-case sections, file blocks, path-prefix groups, or other visible separators.
- For 'rg --files ...' output, each line is a path. Prefer conceptual groups by top-level directory, package, namespace, or subsystem path, for example consecutive blocks for 'src/metabase/api/...', 'src/metabase/search/...', 'test/metabase/...', or 'enterprise/backend/...'. Only fall back to bounded contiguous line ranges when no stable path grouping is visible.
- For 'rg -n "..." ...' output, lines are usually 'path:line:match'. Prefer grouping consecutive matches by file path first. For very large files, split by contiguous line-number ranges or nearby match clusters. Keep complete match lines intact.
- For broad repository searches such as 'rg -n "namespace|module" /workspace ...', prefer groups by subsystem/path prefix, then by file, then by contiguous line ranges.
- For grep/rg outputs with headers, context lines, or separators, keep each match block intact and keep nearby context with its match.
- Line/window splitting is the fallback: use size-bounded contiguous line ranges only after conceptual separators are not clear. Keep each line intact and keep related adjacent lines together.
- For large JSON arrays, split on complete top-level array entries or small groups of adjacent entries. Never split inside a JSON string, object, array, number, or literal.
- For large JSON objects with obvious top-level keys, split on complete top-level fields or small groups of adjacent fields when that is boundary-safe.
- For XML/HTML/Markdown-like content, split on complete top-level sections, fenced blocks, headings, or repeated element boundaries when clear.
- For code or diffs, split on complete files, hunks, top-level forms, declarations, or other syntax-visible boundaries when clear.
- When a source contains wrapper instructions around a clearly delimited exact block, snippet, template, or data payload, select the payload block itself instead of the wrapper instructions.
- For user messages that say things like "remember this exact block" or "use this exact snippet", prefer text_spans covering the exact block/snippet/data and exclude transient wrapper lines such as "Reply X only" when the block boundaries are clear.
- When the payload is delimited by clear markers such as fenced code blocks, BEGIN/END markers, XML-like tags, or repeated stanza boundaries, select the complete intended interior block instead of a partial prefix.
- Exclude delimiter markers themselves when the user says they are wrapper text and not part of the exact retained content.
- When a clearly delimited block or stanza sequence is selected, include the full intended block boundaries. Do not truncate mid-line, mid-stanza, or mid-block.
- For structured JSON data, prefer whole objects or boundary-safe spans that keep complete fields/entries together.
- For binary-like, base64-like, hex-dump-like, byte-array-like, image-metadata-like, or file-payload-like content, prefer whole unless there is an obvious safe boundary. Never split mid-token or mid-byte-sequence.
- If splitting would be lossy or ambiguous, use whole; otherwise split large content so later pruning can keep useful regions without keeping the entire source.
- Return JSON only.
`.trim();

const pieceDropBatchSystemPrompt = `
You decide which exact memory pieces no longer belong in the active working set for the current task.

Return JSON matching the supplied schema.

Rules:
- You are given a bounded full-payload batch plus shared context.
- Use defaultDecision for the common batch decision.
- Use overrides only for evaluatedPieces ids that differ from defaultDecision.
- To keep the whole batch, set defaultDecision={drop:false,reason:null} and overrides=[].
- To drop the whole batch, set defaultDecision={drop:true,reason:<allowed reason>} and overrides=[].
- You may only drop evaluatedPieces whose full contentText is present in this batch.
- Do not decide on manifest-only pieces.
- Nothing is protected forever, including user input, tool calls, tool results, errors, code, and assistant output.
- The question is only: does this exact piece still belong in the active working set for the current task?
- Drop pieces that are clearly unrelated, superseded, obsolete, transient, resolved, from an old task after a confirmed switch, or explicitly invalidated.
- Keep pieces when dropping them could remove information needed for the current task.
- If shared user context seems insufficient to judge a piece, keep it.
- If unsure, keep it.
- When drop=true, set a concrete allowed reason.
- When drop=false, set reason=null.
- Return JSON only.
`.trim();

function normalizeTaskRouteResponse(value: unknown): TaskRouteResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "same_task" };
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "new_task") {
    return { kind: "new_task" };
  }
  if (record.kind === "revive_task") {
    const relativeIndex = typeof record.relativeIndex === "number"
      ? Math.trunc(record.relativeIndex)
      : -1;
    return relativeIndex < 0 ? { kind: "revive_task", relativeIndex } : { kind: "same_task" };
  }
  return { kind: "same_task" };
}

function assertValidTaskRouteResponse(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("task_route response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "same_task" && record.kind !== "new_task" && record.kind !== "revive_task") {
    throw new Error("task_route.kind is invalid");
  }
  if (typeof record.relativeIndex !== "number" || !Number.isInteger(record.relativeIndex)) {
    throw new Error("task_route.relativeIndex must be an integer");
  }
  if ((record.kind === "same_task" || record.kind === "new_task") && record.relativeIndex !== 0) {
    throw new Error("task_route.relativeIndex must be 0 for same_task/new_task");
  }
  if (record.kind === "revive_task" && record.relativeIndex >= 0) {
    throw new Error("task_route.relativeIndex must be negative for revive_task");
  }
}

function normalizePieceDropBatchResponse(
  request: PieceDropBatchRequest,
  value: unknown,
): PieceDropBatchResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      decisions: request.evaluatedPieces.map((piece) => ({
        pieceId: piece.id,
        drop: false,
        reason: null,
      })),
    };
  }
  const record = value as Record<string, unknown>;
  const defaultDecision = decisionObject(record.defaultDecision);
  const overrides = Array.isArray(record.overrides)
    ? record.overrides.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
    )
    : [];
  const overridesById = new Map<string, Record<string, unknown>>();
  for (const override of overrides) {
    if (typeof override.pieceId === "string") {
      overridesById.set(override.pieceId, override);
    }
  }

  return {
    decisions: request.evaluatedPieces.map((piece) => {
      const decision = overridesById.get(piece.id) ?? defaultDecision;
      return {
        pieceId: piece.id,
        drop: decision.drop === true,
        reason: coerceDropReason(decision.reason),
      };
    }),
  };
}

function assertValidPieceDropBatchResponse(
  request: PieceDropBatchRequest,
  value: unknown,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("piece_drop_batch response must be an object");
  }
  const record = value as Record<string, unknown>;
  assertValidPieceDropDecision(record.defaultDecision, "piece_drop_batch.defaultDecision");
  if (!Array.isArray(record.overrides)) {
    throw new Error("piece_drop_batch.overrides must be an array");
  }
  const evaluatedIds = new Set(request.evaluatedPieces.map((piece) => piece.id));
  const seen = new Set<string>();
  for (const [index, override] of record.overrides.entries()) {
    const label = `piece_drop_batch.overrides[${index}]`;
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      throw new Error(`${label} must be an object`);
    }
    const item = override as Record<string, unknown>;
    if (typeof item.pieceId !== "string" || !evaluatedIds.has(item.pieceId)) {
      throw new Error(`${label}.pieceId must reference an evaluated piece`);
    }
    if (seen.has(item.pieceId)) {
      throw new Error(`${label}.pieceId is duplicated`);
    }
    seen.add(item.pieceId);
    assertValidPieceDropDecision(item, label);
  }
}

function assertValidPieceDropDecision(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.drop !== "boolean") {
    throw new Error(`${label}.drop must be a boolean`);
  }
  if (record.drop === true) {
    if (coerceDropReason(record.reason) === null) {
      throw new Error(`${label}.reason must be an accepted reason when drop=true`);
    }
    return;
  }
  if (record.reason !== null) {
    throw new Error(`${label}.reason must be null when drop=false`);
  }
}

function decisionObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function coerceDropReason(value: unknown): DropReason | null {
  return typeof value === "string" && (
      value === "exact_duplicate" ||
      value === "explicitly_invalidated_by_user" ||
      value === "old_task_after_confirmed_task_switch" ||
      value === "pure_ack_or_chatter" ||
      value === "transient_format_request_only" ||
      value === "clearly_unrelated_to_current_work" ||
      value === "empty_or_invalid"
    )
    ? value
    : null;
}

function assertValidSourceChunkBatchResponse(
  request: SourceChunkBatchRequest,
  value: unknown,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("source_chunk_batch response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    throw new Error("source_chunk_batch.results must be an array");
  }
  const requestedIds = new Set(request.sources.map((source) => source.sourceId));
  const seen = new Set<string>();
  for (const [index, result] of record.results.entries()) {
    const label = `source_chunk_batch.results[${index}]`;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`${label} must be an object`);
    }
    const item = result as Record<string, unknown>;
    if (typeof item.sourceId !== "string" || !requestedIds.has(item.sourceId)) {
      throw new Error(`${label}.sourceId must reference a requested source`);
    }
    if (seen.has(item.sourceId)) {
      throw new Error(`${label}.sourceId is duplicated`);
    }
    seen.add(item.sourceId);
    if (!Array.isArray(item.selectors) || item.selectors.length === 0) {
      throw new Error(`${label}.selectors must be a non-empty array`);
    }
    for (const [selectorIndex, selector] of item.selectors.entries()) {
      assertValidChunkSelector(selector, `${label}.selectors[${selectorIndex}]`);
    }
  }
}

function assertValidChunkSelector(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "whole") {
    return;
  }
  if (record.kind !== "text_spans") {
    throw new Error(`${label}.kind is invalid`);
  }
  if (!Array.isArray(record.spans) || record.spans.length === 0) {
    throw new Error(`${label}.spans must be a non-empty array`);
  }
  for (const [spanIndex, span] of record.spans.entries()) {
    if (!span || typeof span !== "object" || Array.isArray(span)) {
      throw new Error(`${label}.spans[${spanIndex}] must be an object`);
    }
    const item = span as Record<string, unknown>;
    if (
      typeof item.start !== "number" || !Number.isInteger(item.start) || item.start < 0 ||
      typeof item.end !== "number" || !Number.isInteger(item.end) || item.end <= item.start
    ) {
      throw new Error(`${label}.spans[${spanIndex}] must have integer start/end with end > start`);
    }
  }
}

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
