import { assertEquals } from "jsr:@std/assert";

import { parseWrapperArgs } from "../src/wrapper.ts";

Deno.test("parseWrapperArgs accepts structured model wrapper flags", () => {
  const parsed = parseWrapperArgs([
    "--proxy-small-structured-model",
    "gpt-4.1-mini",
    "--proxy-overflow-structured-model",
    "gpt-5-mini",
    "exec",
    "hi",
  ]);

  assertEquals(parsed.options.smallStructuredModel, "gpt-4.1-mini");
  assertEquals(parsed.options.overflowStructuredModel, "gpt-5-mini");
  assertEquals(parsed.codexArgs, ["exec", "hi"]);
});
