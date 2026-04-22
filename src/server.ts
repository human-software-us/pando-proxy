import { authHeaderFor, parseJsonBody, requestModel, sessionKeyFor } from "./codex_request.ts";
import { ProxyConfig } from "./config.ts";
import { createLogger, loggableBody, redactHeaders } from "./logger.ts";
import { runMaintenancePass } from "./memory_pipeline.ts";
import { rewriteRequestWithMemory } from "./prompt_view.ts";
import { SessionStore } from "./store.ts";
import { forwardResponsesRequest } from "./upstream.ts";

export function createHandler(config: ProxyConfig, store = new SessionStore(config.stateDir)) {
  const logger = createLogger(config.logFile);
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
    await logger.log("incoming_request", {
      method: request.method,
      path: url.pathname,
      headers: redactHeaders(request.headers),
      body: loggableBody(body),
      memoryEnabled: config.memoryEnabled,
    });
    if (!config.memoryEnabled) {
      try {
        return await forwardResponsesRequest(config, { authHeader, body, logger });
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

    const sessionKey = await sessionKeyFor(request, body);

    try {
      const rewritten = await store.withLock(sessionKey, async () => {
        const record = await store.load(sessionKey);
        const result = await runMaintenancePass(
          body,
          record,
          config,
          authHeader,
          requestModel(body),
        );
        if (result.changed) {
          await store.save(sessionKey, result.record);
        }
        return rewriteRequestWithMemory(
          body,
          result.record.memory,
          config.syntheticCharBudget,
        );
      });

      return await forwardResponsesRequest(config, { authHeader, body: rewritten, logger });
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

export async function serve(config: ProxyConfig): Promise<void> {
  const handler = createHandler(config);
  const server = Deno.serve({ hostname: config.host, port: config.port }, handler);
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
