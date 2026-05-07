import { assertEquals } from "@std/assert";

import { loadConfig, parseCliOptions } from "../src/config.ts";

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
