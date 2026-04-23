import { ProxyConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { SessionStore } from "../src/store.ts";

Deno.test("responses proxy injects existing memory and passes upstream response through", async () => {
  const tempDir = await Deno.makeTempDir();
  let capturedBody: Record<string, unknown> | null = null;
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    capturedBody = await request.json();
    return new Response('data: {"ok":true}\n\n', {
      headers: { "content-type": "text/event-stream" },
    });
  });

  try {
    const config: ProxyConfig = {
      host: "127.0.0.1",
      port: 8787,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.addr.port}`,
      apiKey: "test-key",
      maintenanceModel: "test-model",
      stateDir: tempDir,
      syntheticCharBudget: 4_000,
      maintenanceTimeoutMs: 5_000,
      memoryEnabled: true,
      logFile: null,
    };
    const store = new SessionStore(tempDir);
    await store.save("session-1", {
      memory: {
        taskUpdateSeq: 1,
        tasks: [{ id: "task_1", text: "Implement proxy", status: "in_progress", kind: "do" }],
        activeTaskId: "task_1",
        keptUserMessages: [],
        memoryLibrary: [{
          id: "chunk_1",
          title: "SSE",
          summary: "Stream upstream bytes unchanged.",
          kind: "tool",
          taskIds: ["task_1"],
        }],
      },
      handledInputIds: [],
    });

    const handler = createHandler(config, store);
    const response = await handler(
      new Request("http://local.test/v1/responses", {
        method: "POST",
        headers: {
          "authorization": "Bearer test-key",
          "x-pando-session-id": "session-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "test-main-model",
          stream: true,
          input: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: "rules" }],
            },
          ],
        }),
      }),
    );

    assertEquals(response.headers.get("content-type"), "text/event-stream");
    assertEquals(await response.text(), 'data: {"ok":true}\n\n');
    const body = capturedBody as Record<string, unknown> | null;
    assert(body !== null);
    const input = body.input as Array<Record<string, unknown>>;
    assertEquals(input.length, 2);
    assertEquals(input[0].role, "developer");
    assert(JSON.stringify(input[1]).includes("<context_memory>"));
  } finally {
    await upstream.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("responses proxy logs rewrite diff metrics", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = `${tempDir}/proxy.jsonl`;
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, () =>
    new Response('data: {"ok":true}\n\n', {
      headers: { "content-type": "text/event-stream" },
    }));

  try {
    const config: ProxyConfig = {
      host: "127.0.0.1",
      port: 8787,
      upstreamBaseUrl: `http://127.0.0.1:${upstream.addr.port}`,
      apiKey: "test-key",
      maintenanceModel: null,
      stateDir: tempDir,
      syntheticCharBudget: 4_000,
      maintenanceTimeoutMs: 5_000,
      memoryEnabled: true,
      logFile,
    };
    const store = new SessionStore(tempDir);
    await store.save("session-1", {
      memory: {
        taskUpdateSeq: 1,
        tasks: [{ id: "task_1", text: "Keep working", status: "in_progress", kind: "do" }],
        activeTaskId: "task_1",
        keptUserMessages: [{ messageId: "user_msg_1", summary: "Do the task.", taskIds: ["task_1"] }],
        memoryLibrary: [],
      },
      handledInputIds: ["user_msg_1"],
    });
    const handler = createHandler(config, store);
    await handler(
      new Request("http://local.test/v1/responses", {
        method: "POST",
        headers: {
          "authorization": "Bearer test-key",
          "x-pando-session-id": "session-1",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "test-main-model",
          stream: true,
          input: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: "rules" }],
            },
            {
              type: "message",
              role: "user",
              id: "env",
              content: [{
                type: "input_text",
                text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
              }],
            },
            {
              type: "message",
              role: "user",
              id: "msg_1",
              content: [{ type: "input_text", text: "Do the task." }],
            },
          ],
        }),
      }),
    );

    const metrics = (await Deno.readTextFile(logFile))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((row) => row.event === "pando_proxy_metrics_rewritten_context");
    assert(metrics);
    assert(Array.isArray(metrics.droppedInputIds));
    assert(metrics.droppedInputIds.length >= 1);
    assert(typeof metrics.insertedSyntheticMemoryChars === "number");
    assert(metrics.rawInputTypeCounts["message:user"] >= 2);
  } finally {
    await upstream.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) {
    throw new Error(message);
  }
}

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
