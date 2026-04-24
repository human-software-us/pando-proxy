import { assertEquals, assertMatch } from "jsr:@std/assert";

import type { ProxyConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";

Deno.test("first streamed turn completes without deadlocking memory persistence", async () => {
  const tempDir = await Deno.makeTempDir();
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;

  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}"));
    const format = body?.text?.format?.name;

    if (format === "source_chunk") {
      return jsonResponse({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "{\"chunks\":[{\"kind\":\"whole\"}]}" }],
        }],
      });
    }

    if (format === "working_memory_update") {
      return jsonResponse({
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "{\"objectiveAfter\":null,\"keepOldChunkIds\":[],\"keepNewChunkIds\":[]}",
          }],
        }],
      });
    }

    upstreamCalls += 1;
    if (upstreamCalls !== 1) {
      throw new Error(`Unexpected upstream call ${upstreamCalls}`);
    }

    return new Response(
      [
        "event: response.created",
        'data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}],"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );
  };

  try {
    const { handler } = createHandler(testConfig(tempDir));
    const request = new Request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer test",
        "x-pando-session-id": "interactive-session",
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        stream: true,
        input: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Follow instructions." }],
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "say hi" }],
          },
        ],
      }),
    });

    let timeoutId: number | undefined;
    const response = await Promise.race([
      handler(request),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("handler timed out")), 1000);
      }),
    ]);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "text/event-stream");
    assertMatch(await response.text(), /response\.completed/);
  } finally {
    globalThis.fetch = originalFetch;
    await Deno.remove(tempDir, { recursive: true });
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
    apiKey: null,
    smallStructuredModel: "gpt-5.4-mini",
    overflowStructuredModel: "gpt-5.4",
    smallStructuredContextWindow: 32_000,
    overflowStructuredContextWindow: 128_000,
    modelTimeoutMs: 5_000,
    stateDir,
    memoryEnabled: true,
    logFile: null,
    inlinePieceByteLimit: 4_096,
    piecePreviewCharLimit: 80,
    maxIndexedPiecesPerTask: 8,
    maxLocalContextToolCalls: 3,
    codexAutoCompactTokenLimit: 280_000,
  };
}
