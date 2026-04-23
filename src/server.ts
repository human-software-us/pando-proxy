import { authHeaderFor, parseJsonBody, requestModel, sessionKeyFor } from "./codex_request.ts";
import { ProxyConfig } from "./config.ts";
import { createLogger, loggableBody, redactHeaders } from "./logger.ts";
import { runMaintenancePass } from "./memory_pipeline.ts";
import {
  estimateTokensForValue,
  memoryStateMetrics,
  METRICS_EVENT_PREFIX,
  METRICS_MARKER,
  requestContextMetrics,
  TokenUsageTracker,
} from "./metrics.ts";
import { rewriteRequestWithMemory } from "./prompt_view.ts";
import { SessionStore } from "./store.ts";
import { forwardResponsesRequest } from "./upstream.ts";

export function createHandler(config: ProxyConfig, store = new SessionStore(config.stateDir)) {
  const logger = createLogger(config.logFile);
  const usageTracker = new TokenUsageTracker();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
      return jsonResponse({ ok: true, service: "pando-proxy" });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      return jsonResponse({ error: "not_found" }, 404);
    }

    let body: Record<string, unknown>;
    try {
      body = await parseJsonBody(request);
    } catch (error) {
      return jsonResponse({ error: "invalid_json", message: messageFor(error) }, 400);
    }

    const authHeader = authHeaderFor(request, config.apiKey);
    const sessionKey = await sessionKeyFor(request, body);
    const requestId = crypto.randomUUID();
    await logger.log("incoming_request", {
      requestId,
      sessionKey,
      method: request.method,
      path: url.pathname,
      headers: redactHeaders(request.headers),
      body: loggableBody(body),
      memoryEnabled: config.memoryEnabled,
    });
    await logger.log(`${METRICS_EVENT_PREFIX}incoming_context`, {
      marker: METRICS_MARKER,
      requestId,
      sessionKey,
      memoryEnabled: config.memoryEnabled,
      ...requestContextMetrics(body),
    });
    if (!config.memoryEnabled) {
      try {
        return await forwardResponsesRequest(config, {
          authHeader,
          body,
          logger,
          metrics: upstreamMetricsOptions(sessionKey, requestId, body, usageTracker),
        });
      } catch (error) {
        return jsonResponse(
          {
            error: "pando_proxy_failed",
            message: messageFor(error),
          },
          502,
        );
      }
    }

    try {
      const rewritten = await store.withLock(sessionKey, async () => {
        const record = await store.load(sessionKey);
        const result = await runMaintenancePass(
          body,
          record,
          config,
          authHeader,
          requestModel(body),
          { logger, sessionKey },
        );
        if (result.changed) {
          await store.save(sessionKey, result.record);
          await logger.log("memory_state_saved", {
            requestId,
            sessionKey,
            taskUpdateSeq: result.record.memory.taskUpdateSeq,
            taskIds: result.record.memory.tasks.map((task) => task.id),
            keptUserMessageIds: result.record.memory.keptUserMessages.map((message) =>
              message.messageId
            ),
            memoryChunkIds: result.record.memory.memoryLibrary.map((chunk) => chunk.id),
            handledInputIds: result.record.handledInputIds,
          });
        } else {
          await logger.log("memory_state_unchanged", {
            requestId,
            sessionKey,
            taskUpdateSeq: result.record.memory.taskUpdateSeq,
            handledInputIds: result.record.handledInputIds,
          });
        }
        await logger.log(`${METRICS_EVENT_PREFIX}memory_state`, {
          marker: METRICS_MARKER,
          requestId,
          sessionKey,
          changed: result.changed,
          ...memoryStateMetrics(result.record.memory, result.record.handledInputIds),
        });
        const rewritten = rewriteRequestWithMemory(
          body,
          result.record.memory,
          config.syntheticCharBudget,
        );
        await logger.log(`${METRICS_EVENT_PREFIX}rewritten_context`, {
          marker: METRICS_MARKER,
          requestId,
          sessionKey,
          rawApproxInputTokens: estimateTokensForValue(body),
          rewrittenApproxInputTokens: estimateTokensForValue(rewritten),
          approxInputTokenDelta: estimateTokensForValue(rewritten) - estimateTokensForValue(body),
          rawInputItemCount: Array.isArray(body.input) ? body.input.length : undefined,
          rewrittenInputItemCount: Array.isArray(rewritten.input)
            ? rewritten.input.length
            : undefined,
          ...requestContextMetrics(rewritten),
        });
        return rewritten;
      });

      return await forwardResponsesRequest(config, {
        authHeader,
        body: rewritten,
        logger,
        metrics: upstreamMetricsOptions(sessionKey, requestId, rewritten, usageTracker),
      });
    } catch (error) {
      return jsonResponse(
        {
          error: "pando_proxy_failed",
          message: messageFor(error),
        },
        502,
      );
    }
  };
}

function upstreamMetricsOptions(
  sessionKey: string,
  requestId: string,
  body: Record<string, unknown>,
  usageTracker: TokenUsageTracker,
) {
  return {
    sessionKey,
    requestId,
    approxInputTokens: estimateTokensForValue(body),
    onUsage: (usage: Parameters<TokenUsageTracker["add"]>[1]) =>
      usageTracker.add(sessionKey, usage),
  };
}

export function startServer(config: ProxyConfig): Deno.HttpServer {
  const handler = createHandler(config);
  return Deno.serve({
    hostname: config.host,
    port: config.port,
    onListen: () => {},
  }, handler);
}

export async function serve(config: ProxyConfig): Promise<void> {
  const server = startServer(config);
  console.log(`Pando Proxy is running at http://${config.host}:${config.port}/v1`);
  console.log("Leave this terminal open while using Codex.");
  await server.finished;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
