import {
  CHATGPT_CODEX_UPSTREAM_BASE_URL,
  OPENAI_API_UPSTREAM_BASE_URL,
  resolveUpstreamBaseUrl,
} from "../src/config.ts";
import { authHeaderFor, sessionKeyFor } from "../src/codex_request.ts";

Deno.test("authHeaderFor prefers Codex-sent authorization over fallback key", () => {
  const request = new Request("http://local.test/v1/responses", {
    headers: { authorization: "Bearer codex-token" },
  });

  assertEquals(authHeaderFor(request, "fallback-key"), "Bearer codex-token");
});

Deno.test("authHeaderFor uses API key fallback only when request has no auth", () => {
  const request = new Request("http://local.test/v1/responses");

  assertEquals(authHeaderFor(request, "fallback-key"), "Bearer fallback-key");
});

Deno.test("auto upstream routes API keys to OpenAI API and other Codex auth to ChatGPT backend", () => {
  assertEquals(resolveUpstreamBaseUrl("auto", "Bearer sk-test"), OPENAI_API_UPSTREAM_BASE_URL);
  assertEquals(
    resolveUpstreamBaseUrl("auto", "Bearer eyJ.codex-login-token"),
    CHATGPT_CODEX_UPSTREAM_BASE_URL,
  );
  assertEquals(
    resolveUpstreamBaseUrl("http://127.0.0.1:9999/v1", "Bearer sk-test"),
    "http://127.0.0.1:9999/v1",
  );
});

Deno.test("sessionKeyFor prefers explicit session headers", async () => {
  const request = new Request("http://local.test/v1/responses", {
    headers: { "x-pando-session-id": "session-from-header" },
  });

  assertEquals(
    await sessionKeyFor(request, { prompt_cache_key: "from-body" }),
    "session-from-header",
  );
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
