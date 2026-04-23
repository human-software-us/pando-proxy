import type { ProxyConfig } from "./config.ts";
import { authHeaderFor, parseJsonBody, requestModel, sessionKeyFor } from "./codex_request.ts";
import { createLogger } from "./logger.ts";
import { updateMemoryForCompletedRound } from "./memory_pipeline.ts";
import { extractUsageMetrics, memoryStateMetrics, requestContextMetrics, TokenUsageTracker } from "./metrics.ts";
import { rewriteRequestWithMemory } from "./prompt_view.ts";
import { createStructuredClients } from "./structured_model.ts";
import { SessionStore } from "./store.ts";
import { forwardResponsesRequest, runResponsesLoop } from "./upstream.ts";

export function createHandler(
  config: ProxyConfig,
  store = new SessionStore(config.stateDir, config.inlinePieceByteLimit),
) {
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
      memoryEnabled: config.memoryEnabled,
      ...requestContextMetrics(body),
    });

    if (!config.memoryEnabled) {
      try {
        return await forwardResponsesRequest(config, { authHeader, body, logger });
      } catch (error) {
        return jsonResponse({ error: "pando_proxy_failed", message: messageFor(error) }, 502);
      }
    }

    try {
      return await store.withLock(sessionKey, async () => {
        const record = await store.load(sessionKey);
        let finalMemory = record.memory;
        let memoryUpdateError: string | null = null;
        const rewrite = await rewriteRequestWithMemory(body, record.memory, config);
        await logger.log("rewritten_context", {
          requestId,
          sessionKey,
          droppedInputIds: rewrite.diff.droppedInputIds,
          keptInputIds: rewrite.diff.keptInputIds,
          insertedTaskCount: rewrite.diff.insertedTaskCount,
          indexedPieceCount: rewrite.diff.indexedPieceCount,
          ...requestContextMetrics(rewrite.body),
        });

        const loop = await runResponsesLoop(
          config,
          { authHeader, body: rewrite.body, logger },
          store,
          sessionKey,
          record.memory,
        );
        if (!loop.ok) {
          return loop.response;
        }

        try {
          const structuredClients = createStructuredClients(
            config,
            requestModel(body),
            authHeader,
            (selection) =>
              logger.log("structured_model_selected", {
                requestId,
                sessionKey,
                ...selection,
              }),
          );
          const memoryUpdate = await updateMemoryForCompletedRound(
            body,
            record.memory,
            loop.finalBody,
            loop.assistantSources,
            structuredClients,
            config,
            { logger, requestId, sessionKey },
          );
          finalMemory = memoryUpdate.memory;
          if (memoryUpdate.changed) {
            await store.save(sessionKey, { memory: memoryUpdate.memory });
            await logger.log("memory_state_saved", {
              requestId,
              sessionKey,
              newPieceIds: memoryUpdate.newPieceIds,
              droppedPieceIds: memoryUpdate.droppedPieceIds,
              ...memoryStateMetrics(memoryUpdate.memory),
            });
          }
        } catch (error) {
          memoryUpdateError = messageFor(error);
          await logger.log("memory_update_failed", {
            requestId,
            sessionKey,
            message: memoryUpdateError,
          });
        }

        const usage = extractUsageMetrics(loop.finalBody);
        const usageTotals = usage ? usageTracker.add(sessionKey, usage) : null;
        if (usage) {
          await logger.log("usage", {
            requestId,
            sessionKey,
            ...usageTotals,
          });
        }
        await logger.log("round_complete", {
          requestId,
          sessionKey,
          memoryUpdateError,
          localContextFetchCount: loop.fetches.length,
          localContextFetches: loop.fetches,
          returnedContextPieceIds: [...new Set(loop.fetches.flatMap((fetch) => fetch.returnedPieceIds))],
          ...memoryStateMetrics(finalMemory),
          ...(usageTotals ? usageTotals : {}),
        });
        return loop.response;
      });
    } catch (error) {
      return jsonResponse({ error: "pando_proxy_failed", message: messageFor(error) }, 502);
    }
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
    headers: { "content-type": "application/json" },
  });
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
