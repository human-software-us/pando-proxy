import { assertEquals } from "jsr:@std/assert";

import {
  extractAssistantSourcesFromResponse,
  extractNewRequestSources,
} from "../src/tool_results.ts";

Deno.test("extractNewRequestSources keeps user messages whole and skips synthetic task memory", async () => {
  const sources = await extractNewRequestSources({
    input: [
      {
        type: "message",
        role: "developer",
        name: "pando_task_memory",
        content: [{ type: "input_text", text: "<pando_task_memory />" }],
      },
      {
        id: "user_1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ],
  }, new Set());

  assertEquals(sources.length, 1);
  assertEquals(sources[0].sourceId, "user_1");
  assertEquals(sources[0].sourceKind, "user");
});

Deno.test("extractNewRequestSources maps tool outputs to tool sources", async () => {
  const sources = await extractNewRequestSources({
    input: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "mcp__pando__.find_nodes",
        arguments: "{}",
      },
      { id: "tool_out_1", type: "function_call_output", call_id: "call_1", output: { ok: true } },
    ],
  }, new Set());

  assertEquals(sources.length, 1);
  assertEquals(sources[0].sourceKind, "tool");
  assertEquals(sources[0].toolName, "mcp__pando__.find_nodes");
});

Deno.test("extractAssistantSourcesFromResponse reads assistant messages", async () => {
  const sources = await extractAssistantSourcesFromResponse({
    id: "resp_1",
    output: [{
      id: "assistant_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "done" }],
    }],
  });

  assertEquals(sources.map((source) => source.sourceId), ["assistant_1"]);
});
