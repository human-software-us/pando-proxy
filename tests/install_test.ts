import { codexConfigSnippet } from "../src/install.ts";

Deno.test("codex config snippet uses existing Codex auth instead of requiring env_key", () => {
  const snippet = codexConfigSnippet({ host: "127.0.0.1", port: 8787 });

  assert(snippet.includes("[profiles.pando-memory]"));
  assert(snippet.includes("[model_providers.pando-proxy]"));
  assert(snippet.includes('wire_api = "responses"'));
  assert(snippet.includes("requires_openai_auth = true"));
  assert(!snippet.includes("env_key"));
});

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
