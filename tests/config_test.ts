import { assertEquals } from "@std/assert";

import {
  DEFAULT_OVERFLOW_STRUCTURED_CONTEXT_WINDOW,
  DEFAULT_OVERFLOW_STRUCTURED_MODEL,
  DEFAULT_SMALL_STRUCTURED_CONTEXT_WINDOW,
  DEFAULT_SMALL_STRUCTURED_MODEL,
  loadConfig,
  parseCliOptions,
} from "../src/config.ts";

Deno.test("parseCliOptions accepts structured model flags", () => {
  const parsed = parseCliOptions([
    "serve",
    "--small-structured-model",
    "gpt-4.1-mini",
    "--overflow-structured-model",
    "gpt-5-mini",
  ]);

  assertEquals(parsed.command, "serve");
  assertEquals(parsed.options.smallStructuredModel, "gpt-4.1-mini");
  assertEquals(parsed.options.overflowStructuredModel, "gpt-5-mini");
});

Deno.test("parseCliOptions accepts direct proxy logging flag", () => {
  const parsed = parseCliOptions(["serve", "--log"]);

  assertEquals(parsed.command, "serve");
  assertEquals(parsed.options.logEnabled, true);
});

Deno.test("loadConfig honors provided structured model options", () => {
  const config = loadConfig({
    smallStructuredModel: "gpt-4.1-mini",
    overflowStructuredModel: "gpt-5-mini",
  });

  assertEquals(config.smallStructuredModel, "gpt-4.1-mini");
  assertEquals(config.overflowStructuredModel, "gpt-5-mini");
});

Deno.test("loadConfig defaults to current structured model pair and context windows", () => {
  const config = withClearedEnv([
    "PANDO_PROXY_SMALL_STRUCTURED_MODEL",
    "PANDO_PROXY_MAINTENANCE_MODEL",
    "PANDO_PROXY_OVERFLOW_STRUCTURED_MODEL",
    "PANDO_PROXY_SMALL_STRUCTURED_CONTEXT_WINDOW",
    "PANDO_PROXY_OVERFLOW_STRUCTURED_CONTEXT_WINDOW",
  ], () => loadConfig());

  assertEquals(config.smallStructuredModel, DEFAULT_SMALL_STRUCTURED_MODEL);
  assertEquals(config.overflowStructuredModel, DEFAULT_OVERFLOW_STRUCTURED_MODEL);
  assertEquals(config.smallStructuredContextWindow, DEFAULT_SMALL_STRUCTURED_CONTEXT_WINDOW);
  assertEquals(config.overflowStructuredContextWindow, DEFAULT_OVERFLOW_STRUCTURED_CONTEXT_WINDOW);
  assertEquals(config.smallStructuredModel, "gpt-5.4-nano");
  assertEquals(config.overflowStructuredModel, "gpt-4.1-nano");
  assertEquals(config.smallStructuredContextWindow, 400_000);
  assertEquals(config.overflowStructuredContextWindow, 1_047_576);
});

function withClearedEnv<T>(names: string[], fn: () => T): T {
  const previous = names.map((name) => [name, Deno.env.get(name)] as const);
  try {
    for (const name of names) {
      Deno.env.delete(name);
    }
    return fn();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        Deno.env.delete(name);
      } else {
        Deno.env.set(name, value);
      }
    }
  }
}
