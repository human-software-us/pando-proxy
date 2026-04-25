import type { ProxyConfig } from "./config.ts";
import { authHeaderFor, parseJsonBody, requestModel, sessionKeyFor } from "./codex_request.ts";
import { createLogger } from "./logger.ts";
import { updateMemoryForCompletedRound } from "./memory_pipeline.ts";
import type { MemoryState } from "./memory_state.ts";
import {
  estimateBytesForValue,
  extractUsageMetrics,
  memoryStateMetrics,
  requestContextMetrics,
  TokenUsageTracker,
  type UsageTotals,
} from "./metrics.ts";
import { rewriteRequestWithMemory } from "./prompt_view.ts";
import {
  createStructuredClients,
  type StructuredModelSkipped,
  type StructuredModelUsage,
} from "./structured_model.ts";
import { SessionStore } from "./store.ts";
import type { RoundSource } from "./tool_results.ts";
import { type ArchiveRecall, forwardResponsesRequest, runResponsesLoop } from "./upstream.ts";

const OBSERVED_TURN_SOURCES_TIMEOUT_MS = 3_000;
const FINALIZATION_DRAIN_TIMEOUT_MS = 10_000;

export type StartedProxyServer = {
  server: Deno.HttpServer;
  awaitIdle: (timeoutMs?: number) => Promise<void>;
  contextStats: {
    latest: () => ContextWindowComparisonStats | null;
    forSession: (sessionKey: string) => ContextWindowComparisonStats | null;
  };
  tokenStats: {
    latest: () => SessionTokenStats | null;
    forSession: (sessionKey: string) => SessionTokenStats | null;
  };
};

export type ContextWindowStats = {
  samples: number;
  minBytes: number;
  avgBytes: number;
  maxBytes: number;
};

export type ContextWindowComparisonStats = {
  withoutProxy: ContextWindowStats | null;
  withProxy: ContextWindowStats | null;
};

type StructuredUsageClassifierTotals = {
  attempts: number;
  retryAttempts: number;
  skipped: number;
  estimatedInputTokens: number;
  inputTokens: number;
  inputTokenDelta: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
};

type StructuredUsageSessionTotals = {
  totals: StructuredUsageClassifierTotals;
  byClassifier: Partial<
    Record<StructuredModelUsage["classifier"], StructuredUsageClassifierTotals>
  >;
};

export type SessionTokenStats = {
  mainModel: UsageTotals | null;
  manager: StructuredUsageSessionTotals | null;
};

type MutableContextWindowStats = ContextWindowStats & {
  totalBytes: number;
};

class ContextWindowStatsTracker {
  #latestSessionKey: string | null = null;
  #withoutProxyBySession = new Map<string, MutableContextWindowStats>();
  #withProxyBySession = new Map<string, MutableContextWindowStats>();

  recordWithoutProxy(sessionKey: string, byteCount: number): void {
    this.#record(this.#withoutProxyBySession, sessionKey, byteCount);
  }

  recordWithProxy(sessionKey: string, byteCount: number): void {
    this.#record(this.#withProxyBySession, sessionKey, byteCount);
  }

  #record(
    bySession: Map<string, MutableContextWindowStats>,
    sessionKey: string,
    byteCount: number,
  ): void {
    if (!Number.isFinite(byteCount) || byteCount < 0) {
      return;
    }
    const previous = bySession.get(sessionKey);
    const next: MutableContextWindowStats = previous
      ? {
        samples: previous.samples + 1,
        minBytes: Math.min(previous.minBytes, byteCount),
        avgBytes: 0,
        maxBytes: Math.max(previous.maxBytes, byteCount),
        totalBytes: previous.totalBytes + byteCount,
      }
      : {
        samples: 1,
        minBytes: byteCount,
        avgBytes: 0,
        maxBytes: byteCount,
        totalBytes: byteCount,
      };
    next.avgBytes = Math.round(next.totalBytes / next.samples);
    bySession.set(sessionKey, next);
    this.#latestSessionKey = sessionKey;
  }

  latest(): ContextWindowComparisonStats | null {
    return this.#latestSessionKey ? this.forSession(this.#latestSessionKey) : null;
  }

  forSession(sessionKey: string): ContextWindowComparisonStats | null {
    return snapshotContextWindowComparisonStats(
      this.#withoutProxyBySession.get(sessionKey),
      this.#withProxyBySession.get(sessionKey),
    );
  }
}

class StructuredUsageTracker {
  #latestSessionKey: string | null = null;
  #bySession = new Map<string, StructuredUsageSessionTotals>();

  add(sessionKey: string, usage: StructuredModelUsage): StructuredUsageSessionTotals {
    const session = this.#ensureSession(sessionKey);
    const classifierTotals = session.byClassifier[usage.classifier] ?? emptyStructuredUsageTotals();
    classifierTotals.attempts += 1;
    classifierTotals.retryAttempts += usage.attempt > 1 ? 1 : 0;
    classifierTotals.estimatedInputTokens += usage.estimatedInputTokens;
    classifierTotals.inputTokens += usage.inputTokens ?? 0;
    classifierTotals.inputTokenDelta += usage.inputTokenDelta ?? 0;
    classifierTotals.cachedInputTokens += usage.cachedInputTokens ?? 0;
    classifierTotals.outputTokens += usage.outputTokens ?? 0;
    classifierTotals.totalTokens += usage.totalTokens ??
      ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
    classifierTotals.durationMs += usage.durationMs;
    session.byClassifier[usage.classifier] = classifierTotals;
    session.totals = sumStructuredUsageTotals(Object.values(session.byClassifier));
    this.#latestSessionKey = sessionKey;
    return session;
  }

  addSkipped(sessionKey: string, skipped: StructuredModelSkipped): StructuredUsageSessionTotals {
    const session = this.#ensureSession(sessionKey);
    const classifierTotals = session.byClassifier[skipped.classifier] ??
      emptyStructuredUsageTotals();
    classifierTotals.skipped += 1;
    classifierTotals.estimatedInputTokens += skipped.estimatedInputTokens;
    session.byClassifier[skipped.classifier] = classifierTotals;
    session.totals = sumStructuredUsageTotals(Object.values(session.byClassifier));
    this.#latestSessionKey = sessionKey;
    return session;
  }

  forSession(sessionKey: string): StructuredUsageSessionTotals | null {
    return this.#bySession.get(sessionKey) ?? null;
  }

  latest(): StructuredUsageSessionTotals | null {
    return this.#latestSessionKey ? this.forSession(this.#latestSessionKey) : null;
  }

  #ensureSession(sessionKey: string): StructuredUsageSessionTotals {
    const existing = this.#bySession.get(sessionKey);
    if (existing) {
      return existing;
    }
    const created: StructuredUsageSessionTotals = {
      totals: emptyStructuredUsageTotals(),
      byClassifier: {},
    };
    this.#bySession.set(sessionKey, created);
    return created;
  }
}

export function createHandler(
  config: ProxyConfig,
  store = new SessionStore(config.stateDir, config.inlinePieceByteLimit),
  fallbackSessionKeyForRequest?: () => string | null | undefined,
  observedRoundSourcesForSession?: (
    sessionKey: string,
    timeoutMs: number,
  ) => Promise<RoundSource[]>,
) {
  const logger = createLogger(config.logFile);
  const usageTracker = new TokenUsageTracker();
  const managerUsageTracker = new StructuredUsageTracker();
  const contextWindowStats = new ContextWindowStatsTracker();
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
    contextWindowStats.recordWithoutProxy(sessionKey, estimateBytesForValue(body));

    if (!config.memoryEnabled) {
      contextWindowStats.recordWithProxy(sessionKey, estimateBytesForValue(body));
      try {
        return await forwardResponsesRequest(config, { authHeader, body, logger });
      } catch (error) {
        return jsonResponse({ error: "pando_proxy_failed", message: messageFor(error) }, 502);
      }
    }

    try {
      return await store.withLock(sessionKey, async () => {
        const record = await store.load(sessionKey);
        const promptMemory = await store.materializeMemory(sessionKey, record.memory);
        let finalMemory = record.memory;
        let memoryUpdateError: string | null = null;
        const rewrite = await rewriteRequestWithMemory(body, promptMemory, config);
        await logger.log("rewritten_context", {
          requestId,
          sessionKey,
          droppedInputIds: rewrite.diff.droppedInputIds,
          keptInputIds: rewrite.diff.keptInputIds,
          insertedMemory: rewrite.diff.insertedMemory,
          memoryPieceCount: rewrite.diff.memoryPieceCount,
          ...requestContextMetrics(rewrite.body),
        });
        contextWindowStats.recordWithProxy(sessionKey, estimateBytesForValue(rewrite.body));

        const loop = await runResponsesLoop(
          config,
          { authHeader, body: rewrite.body, logger },
          promptMemory,
          (sourceIds) => store.getArchivedSources(sessionKey, sourceIds),
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
                  managerUsageTracker,
                  requestId,
                  sessionKey,
                  requestBody: body,
                  rewriteBody: rewrite.body,
                  previousMemory: record.memory,
                  loopFinalBody: loop.finalBody,
                  assistantSources: loop.assistantSources,
                  recalls: loop.recalls,
                  authHeader,
                  observedRoundSourcesForSession,
                  saveWithinExistingLock: false,
                }),
            );
          } else {
            const completion = await finalizeRoundMemory({
              config,
              store,
              logger,
              usageTracker,
              managerUsageTracker,
              requestId,
              sessionKey,
              requestBody: body,
              rewriteBody: rewrite.body,
              previousMemory: record.memory,
              loopFinalBody: loop.finalBody,
              assistantSources: loop.assistantSources,
              recalls: loop.recalls,
              authHeader,
              saveWithinExistingLock: true,
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
            archiveRecallCount: loop.recalls.length,
            archiveRecalls: loop.recalls,
            archiveRecallReturnedBytes: loop.recalls.reduce(
              (total, recall) => total + recall.returnedBytes,
              0,
            ),
            returnedArchiveSourceIds: [
              ...new Set(loop.recalls.flatMap((recall) => recall.returnedSourceIds)),
            ],
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

  return {
    handler,
    awaitIdle,
    contextStats: {
      latest: () => contextWindowStats.latest(),
      forSession: (sessionKey: string) => contextWindowStats.forSession(sessionKey),
    },
    tokenStats: {
      latest: () => snapshotSessionTokenStats(usageTracker.latest(), managerUsageTracker.latest()),
      forSession: (sessionKey: string) =>
        snapshotSessionTokenStats(
          usageTracker.forSession(sessionKey),
          managerUsageTracker.forSession(sessionKey),
        ),
    },
  };
}

export function startServer(
  config: ProxyConfig,
  fallbackSessionKeyForRequest?: () => string | null | undefined,
  observedRoundSourcesForSession?: (
    sessionKey: string,
    timeoutMs: number,
  ) => Promise<RoundSource[]>,
): StartedProxyServer {
  const { handler, awaitIdle, contextStats, tokenStats } = createHandler(
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
  return { server, awaitIdle, contextStats, tokenStats };
}

function snapshotContextWindowStats(
  value: MutableContextWindowStats | undefined,
): ContextWindowStats | null {
  if (!value || value.samples === 0) {
    return null;
  }
  return {
    samples: value.samples,
    minBytes: value.minBytes,
    avgBytes: value.avgBytes,
    maxBytes: value.maxBytes,
  };
}

function snapshotContextWindowComparisonStats(
  withoutProxy: MutableContextWindowStats | undefined,
  withProxy: MutableContextWindowStats | undefined,
): ContextWindowComparisonStats | null {
  const withoutProxySnapshot = snapshotContextWindowStats(withoutProxy);
  const withProxySnapshot = snapshotContextWindowStats(withProxy);
  if (!withoutProxySnapshot && !withProxySnapshot) {
    return null;
  }
  return {
    withoutProxy: withoutProxySnapshot,
    withProxy: withProxySnapshot,
  };
}

function emptyStructuredUsageTotals(): StructuredUsageClassifierTotals {
  return {
    attempts: 0,
    retryAttempts: 0,
    skipped: 0,
    estimatedInputTokens: 0,
    inputTokens: 0,
    inputTokenDelta: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    durationMs: 0,
  };
}

function sumStructuredUsageTotals(
  values: Array<StructuredUsageClassifierTotals | undefined>,
): StructuredUsageClassifierTotals {
  const total = emptyStructuredUsageTotals();
  for (const value of values) {
    if (!value) {
      continue;
    }
    total.attempts += value.attempts;
    total.retryAttempts += value.retryAttempts;
    total.skipped += value.skipped;
    total.estimatedInputTokens += value.estimatedInputTokens;
    total.inputTokens += value.inputTokens;
    total.inputTokenDelta += value.inputTokenDelta;
    total.cachedInputTokens += value.cachedInputTokens;
    total.outputTokens += value.outputTokens;
    total.totalTokens += value.totalTokens;
    total.durationMs += value.durationMs;
  }
  return total;
}

function snapshotSessionTokenStats(
  mainModel: UsageTotals | null,
  manager: StructuredUsageSessionTotals | null,
): SessionTokenStats | null {
  if (!mainModel && !manager) {
    return null;
  }
  return { mainModel, manager };
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
  managerUsageTracker: StructuredUsageTracker;
  requestId: string;
  sessionKey: string;
  requestBody: Record<string, unknown>;
  rewriteBody: Record<string, unknown>;
  previousMemory: MemoryState;
  loopFinalBody: Record<string, unknown>;
  assistantSources: RoundSource[];
  recalls: ArchiveRecall[];
  authHeader: string | null;
  observedRoundSourcesForSession?: (
    sessionKey: string,
    timeoutMs: number,
  ) => Promise<RoundSource[]>;
  saveWithinExistingLock?: boolean;
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
    managerUsageTracker,
    requestId,
    sessionKey,
    requestBody,
    rewriteBody,
    previousMemory,
    loopFinalBody,
    assistantSources,
    recalls,
    authHeader,
    observedRoundSourcesForSession,
    saveWithinExistingLock = false,
  } = options;

  let finalMemory = previousMemory;
  let memoryUpdateError: string | null = null;
  const structuredUsageByClassifier: Partial<
    Record<StructuredModelUsage["classifier"], StructuredUsageClassifierTotals>
  > = {};

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
        const classifierTotals = structuredUsageByClassifier[usage.classifier] ??
          emptyStructuredUsageTotals();
        classifierTotals.attempts += 1;
        classifierTotals.retryAttempts += usage.attempt > 1 ? 1 : 0;
        classifierTotals.estimatedInputTokens += usage.estimatedInputTokens;
        classifierTotals.inputTokens += usage.inputTokens ?? 0;
        classifierTotals.inputTokenDelta += usage.inputTokenDelta ?? 0;
        classifierTotals.cachedInputTokens += usage.cachedInputTokens ?? 0;
        classifierTotals.outputTokens += usage.outputTokens ?? 0;
        classifierTotals.totalTokens += usage.totalTokens ??
          ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
        classifierTotals.durationMs += usage.durationMs;
        structuredUsageByClassifier[usage.classifier] = classifierTotals;
        managerUsageTracker.add(sessionKey, usage);
        await logger.log("structured_model_usage", {
          requestId,
          sessionKey,
          ...usage,
        });
      },
      async (skipped) => {
        managerUsageTracker.addSkipped(sessionKey, skipped);
        await logger.log("structured_model_skipped", {
          requestId,
          sessionKey,
          ...skipped,
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
      { logger, requestId, sessionKey },
    );
    finalMemory = memoryUpdate.memory;
    await store.archiveSources(sessionKey, memoryUpdate.sources);
    if (memoryUpdate.changed) {
      const persist = async () => {
        await store.save(sessionKey, { memory: memoryUpdate.memory });
      };
      if (saveWithinExistingLock) {
        await persist();
      } else {
        await store.withLock(sessionKey, persist);
      }
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

  const usage = extractUsageMetrics(loopFinalBody);
  const usageTotals = usage ? usageTracker.add(sessionKey, usage) : null;
  const structuredUsageTotals = sumStructuredUsageTotals(
    Object.values(structuredUsageByClassifier),
  );
  const archiveRecallReturnedBytes = recalls.reduce(
    (total, recall) => total + recall.returnedBytes,
    0,
  );
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
    archiveRecallCount: recalls.length,
    archiveRecalls: recalls,
    returnedArchiveSourceIds: [...new Set(recalls.flatMap((recall) => recall.returnedSourceIds))],
    archiveRecallReturnedBytes,
    internalManagerInputTokens: structuredUsageTotals.inputTokens,
    internalManagerCachedInputTokens: structuredUsageTotals.cachedInputTokens,
    internalManagerOutputTokens: structuredUsageTotals.outputTokens,
    internalManagerTotalTokens: structuredUsageTotals.totalTokens,
    internalManagerRetryAttempts: structuredUsageTotals.retryAttempts,
    internalManagerDurationMs: structuredUsageTotals.durationMs,
    internalManagerInputTokenDelta: structuredUsageTotals.inputTokenDelta,
    internalManagerByClassifier: structuredUsageByClassifier,
    ...memoryStateMetrics(finalMemory),
    ...(usageTotals
      ? {
        allInInputTokens: usageTotals.inputTokens + structuredUsageTotals.inputTokens,
        allInCachedInputTokens: usageTotals.cachedInputTokens +
          structuredUsageTotals.cachedInputTokens,
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
