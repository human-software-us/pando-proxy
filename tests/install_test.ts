import {
  codexConfigSnippet,
  currentDefaultProvider,
  isPandoDefaultProvider,
  restoreDefaultProvider,
  setDefaultProvider,
} from "../src/install.ts";

Deno.test("codex config snippet installs only provider entry, not a profile", () => {
  const snippet = codexConfigSnippet({ host: "127.0.0.1", port: 8787 });

  assert(!snippet.includes("[profiles.pando-memory]"));
  assert(snippet.includes("[model_providers.pando-proxy]"));
  assert(snippet.includes('wire_api = "responses"'));
  assert(snippet.includes("requires_openai_auth = true"));
  assert(!snippet.includes("env_key"));
});

Deno.test("default provider helpers set and restore top-level model_provider", () => {
  const original = [
    'model = "gpt-5.4"',
    "",
    "[projects.foo]",
    'trust_level = "trusted"',
    "",
  ].join("\n");

  const installed = setDefaultProvider(original, "pando-proxy");
  assert(isPandoDefaultProvider(installed));
  assert(installed.indexOf('model_provider = "pando-proxy"') < installed.indexOf("[projects.foo]"));

  const restored = restoreDefaultProvider(installed, null);
  assert(currentDefaultProvider(restored) === null);

  const restoredToPrevious = restoreDefaultProvider(installed, "openai");
  assert(currentDefaultProvider(restoredToPrevious) === "openai");
});

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
