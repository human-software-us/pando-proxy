import { ProxyConfig, resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import { loggableBody, ProxyLogger, redactHeaders } from "./logger.ts";
import {
  estimateTokensForText,
  extractUsageMetricsFromResponseText,
  METRICS_EVENT_PREFIX,
  METRICS_MARKER,
  UsageMetrics,
  UsageTotals,
} from "./metrics.ts";

export type UpstreamOptions = {
  authHeader: string | null;
  body: Record<string, unknown>;
  logger?: ProxyLogger;
  metrics?: UpstreamMetricsOptions;
};

export type UpstreamMetricsOptions = {
  sessionKey: string;
  requestId: string;
  approxInputTokens: number;
  onUsage?: (usage: UsageMetrics) => UsageTotals;
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

  return new Response(logResponseStream(upstream.body, options.logger, options.metrics), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function logResponseStream(
  body: ReadableStream<Uint8Array> | null,
  logger: ProxyLogger | undefined,
  metrics: UpstreamMetricsOptions | undefined,
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
        await logUpstreamMetrics(logger, metrics, bodyParts.join(""), totalBytes, "end");
      },
      async cancel(reason) {
        await logger.log("upstream_response_cancel", {
          totalBytes,
          reason: reason instanceof Error ? reason.message : String(reason ?? ""),
        });
        await logUpstreamMetrics(logger, metrics, bodyParts.join(""), totalBytes, "cancel");
      },
    }),
  );
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
