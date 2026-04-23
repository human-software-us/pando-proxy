import { assertEquals, assertMatch } from "jsr:@std/assert";

import type { ProxyConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { SessionStore } from "../src/store.ts";

Deno.test("server rewrites with task memory and services context_get locally", async () => {
  const tempDir = await Deno.makeTempDir();
  const config = testConfig(tempDir);
  const store = new SessionStore(tempDir, config.inlinePieceByteLimit);
  await store.save("session_1", {
    memory: {
      roundSeq: 1,
      tasks: [{ id: "task_1", text: "Inspect the proxy", status: "open", kind: "do" }],
      pieces: [{
        id: "piece_1",
        sourceKind: "tool",
        sourceId: "tool_1",
        toolName: "mcp__pando__.find_nodes",
        taskIds: ["task_1"],
        payloadInline: { path: "src/server.ts#1" },
        previewText: "src/server.ts",
        byteSize: 20,
        createdSeq: 1,
        selector: { kind: "whole" },
      }],
      processedSourceIds: [],
    },
  });

  const seenBodies: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body));
    seenBodies.push(body);
    const formatName = body?.text?.format?.name;
    if (formatName === "source_chunk") {
      return jsonResponse({
        output_text: JSON.stringify({ chunks: [{ kind: "whole" }] }),
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ chunks: [{ kind: "whole" }] }) }] }],
      });
    }
    if (formatName === "round_update") {
      const pieceIds = (body.input?.[0]?.content?.[0]?.text ?? "").includes("assistant_msg_1:0")
        ? ["user_msg_1:0", "assistant_msg_1:0"]
        : ["user_msg_1:0"];
      return jsonResponse({
        output_text: JSON.stringify({
          tasksAfter: [{ id: "task_1", text: "Inspect the proxy", status: "open", kind: "do" }],
          pieceSelection: { mode: "keep_only", ids: pieceIds },
          keptPieceTaskLinks: pieceIds.map((id: string) => ({ id, taskIds: ["task_1"] })),
        }),
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              tasksAfter: [{ id: "task_1", text: "Inspect the proxy", status: "open", kind: "do" }],
              pieceSelection: { mode: "keep_only", ids: pieceIds },
              keptPieceTaskLinks: pieceIds.map((id: string) => ({ id, taskIds: ["task_1"] })),
            }),
          }],
        }],
      });
    }
    if (seenBodies.length === 1) {
      return jsonResponse({
        id: "resp_1",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "context_get",
          arguments: JSON.stringify({ pieceIds: ["piece_1"] }),
        }],
      });
    }
    if (seenBodies.length === 2) {
      return jsonResponse({
        id: "resp_2",
        output: [{
          id: "assistant_msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        }],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      });
    }
    throw new Error(`Unexpected fetch call ${seenBodies.length} to ${String(input)}`);
  };

  try {
    const handler = createHandler(config, store);
    const response = await handler(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test",
        "x-pando-session-id": "session_1",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [{
          id: "user_msg_1",
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please inspect the proxy" }],
        }],
      }),
    }));

    assertEquals(response.status, 200);
    const responseJson = await response.json();
    assertEquals(responseJson.id, "resp_2");

    const firstBody = seenBodies[0];
    const rewrittenInput = firstBody.input as Array<Record<string, unknown>>;
    const memoryMessage = rewrittenInput.find((item) => item.name === "pando_task_memory");
    assertEquals(Boolean(memoryMessage), true);
    assertMatch(String((memoryMessage?.content as Array<Record<string, unknown>>)[0].text), /pieceId=piece_1/);
    assertEquals(((firstBody.tools as Array<Record<string, unknown>>).some((tool) => tool.name === "context_get")), true);

    const secondBody = seenBodies[1];
    assertEquals(secondBody.previous_response_id, "resp_1");
    assertMatch(String((secondBody.input as Array<Record<string, unknown>>)[0].output), /piece_1/);

    const stored = await store.load("session_1");
    assertEquals(stored.memory.pieces.some((piece) => piece.id === "assistant_msg_1:0"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function testConfig(stateDir: string): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    upstreamBaseUrl: "https://api.openai.com/v1",
    apiKey: "test",
    smallStructuredModel: "gpt-4.1-mini",
    overflowStructuredModel: "gpt-5-mini",
    smallStructuredContextWindow: 32_000,
    overflowStructuredContextWindow: 128_000,
    modelTimeoutMs: 30_000,
    stateDir,
    memoryEnabled: true,
    logFile: null,
    inlinePieceByteLimit: 4_096,
    piecePreviewCharLimit: 80,
    maxIndexedPiecesPerTask: 8,
    maxLocalContextToolCalls: 3,
  };
}
