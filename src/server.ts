import type { ProxyConfig } from "./config.ts";
import { authHeaderFor, parseJsonBody, requestModel, sessionKeyFor } from "./codex_request.ts";
import { createLogger } from "./logger.ts";
import { updateMemoryForCompletedRound } from "./memory_pipeline.ts";
import type { MemoryState } from "./memory_state.ts";
import { extractUsageMetrics, memoryStateMetrics, requestContextMetrics, TokenUsageTracker } from "./metrics.ts";
import { rewriteRequestWithMemory } from "./prompt_view.ts";
import { createStructuredClients } from "./structured_model.ts";
import { SessionStore } from "./store.ts";
import type { RoundSource } from "./tool_results.ts";
import { forwardResponsesRequest, type LocalContextFetch, runResponsesLoop } from "./upstream.ts";

const OBSERVED_TURN_SOURCES_TIMEOUT_MS = 3_000;
const FINALIZATION_DRAIN_TIMEOUT_MS = 10_000;

export type StartedProxyServer = {
  server: Deno.HttpServer;
  awaitIdle: (timeoutMs?: number) => Promise<void>;
};

export function createHandler(
  config: ProxyConfig,
  store = new SessionStore(config.stateDir, config.inlinePieceByteLimit),
  fallbackSessionKeyForRequest?: () => string | null | undefined,
  observedRoundSourcesForSession?: (sessionKey: string, timeoutMs: number) => Promise<RoundSource[]>,
) {
  const logger = createLogger(config.logFile);
  const usageTracker = new TokenUsageTracker();
  const fallbackSessionKey = `wrapper_${crypto.randomUUID()}`;
  const pendingFinalizations = new Map<string, Promise<void>>();

  const waitForPendingFinalization = async (sessionKey: string): Promise<void> => {
    const pending = pendingFinalizations.get(sessionKey);
    if (!pending) {
      return;
    }
    try {
      await pending;
    } catch {
      // Prior round failures are logged on the round itself. New requests should still proceed.
    }
  };

  const scheduleFinalization = (sessionKey: string, run: () => Promise<unknown>): void => {
    const previous = pendingFinalizations.get(sessionKey) ?? Promise.resolve();
    const next: Promise<void> = previous
      .catch(() => {})
      .then(run)
      .then(() => undefined)
      .finally(() => {
        if (pendingFinalizations.get(sessionKey) === next) {
          pendingFinalizations.delete(sessionKey);
        }
      });
    pendingFinalizations.set(sessionKey, next);
  };

  const awaitIdle = async (timeoutMs = FINALIZATION_DRAIN_TIMEOUT_MS): Promise<void> => {
    const pending = [...pendingFinalizations.values()];
    if (pending.length === 0) {
      return;
    }
    await promiseWithTimeout(Promise.allSettled(pending).then(() => undefined), timeoutMs);
  };

  const handler = async (request: Request): Promise<Response> => {
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
    const sessionKey = await sessionKeyFor(
      request,
      body,
      fallbackSessionKeyForRequest?.() ?? fallbackSessionKey,
    );
    await waitForPendingFinalization(sessionKey);
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
          insertedMemory: rewrite.diff.insertedMemory,
          inlineChunkCount: rewrite.diff.inlineChunkCount,
          omittedChunkCount: rewrite.diff.omittedChunkCount,
          ...requestContextMetrics(rewrite.body),
        });

        const loop = await runResponsesLoop(
          config,
          { authHeader, body: rewrite.body, logger },
          record.memory,
          rewrite.inlineChunkIds,
          sessionKey,
        );
        if (!loop.ok) {
          return loop.response;
        }

        try {
          if (observedRoundSourcesForSession) {
            await logger.log("memory_finalize_scheduled", {
              requestId,
              sessionKey,
              timeoutMs: OBSERVED_TURN_SOURCES_TIMEOUT_MS,
            });
            scheduleFinalization(
              sessionKey,
              () =>
                finalizeRoundMemory({
                  config,
                  store,
                  logger,
                  usageTracker,
                  requestId,
                  sessionKey,
                  requestBody: body,
                  rewriteBody: rewrite.body,
                  previousMemory: record.memory,
                  loopFinalBody: loop.finalBody,
                  assistantSources: loop.assistantSources,
                  fetches: loop.fetches,
                  authHeader,
                  observedRoundSourcesForSession,
                }),
            );
          } else {
            const completion = await finalizeRoundMemory({
              config,
              store,
              logger,
              usageTracker,
              requestId,
              sessionKey,
              requestBody: body,
              rewriteBody: rewrite.body,
              previousMemory: record.memory,
              loopFinalBody: loop.finalBody,
              assistantSources: loop.assistantSources,
              fetches: loop.fetches,
              authHeader,
            });
            finalMemory = completion.memory;
            memoryUpdateError = completion.memoryUpdateError;
          }
        } catch (error) {
          memoryUpdateError = messageFor(error);
          await logger.log("memory_update_failed", {
            requestId,
            sessionKey,
            message: memoryUpdateError,
          });
          const usage = extractUsageMetrics(loop.finalBody);
          const usageTotals = usage ? usageTracker.add(sessionKey, usage) : null;
          if (usageTotals) {
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
            localMemoryFetchCount: loop.fetches.length,
            localMemoryFetches: loop.fetches,
            returnedMemoryChunkIds: [...new Set(loop.fetches.flatMap((fetch) => fetch.returnedChunkIds))],
            ...memoryStateMetrics(finalMemory),
            ...(usageTotals ? usageTotals : {}),
          });
        }
        return loop.response;
      });
    } catch (error) {
      return jsonResponse({ error: "pando_proxy_failed", message: messageFor(error) }, 502);
    }
  };

  return { handler, awaitIdle };
}

export function startServer(
  config: ProxyConfig,
  fallbackSessionKeyForRequest?: () => string | null | undefined,
  observedRoundSourcesForSession?: (sessionKey: string, timeoutMs: number) => Promise<RoundSource[]>,
): StartedProxyServer {
  const { handler, awaitIdle } = createHandler(
    config,
    undefined,
    fallbackSessionKeyForRequest,
    observedRoundSourcesForSession,
  );
  const server = Deno.serve({
    hostname: config.host,
    port: config.port,
    onListen: () => {},
  }, handler);
  return { server, awaitIdle };
}

export async function serve(config: ProxyConfig): Promise<void> {
  const { server } = startServer(config);
  console.log(`Pando Proxy is running at http://${config.host}:${config.port}/v1`);
  console.log("Leave this terminal open while using Codex.");
  await server.finished;
}

type FinalizeRoundOptions = {
  config: ProxyConfig;
  store: SessionStore;
  logger: ReturnType<typeof createLogger>;
  usageTracker: TokenUsageTracker;
  requestId: string;
  sessionKey: string;
  requestBody: Record<string, unknown>;
  rewriteBody: Record<string, unknown>;
  previousMemory: MemoryState;
  loopFinalBody: Record<string, unknown>;
  assistantSources: RoundSource[];
  fetches: LocalContextFetch[];
  authHeader: string | null;
  observedRoundSourcesForSession?: (sessionKey: string, timeoutMs: number) => Promise<RoundSource[]>;
};

type FinalizeRoundResult = {
  memory: MemoryState;
  memoryUpdateError: string | null;
};

async function finalizeRoundMemory(options: FinalizeRoundOptions): Promise<FinalizeRoundResult> {
  const {
    config,
    store,
    logger,
    usageTracker,
    requestId,
    sessionKey,
    requestBody,
    rewriteBody,
    previousMemory,
    loopFinalBody,
    assistantSources,
    fetches,
    authHeader,
    observedRoundSourcesForSession,
  } = options;

  let finalMemory = previousMemory;
  let memoryUpdateError: string | null = null;
  const structuredUsageTotals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  try {
    const structuredClients = createStructuredClients(
      config,
      requestModel(requestBody),
      authHeader,
      (selection) =>
        logger.log("structured_model_selected", {
          requestId,
          sessionKey,
          ...selection,
        }),
      async (usage) => {
        structuredUsageTotals.inputTokens += usage.inputTokens ?? 0;
        structuredUsageTotals.cachedInputTokens += usage.cachedInputTokens ?? 0;
        structuredUsageTotals.outputTokens += usage.outputTokens ?? 0;
        structuredUsageTotals.totalTokens += usage.totalTokens ??
          ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
        await logger.log("structured_model_usage", {
          requestId,
          sessionKey,
          ...usage,
        });
      },
    );
    const observedWaitStartedAt = Date.now();
    const observedSources = observedRoundSourcesForSession
      ? await observedRoundSourcesForSession(sessionKey, OBSERVED_TURN_SOURCES_TIMEOUT_MS)
      : [];
    await logger.log("observed_round_sources", {
      requestId,
      sessionKey,
      timeoutMs: OBSERVED_TURN_SOURCES_TIMEOUT_MS,
      waitedMs: Date.now() - observedWaitStartedAt,
      observedSourceCount: observedSources.length,
      observedSourceIds: observedSources.map((source) => source.sourceId),
    });
    const memoryUpdate = await updateMemoryForCompletedRound(
      rewriteBody,
      previousMemory,
      loopFinalBody,
      [...assistantSources, ...observedSources],
      structuredClients,
      config,
      { logger, requestId, sessionKey },
    );
    finalMemory = memoryUpdate.memory;
    if (memoryUpdate.changed) {
      await store.withLock(sessionKey, async () => {
        await store.save(sessionKey, { memory: memoryUpdate.memory });
      });
      await logger.log("memory_state_saved", {
        requestId,
        sessionKey,
        newChunkIds: memoryUpdate.newChunkIds,
        droppedChunkIds: memoryUpdate.droppedChunkIds,
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

  const usage = extractUsageMetrics(loopFinalBody);
  const usageTotals = usage ? usageTracker.add(sessionKey, usage) : null;
  if (usageTotals) {
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
    localMemoryFetchCount: fetches.length,
    localMemoryFetches: fetches,
    returnedMemoryChunkIds: [...new Set(fetches.flatMap((fetch) => fetch.returnedChunkIds))],
    internalManagerInputTokens: structuredUsageTotals.inputTokens,
    internalManagerCachedInputTokens: structuredUsageTotals.cachedInputTokens,
    internalManagerOutputTokens: structuredUsageTotals.outputTokens,
    internalManagerTotalTokens: structuredUsageTotals.totalTokens,
    ...memoryStateMetrics(finalMemory),
    ...(usageTotals
      ? {
        allInInputTokens: usageTotals.inputTokens + structuredUsageTotals.inputTokens,
        allInCachedInputTokens: usageTotals.cachedInputTokens + structuredUsageTotals.cachedInputTokens,
        allInOutputTokens: usageTotals.outputTokens + structuredUsageTotals.outputTokens,
        allInTotalTokens: usageTotals.totalTokens + structuredUsageTotals.totalTokens,
      }
      : {
        allInInputTokens: structuredUsageTotals.inputTokens,
        allInCachedInputTokens: structuredUsageTotals.cachedInputTokens,
        allInOutputTokens: structuredUsageTotals.outputTokens,
        allInTotalTokens: structuredUsageTotals.totalTokens,
      }),
    ...(usageTotals ? usageTotals : {}),
  });
  return { memory: finalMemory, memoryUpdateError };
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

async function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}
