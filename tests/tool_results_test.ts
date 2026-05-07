import { assertEquals } from "@std/assert";

import { extractNewRequestSources } from "../src/tool_results.ts";

Deno.test("extractNewRequestSources captures request user, assistant, reasoning, tool calls, and tool outputs", async () => {
  const sources = await extractNewRequestSources({
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "system rules" }],
      },
      {
        id: "user_1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "inspect src/a.ts" }],
      },
      {
        id: "assistant_1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "I will inspect it." }],
      },
      {
        id: "reason_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need to run a file read." }],
      },
      {
        type: "function_call",
        name: "exec_command",
        call_id: "call_1",
        arguments: JSON.stringify({ cmd: "sed -n '1,20p' src/a.ts" }),
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "Chunk ID: abc\nWall time: 0.01\nOutput:\nexport const A = 1;\n",
      },
    ],
  }, new Set());

  assertEquals(sources.map((source) => source.sourceKind), [
    "user",
    "assistant",
    "assistant",
    "tool_call",
    "tool",
  ]);
  assertEquals(sources.map((source) => source.sourceId), [
    "user_1",
    "assistant_1",
    "reason_1",
    "tool_call:call_1",
    "call_1",
  ]);
  assertEquals(sources.at(-1)?.payload, "export const A = 1;\n");
});
