import { assertEquals } from "jsr:@std/assert";

import { chunkRoundSources } from "../src/chunking.ts";
import type { ProxyConfig } from "../src/config.ts";
import type { StructuredClients } from "../src/structured_model.ts";
import type { RoundSource } from "../src/tool_results.ts";

Deno.test("chunkRoundSources keeps user messages whole", async () => {
  const sources: RoundSource[] = [{
    sourceId: "user_1",
    sourceKind: "user",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
  }];

  const chunked = await chunkRoundSources(sources, config(), stubClients());

  assertEquals(chunked.length, 1);
  assertEquals(chunked[0].id, "user_1:0");
  assertEquals(chunked[0].selector, { kind: "whole" });
});

Deno.test("chunkRoundSources splits pando payloads deterministically in code", async () => {
  const sources: RoundSource[] = [{
    sourceId: "tool_1",
    sourceKind: "tool",
    toolName: "mcp__pando__.find_nodes",
    payload: {
      data: {
        results: [
          { path: "src/a.ts#1", name: "a" },
          { path: "src/b.ts#2", name: "b" },
        ],
      },
    },
  }];

  const chunked = await chunkRoundSources(sources, config(), stubClients());

  assertEquals(chunked.map((piece) => piece.id), ["tool_1:0", "tool_1:1"]);
  assertEquals(chunked[0].selector, { kind: "object_path", path: ["data", "results", 0] });
  assertEquals(chunked[1].payloadInline, { path: "src/b.ts#2", name: "b" });
});

Deno.test("chunkRoundSources uses structured chunking for assistant outputs", async () => {
  const source: RoundSource = {
    sourceId: "assistant_1",
    sourceKind: "assistant",
    payload: "line one\nline two\nline three",
  };
  const clients = stubClients({
    chunks: [{ kind: "line_range", startLine: 2, endLine: 3 }],
  });

  const chunked = await chunkRoundSources([source], config(), clients);

  assertEquals(chunked.length, 1);
  assertEquals(chunked[0].payloadInline, "line two\nline three");
  assertEquals(chunked[0].selector, { kind: "line_range", startLine: 2, endLine: 3 });
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

function stubClients(
  sourceChunkResponse: { chunks: Array<{ kind: "whole" } | { kind: "line_range"; startLine: number; endLine: number } | { kind: "object_path"; path: Array<string | number> }> } = { chunks: [{ kind: "whole" }] },
): StructuredClients {
  return {
    roundUpdate: async () => ({
      tasksAfter: [],
      pieceSelection: { mode: "drop_all" },
      keptPieceTaskLinks: [],
    }),
    sourceChunk: async () => sourceChunkResponse,
  };
}
