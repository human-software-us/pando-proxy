import { ProxyConfig, resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import { loggableBody, ProxyLogger, redactHeaders } from "./logger.ts";
import { isRecord } from "./memory_state.ts";
import {
  estimateTokensForText,
  extractUsageMetricsFromResponseText,
  METRICS_EVENT_PREFIX,
  METRICS_MARKER,
  UsageMetrics,
  UsageTotals,
} from "./metrics.ts";
import { AssistantResponseExtraction, inputItemId } from "./tool_results.ts";

export type UpstreamOptions = {
  authHeader: string | null;
  body: Record<string, unknown>;
  logger?: ProxyLogger;
  metrics?: UpstreamMetricsOptions;
  onCompletion?: (completion: UpstreamCompletion) => Promise<void> | void;
};

export type UpstreamMetricsOptions = {
  sessionKey: string;
  requestId: string;
  approxInputTokens: number;
  onUsage?: (usage: UsageMetrics) => UsageTotals;
};

export type UpstreamCompletion = {
  termination: "end" | "cancel";
  bodyText: string;
  totalBytes: number;
};

export async function forwardResponsesRequest(
  config: ProxyConfig,
  options: UpstreamOptions,
): Promise<Response> {
  const headers = new Headers({
    "content-type": "application/json",
  });
  if (options.authHeader) {
    headers.set("authorization", options.authHeader);
  }

  const upstreamBaseUrl = resolveUpstreamBaseUrl(config.upstreamBaseUrl, options.authHeader);
  const url = responsesUrl(upstreamBaseUrl);
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

  await options.logger?.log("upstream_response_start", {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: redactHeaders(upstream.headers),
  });

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (hopByHopHeaders.has(key.toLowerCase())) {
      continue;
    }
    responseHeaders.set(key, value);
  }
  if (!responseHeaders.has("content-type")) {
    responseHeaders.set("content-type", "application/json");
  }

  return new Response(
    logResponseStream(
      upstream.body,
      options.logger,
      options.metrics,
      upstream.ok ? options.onCompletion : undefined,
    ),
    {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
    },
  );
}

function logResponseStream(
  body: ReadableStream<Uint8Array> | null,
  logger: ProxyLogger | undefined,
  metrics: UpstreamMetricsOptions | undefined,
  onCompletion: ((completion: UpstreamCompletion) => Promise<void> | void) | undefined,
): ReadableStream<Uint8Array> | null {
  if (!body || !logger) {
    return body;
  }

  const decoder = new TextDecoder();
  let totalBytes = 0;
  const bodyParts: string[] = [];
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        totalBytes += chunk.byteLength;
        const text = decoder.decode(chunk, { stream: true });
        bodyParts.push(text);
        await logger.log("upstream_response_chunk", {
          bytes: chunk.byteLength,
          text,
        });
        controller.enqueue(chunk);
      },
      async flush() {
        const remainder = decoder.decode();
        if (remainder.length > 0) {
          bodyParts.push(remainder);
          await logger.log("upstream_response_chunk", {
            bytes: 0,
            text: remainder,
          });
        }
        await logger.log("upstream_response_end", { totalBytes });
        const bodyText = bodyParts.join("");
        await logUpstreamMetrics(logger, metrics, bodyText, totalBytes, "end");
        await runCompletionHook(logger, onCompletion, {
          termination: "end",
          bodyText,
          totalBytes,
        });
      },
      async cancel(reason) {
        await logger.log("upstream_response_cancel", {
          totalBytes,
          reason: reason instanceof Error ? reason.message : String(reason ?? ""),
        });
        const bodyText = bodyParts.join("");
        await logUpstreamMetrics(logger, metrics, bodyText, totalBytes, "cancel");
        await runCompletionHook(logger, onCompletion, {
          termination: "cancel",
          bodyText,
          totalBytes,
        });
      },
    }),
  );
}

async function runCompletionHook(
  logger: ProxyLogger | undefined,
  onCompletion: ((completion: UpstreamCompletion) => Promise<void> | void) | undefined,
  completion: UpstreamCompletion,
): Promise<void> {
  if (!onCompletion) {
    return;
  }
  try {
    await onCompletion(completion);
  } catch (error) {
    await logger?.log("upstream_completion_error", {
      termination: completion.termination,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function logUpstreamMetrics(
  logger: ProxyLogger,
  metrics: UpstreamMetricsOptions | undefined,
  bodyText: string,
  totalBytes: number,
  termination: "end" | "cancel",
): Promise<void> {
  if (!metrics) {
    return;
  }
  const usage = extractUsageMetricsFromResponseText(bodyText);
  const cumulativeUsage = usage && metrics.onUsage ? metrics.onUsage(usage) : undefined;
  await logger.log(`${METRICS_EVENT_PREFIX}upstream_response`, {
    marker: METRICS_MARKER,
    requestId: metrics.requestId,
    sessionKey: metrics.sessionKey,
    termination,
    totalBytes,
    approxInputTokens: metrics.approxInputTokens,
    approxOutputTokens: estimateTokensForText(bodyText),
    actualUsageAvailable: Boolean(usage),
    actualUsage: usage?.raw,
    actualInputTokens: usage?.inputTokens,
    actualOutputTokens: usage?.outputTokens,
    actualTotalTokens: usage?.totalTokens,
    cumulativeUsage,
  });
}

export async function extractAssistantResponsesFromResponseText(
  streamText: string,
  baseInputItemCount = 0,
): Promise<AssistantResponseExtraction[]> {
  const normalizedOutputItems = parseResponseOutputItemsForRawInput(streamText);
  const assistantResponses: AssistantResponseExtraction[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < normalizedOutputItems.length; index += 1) {
    const item = normalizedOutputItems[index];
    if (!isRecord(item) || item.type !== "message" || item.role !== "assistant") {
      continue;
    }
    const text = extractAssistantMessageText(item);
    if (!text.trim()) {
      continue;
    }
    const responseId = await inputItemId("assistant", baseInputItemCount + index, item);
    if (seen.has(responseId)) {
      continue;
    }
    seen.add(responseId);
    assistantResponses.push({ responseId, text });
  }

  return assistantResponses;
}

function parseResponseOutputItemsForRawInput(streamText: string): unknown[] {
  const items: Array<{ outputIndex: number; sequence: number; item: unknown }> = [];

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
    if (!isRecord(parsed) || parsed.type !== "response.output_item.done" || !isRecord(parsed.item)) {
      continue;
    }
    const normalized = normalizeResponseOutputItem(parsed.item);
    if (!normalized) {
      continue;
    }
    items.push({
      outputIndex: typeof parsed.output_index === "number" ? parsed.output_index : items.length,
      sequence: typeof parsed.sequence_number === "number" ? parsed.sequence_number : items.length,
      item: normalized,
    });
  }

  items.sort((a, b) => a.outputIndex - b.outputIndex || a.sequence - b.sequence);
  return items.map((entry) => entry.item);
}

function normalizeResponseOutputItem(item: Record<string, unknown>): Record<string, unknown> | null {
  const type = String(item.type ?? "");
  if (type === "message" && item.role === "assistant") {
    const content = normalizeAssistantContent(item.content);
    if (content.length === 0) {
      return null;
    }
    return {
      type: "message",
      role: "assistant",
      content,
      ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
    };
  }

  if (type === "function_call") {
    return {
      type: "function_call",
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.arguments === "string" ? { arguments: item.arguments } : {}),
      ...(typeof item.call_id === "string" ? { call_id: item.call_id } : {}),
    };
  }

  if (type === "mcp_tool_call") {
    return {
      type: "mcp_tool_call",
      ...(typeof item.server_label === "string" ? { server_label: item.server_label } : {}),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.arguments === "string" ? { arguments: item.arguments } : {}),
      ...(typeof item.call_id === "string" ? { call_id: item.call_id } : {}),
    };
  }

  if (type === "custom_tool_call") {
    return {
      type: "custom_tool_call",
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(typeof item.arguments === "string" ? { arguments: item.arguments } : {}),
      ...(typeof item.call_id === "string" ? { call_id: item.call_id } : {}),
    };
  }

  if (type === "reasoning") {
    return {
      type: "reasoning",
      summary: Array.isArray(item.summary) ? item.summary : [],
      content: item.content ?? null,
      encrypted_content: item.encrypted_content ?? null,
    };
  }

  return null;
}

function normalizeAssistantContent(content: unknown): Array<{ type: string; text: string }> {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter(isRecord)
    .filter((part) => typeof part.text === "string")
    .map((part) => ({
      type: typeof part.type === "string" ? part.type : "output_text",
      text: String(part.text),
    }));
}

function extractAssistantMessageText(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (isRecord(part) && typeof part.text === "string") {
      parts.push(String(part.text));
    }
  }
  return parts.join("\n");
}

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
