import { assert, assertEquals, assertMatch } from "jsr:@std/assert";

import type { ProxyConfig } from "../src/config.ts";
import { rewriteRequestWithMemory } from "../src/prompt_view.ts";

Deno.test("rewriteRequestWithMemory keeps instructions and current turn only", async () => {
  const body = {
    input: [
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "Always be precise." }],
      },
      {
        id: "old_user",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "old request" }],
      },
      {
        id: "old_assistant",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "old answer" }],
      },
      {
        id: "new_user",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "new request" }],
      },
    ],
  };
  const memory = {
    roundSeq: 3,
    tasks: [{
      id: "task_1",
      text: "Inspect the proxy",
      status: "open" as const,
      kind: "do" as const,
    }],
    pieces: [{
      id: "piece_1",
      sourceKind: "tool" as const,
      sourceId: "tool_src_1",
      toolName: "mcp__pando__.find_nodes",
      taskIds: ["task_1"],
      payloadInline: { path: "src/server.ts#1" },
      previewText: "src/server.ts",
      pointer: { path: "src/server.ts#1" },
      byteSize: 10,
      createdSeq: 1,
      selector: { kind: "whole" as const },
    }],
    processedSourceIds: ["old_user"],
  };

  const rewritten = await rewriteRequestWithMemory(body, memory, config());
  const items = rewritten.body.input as Array<Record<string, unknown>>;

  assertEquals(items.length, 3);
  assertEquals(items[0].role, "developer");
  assertEquals(items[2].id, "new_user");
  assertMatch(
    String((items[1].content as Array<Record<string, unknown>>)[0].text),
    /<pando_task_memory>/,
  );
  assert(!rewritten.diff.keptInputIds.includes("old_user"));
  assertEquals(Array.isArray(rewritten.body.tools), true);
});

Deno.test("rewriteRequestWithMemory injects piece ids for context_get lookup", async () => {
  const rewritten = await rewriteRequestWithMemory(
    {
      input: [{
        id: "user_1",
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      }],
    },
    {
      roundSeq: 1,
      tasks: [{ id: "task_1", text: "Inspect", status: "open", kind: "do" }],
      pieces: [{
        id: "piece_1",
        sourceKind: "assistant",
        sourceId: "assistant_1",
        taskIds: ["task_1"],
        payloadInline: "exact text",
        previewText: "exact text",
        byteSize: 10,
        createdSeq: 1,
        selector: { kind: "whole" },
      }],
      processedSourceIds: [],
    },
    config(),
  );

  const memoryItem = (rewritten.body.input as Array<Record<string, unknown>>)[0];
  const text = String((memoryItem.content as Array<Record<string, unknown>>)[0].text);
  assertMatch(text, /pieceId=piece_1/);
  assertMatch(text, /context_get/);
});

function config(): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    upstreamBaseUrl: "https://api.openai.com/v1",
    apiKey: null,
    smallStructuredModel: "gpt-4.1-mini",
    overflowStructuredModel: "gpt-5-mini",
    smallStructuredContextWindow: 32_000,
    overflowStructuredContextWindow: 128_000,
    modelTimeoutMs: 30_000,
    stateDir: "/tmp/pando-proxy-tests",
    memoryEnabled: true,
    logFile: null,
    inlinePieceByteLimit: 4_096,
    piecePreviewCharLimit: 80,
    maxIndexedPiecesPerTask: 8,
    maxLocalContextToolCalls: 3,
  };
}
