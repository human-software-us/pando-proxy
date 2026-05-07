import { ProxyConfig, resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import {
  type DropReason,
  type PieceDropBatchRequest,
  type PieceDropBatchResponse,
  type SourceChunkBatchRequest,
  type SourceChunkBatchResponse,
  type TaskRouteModelResponse,
  type TaskRouteRequest,
} from "./working_set_manager.ts";
import { extractJsonObject, stableJson } from "./json.ts";
import { loggableBody, redactHeaders } from "./logger.ts";
import { extractUsageMetrics, type UsageMetrics } from "./metrics.ts";

export type StructuredModelSelection = {
  classifier:
    | "task_route"
    | "source_chunk_batch"
    | "piece_drop_batch";
  requestModel: string | null;
  estimatedInputTokens: number;
  chosenModel: string;
  selectionReason: "fits_small_window" | "overflow_to_large" | "forced_source_chunk_full_model";
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
  fallback: "whole_chunk_batch";
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
  failureKind:
    | "http_error"
    | "no_output_text"
    | "invalid_json"
    | "validation_error"
    | "unexpected_error";
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
  requestBody?: unknown;
  responseBody?: unknown;
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
  taskRoute: (request: TaskRouteRequest, attempt?: number) => Promise<TaskRouteModelResponse>;
  sourceChunkBatch: (
    request: SourceChunkBatchRequest,
    attempt?: number,
  ) => Promise<SourceChunkBatchResponse>;
  pieceDropBatch: (
    request: PieceDropBatchRequest,
    attempt?: number,
  ) => Promise<PieceDropBatchResponse>;
  pruneBatchTokenLimit?: number;
  pruneSingleBatchTokenLimit?: number;
};

type PieceDropDecisionBody = {
  drop: boolean;
  reason: DropReason | null;
};

type PieceDropBatchWireResponse = {
  defaultDecision: PieceDropDecisionBody;
  overrides: Array<PieceDropDecisionBody & { pieceId: string }>;
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
      const result = await callStructuredJson<TaskRouteModelResponse>(
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
      try {
        assertValidTaskRouteResponse(result.value);
        return normalizeTaskRouteResponse(result.value);
      } catch (error) {
        await onError?.(validationFailureDiagnostics(
          result,
          request,
          result.value,
          messageFor(error),
        ));
        throw error;
      }
    },
    sourceChunkBatch: async (request, attempt = 1) => {
      const inputText = renderSourceChunkBatchInput(request);
      if (
        !canFitOverflowModelInputText(
          config,
          sourceChunkBatchSystemPrompt,
          inputText,
          sourceChunkBatchJsonSchema,
        )
      ) {
        await onSkipped?.({
          classifier: "source_chunk_batch",
          requestModel,
          estimatedInputTokens: estimateStructuredInputTextTokens(
            sourceChunkBatchSystemPrompt,
            inputText,
            sourceChunkBatchJsonSchema,
          ),
          reason: "exceeds_overflow_window",
          fallback: "whole_chunk_batch",
          sourceCount: request.sources.length,
        });
        return {
          results: request.sources.map((source) => ({
            sourceId: source.sourceId,
            chunks: [source.contentText],
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
        inputText,
      );
      await emitUsage(result, onUsage);
      try {
        assertValidSourceChunkBatchResponse(request, result.value);
        return normalizeSourceChunkBatchResponse(request, result.value);
      } catch (error) {
        await onError?.(validationFailureDiagnostics(
          result,
          request,
          result.value,
          messageFor(error),
        ));
        throw error;
      }
    },
    pieceDropBatch: async (request, attempt = 1) => {
      const schema = pieceDropBatchJsonSchema(request);
      const result = await callStructuredJson<PieceDropBatchWireResponse>(
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
      try {
        assertValidPieceDropBatchWireResponse(request, result.value);
        return normalizePieceDropBatchResponse(request, result.value);
      } catch (error) {
        await onError?.(validationFailureDiagnostics(
          result,
          request,
          result.value,
          messageFor(error),
        ));
        throw error;
      }
    },
    pruneBatchTokenLimit: Math.max(
      1,
      Math.floor((config.smallStructuredContextWindow - OUTPUT_TOKEN_RESERVE) * 0.7),
    ),
    pruneSingleBatchTokenLimit: Math.max(
      1,
      config.overflowStructuredContextWindow - OUTPUT_TOKEN_RESERVE,
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

function validationFailureDiagnostics<T>(
  result: StructuredJsonCallResult<T>,
  requestBody: unknown,
  responseBody: unknown,
  message: string,
): StructuredModelFailureDiagnostics {
  return {
    ...baseFailureDiagnostics(
      result.selection,
      result.attempt,
      result.durationMs,
      "validation_error",
      message,
    ),
    requestBody: loggableBody(requestBody),
    responseBody,
    usage: result.usage,
  };
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

function canFitOverflowModelInputText(
  config: ProxyConfig,
  system: string,
  inputText: string,
  schema: JsonSchema,
): boolean {
  return estimateStructuredInputTextTokens(system, inputText, schema) <=
    config.overflowStructuredContextWindow - OUTPUT_TOKEN_RESERVE;
}

export function estimateStructuredInputTokens(
  system: string,
  payload: unknown,
  schema: JsonSchema,
): number {
  return estimateStructuredInputTextTokens(system, stableJson(payload), schema);
}

function estimateStructuredInputTextTokens(
  system: string,
  inputText: string,
  schema: JsonSchema,
): number {
  return Math.ceil(
    (system.length + inputText.length + stableJson(schema).length) /
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
  inputTextOverride?: string,
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
    inputTextOverride,
  );
  await onSelection?.(selection);
  const url = responsesUrl(resolveUpstreamBaseUrl(config.upstreamBaseUrl, authHeader));
  const inputText = inputTextOverride ?? stableJson(payload);
  const requestBody = {
    model: selection.chosenModel,
    instructions: system,
    stream: true,
    store: false,
    ...structuredRequestOptions(selection),
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
      content: [{ type: "input_text", text: inputText }],
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
        requestBody: loggableBody(requestBody),
        responseBody: text,
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
        requestBody: loggableBody(requestBody),
        responseBody: bodyText,
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
        requestBody: loggableBody(requestBody),
        responseBody: bodyText,
      });
      throw new Error(message);
    }
    const usage = extractUsageMetricsFromStructuredResponse(response, bodyText);
    let value: T;
    try {
      value = extractJsonObject(text) as T;
    } catch (error) {
      const message = messageFor(error);
      errorLogged = true;
      await onError?.({
        ...baseFailureDiagnostics(selection, attempt, durationMs, "invalid_json", message),
        ...summarizeStructuredResponseBody(response, bodyText, parsedBody),
        usage,
        requestBody: loggableBody(requestBody),
        responseBody: bodyText,
      });
      throw error;
    }
    return {
      value,
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
        requestBody: loggableBody(requestBody),
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
  inputTextOverride?: string,
): StructuredModelSelection {
  const estimatedInputTokens = inputTextOverride === undefined
    ? estimateStructuredInputTokens(system, payload, schema)
    : estimateStructuredInputTextTokens(system, inputTextOverride, schema);
  if (classifier === "source_chunk_batch") {
    return {
      classifier,
      requestModel,
      estimatedInputTokens,
      chosenModel: config.overflowStructuredModel,
      selectionReason: "forced_source_chunk_full_model",
    };
  }
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

function structuredRequestOptions(
  selection: StructuredModelSelection,
): Record<string, unknown> {
  if (
    selection.classifier === "source_chunk_batch" &&
    supportsReasoningEffort(selection.chosenModel)
  ) {
    return {
      reasoning: { effort: "low" },
      service_tier: "priority",
    };
  }
  if (selection.classifier === "source_chunk_batch") {
    return { service_tier: "priority" };
  }
  return {};
}

function supportsReasoningEffort(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/.test(model);
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

function renderSourceChunkBatchInput(request: SourceChunkBatchRequest): string {
  const lines = [
    "Return verbatim chunks for these sources.",
    'For each source, return {"sourceId":"...","chunks":["exact source text chunk", "..."]}.',
    "Each chunk must be copied exactly from the raw source body.",
    "Chunking must be lossless: chunks joined together must exactly equal the raw source body.",
    "The delimiter newline after <raw_source_body> and before </raw_source_body> is not part of the raw source body unless the source itself begins or ends with a newline.",
    "Do not trim, normalize, delete, add, or rewrite whitespace or any other character.",
    "You may cut anywhere, including before or after whitespace.",
    "Do not return summaries, labels, markers, selectors, boundary text, or character offsets.",
    "If exact chunking is not clear, return the entire raw source body as one chunk.",
    "",
  ];
  for (const source of request.sources) {
    lines.push(
      `<source sourceId=${JSON.stringify(source.sourceId)} sourceKind=${
        JSON.stringify(source.sourceKind)
      }${
        source.toolName ? ` toolName=${JSON.stringify(source.toolName)}` : ""
      } length=${source.contentText.length}>`,
      "<raw_source_body>",
      source.contentText,
      "</raw_source_body>",
      "</source>",
      "",
    );
  }
  return lines.join("\n");
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const chunkSelectorSchema = {
  type: "string",
};

const taskRouteJsonSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["same_task", "new_task", "revive_task", "more_archived_tasks"] },
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
          chunks: { type: "array", items: chunkSelectorSchema },
        },
        required: ["sourceId", "chunks"],
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
- Return new_task only when the new turn clearly starts a standalone task that can be completed independently. Prior exact pieces may still be relevant and can be reused after routing.
- activePieces contains the full exact active working set. Use it, the active task title, and the full new user messages to decide continuity.
- archivedTasks contains at most five archived task cards, newest first. Use relativeIndex from that list, such as -1 for the most recent previous task, when returning revive_task.
- Return more_archived_tasks only when the user clearly asks to return to a prior task and none of the supplied archivedTasks matches, but archivePage.hasMore is true.
- Return revive_task only when the user clearly asks to return to a supplied prior task.
- Follow-up questions, refinements, debugging, verification, and requests about prior facts are same_task.
- For same_task, new_task, and more_archived_tasks, set relativeIndex to 0.
- Return JSON only.
`.trim();

const sourceChunkBatchSystemPrompt = `
You split non-user assistant talk/reasoning and tool-result payloads into exact retained pieces.

Return JSON matching the supplied schema.

Rules:
- Process all listed sources together.
- Do not summarize, paraphrase, or rewrite content.
- Return only verbatim chunks copied from the raw source body shown for that source.
- For each source, chunks joined together must exactly equal the complete raw source body.
- Never omit anything when chunking: every character must appear exactly once, in original order, including whitespace, blank lines, delimiters, wrappers, logs, prompts, errors, and headings.
- The newline immediately after <raw_source_body> and the newline immediately before </raw_source_body> are delimiter formatting, not source content, unless the source content itself begins or ends with a newline.
- Do not trim, normalize, delete, add, or rewrite whitespace or any other character.
- You may cut anywhere, including before or after whitespace.
- Keep chunks in original order.
- If you cannot split a source losslessly, return the entire raw source body as one chunk.
- Do not invent, rewrite, truncate, paraphrase, summarize, label, add markers, return selectors, return boundary text, or return character offsets.
- Prefer multiple coherent exact chunks over one huge chunk when the source is large and lossless splitting is clear.
- For large shell/search/test/log outputs, first split on conceptual boundaries: command sections, failure blocks, stack traces, assertion blocks, test-case sections, file blocks, path-prefix groups, or other visible separators.
- For 'rg --files ...' output, each line is a path. Prefer conceptual groups by top-level directory, package, namespace, or subsystem path, for example consecutive blocks for 'src/metabase/api/...', 'src/metabase/search/...', 'test/metabase/...', or 'enterprise/backend/...'. If no stable grouping is visible, return the entire raw source body as one chunk.
- For 'rg -n "..." ...' output, lines are usually 'path:line:match'. Prefer grouping consecutive matches by file path first, then by nearby match clusters. Keep complete match lines intact.
- For broad repository searches such as 'rg -n "namespace|module" /workspace ...', prefer groups by subsystem/path prefix, then by file.
- For grep/rg outputs with headers, context lines, or separators, keep each match block intact and keep nearby context with its match.
- Use contiguous regions around visible conceptual boundaries. Keep each line intact and keep related adjacent lines together.
- For large JSON arrays, split on complete top-level array entries or small groups of adjacent entries. Never split inside a JSON string, object, array, number, or literal.
- For large JSON objects with obvious top-level keys, split on complete top-level fields or small groups of adjacent fields when that is clear.
- For XML/HTML/Markdown-like content, split on complete top-level sections, fenced blocks, headings, or repeated element boundaries when clear.
- For code or diffs, split on complete files, hunks, top-level forms, declarations, or other syntax-visible boundaries when clear.
- When a source contains wrapper instructions around a clearly delimited exact block, snippet, template, or data payload, keep the wrappers too; split around the payload only if the complete source remains lossless.
- User messages are not sent to this classifier; local code always keeps each user message as one whole atomic piece.
- When the payload is delimited by clear markers such as fenced code blocks, BEGIN/END markers, XML-like tags, or repeated stanza boundaries, select the complete intended interior block instead of a partial prefix.
- Keep delimiter markers, wrapper text, and surrounding text exactly as written.
- When a clearly delimited block or stanza sequence is selected, include the full intended block boundaries. Do not truncate mid-line, mid-stanza, or mid-block.
- For structured JSON data, prefer complete fields/entries or one chunk containing the entire raw source body.
- For binary-like, base64-like, hex-dump-like, byte-array-like, image-metadata-like, or file-payload-like content, prefer one chunk containing the entire raw source body unless there is an obvious safe split. Never split mid-token or mid-byte-sequence.
- If splitting would be lossy or ambiguous, return the entire raw source body as one chunk; otherwise split large content so later pruning can keep useful regions without keeping the entire source.
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

function normalizeTaskRouteResponse(value: unknown): TaskRouteModelResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { kind: "same_task" };
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "new_task") {
    return { kind: "new_task" };
  }
  if (record.kind === "more_archived_tasks") {
    return { kind: "more_archived_tasks" };
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
  if (
    record.kind !== "same_task" &&
    record.kind !== "new_task" &&
    record.kind !== "revive_task" &&
    record.kind !== "more_archived_tasks"
  ) {
    throw new Error("task_route.kind is invalid");
  }
  if (typeof record.relativeIndex !== "number" || !Number.isInteger(record.relativeIndex)) {
    throw new Error("task_route.relativeIndex must be an integer");
  }
  if (
    (record.kind === "same_task" ||
      record.kind === "new_task" ||
      record.kind === "more_archived_tasks") && record.relativeIndex !== 0
  ) {
    throw new Error(
      "task_route.relativeIndex must be 0 for same_task/new_task/more_archived_tasks",
    );
  }
  if (record.kind === "revive_task" && record.relativeIndex >= 0) {
    throw new Error("task_route.relativeIndex must be negative for revive_task");
  }
}

function normalizePieceDropBatchResponse(
  request: PieceDropBatchRequest,
  value: PieceDropBatchWireResponse,
): PieceDropBatchResponse {
  const overridesById = new Map(value.overrides.map((override) => [override.pieceId, override]));

  return {
    decisions: request.evaluatedPieces.map((piece) => {
      const decision = overridesById.get(piece.id) ?? value.defaultDecision;
      return {
        pieceId: piece.id,
        drop: decision.drop,
        reason: decision.reason,
      };
    }),
  };
}

function assertValidPieceDropBatchWireResponse(
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
    if (!Array.isArray(item.chunks) || item.chunks.length === 0) {
      throw new Error(`${label}.chunks must be a non-empty array`);
    }
    const source = request.sources.find((candidate) => candidate.sourceId === item.sourceId);
    assertValidChunkList(item.chunks, `${label}.chunks`, source?.contentText ?? "");
  }
}

function assertValidChunkList(value: unknown[], label: string, sourceText: string): void {
  for (const [chunkIndex, chunk] of value.entries()) {
    if (typeof chunk !== "string") {
      throw new Error(`${label}[${chunkIndex}] must be a string`);
    }
  }
  if (value.join("") !== sourceText) {
    throw new Error(`${label} must join exactly to the source text`);
  }
}

function normalizeSourceChunkBatchResponse(
  request: SourceChunkBatchRequest,
  value: unknown,
): SourceChunkBatchResponse {
  const record = value as SourceChunkBatchResponse;
  const byId = new Map<string, string[]>();
  for (const entry of record.results) {
    byId.set(entry.sourceId, entry.chunks);
  }
  return {
    results: request.sources.map((source) => ({
      sourceId: source.sourceId,
      chunks: byId.get(source.sourceId) ?? [source.contentText],
    })),
  };
}
