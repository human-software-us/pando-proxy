import { ProxyConfig } from "../src/config.ts";
import { emptySessionRecord, MemoryState, SessionRecord } from "../src/memory_state.ts";
import { runMaintenancePass } from "../src/memory_pipeline.ts";

Deno.test("memory pipeline calls task_update for new user messages", async () => {
  await withFakeMaintenanceUpstream(async ({ config, requests }) => {
    const result = await runMaintenancePass(
      {
        model: "gpt-5.4",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Build the proxy wrapper" }],
        }],
      },
      emptySessionRecord(),
      config,
      "Bearer codex-login-test",
      "gpt-5.4",
    );

    assertEquals(requests.map((request) => request.schemaName), ["task_update"]);
    assertEquals(result.changed, true);
    assertEquals(result.record.memory.tasks.length, 1);
    assertEquals(result.record.memory.activeTaskId, "task_1");
    assertEquals(result.record.memory.keptUserMessages.length, 1);
    assert(result.record.handledInputIds[0].startsWith("user_"));
  });
});

Deno.test("memory pipeline calls chunk_batch and retention for non-pando tool outputs", async () => {
  await withFakeMaintenanceUpstream(async ({ config, requests }) => {
    const result = await runMaintenancePass(
      {
        model: "gpt-5.4",
        input: [
          {
            type: "function_call",
            id: "call_1",
            call_id: "call_1",
            name: "shell_exec",
            arguments: '{"cmd":"printf alpha"}',
          },
          {
            type: "function_call_output",
            call_id: "call_1",
            output: "alpha",
          },
        ],
      },
      recordWithTask(),
      config,
      "Bearer codex-login-test",
      "gpt-5.4",
    );

    assertEquals(requests.map((request) => request.schemaName), [
      "chunk_batch",
      "retention_decision",
    ]);
    assertEquals(requests[0].payload.results[0].toolName, "shell_exec");
    assertEquals(requests[0].payload.results[0].params, { cmd: "printf alpha" });
    assertEquals(requests[0].payload.activeTaskId, "task_1");
    assertEquals(requests[0].payload.keptUserMessages, [{
      messageId: "user_existing",
      summary: "Inspect memory",
      taskIds: ["task_1"],
    }]);
    assertEquals(result.record.memory.memoryLibrary.length, 1);
    assertEquals(result.record.memory.memoryLibrary[0].source, "tool");
    assertEquals(result.record.memory.memoryLibrary[0].taskIds, ["task_1"]);
    assertEquals(result.record.memory.memoryLibrary[0].pointer?.toolName, "shell_exec");
  });
});

Deno.test("memory pipeline sends structured JSON tool output to chunk_batch", async () => {
  await withFakeMaintenanceUpstream(async ({ config, requests }) => {
    const searchResults = Array.from({ length: 180 }, (_, index) => ({
      title: `Result ${index + 1}`,
      url: `https://example.test/${index + 1}`,
      snippet: "x".repeat(120),
    }));

    await runMaintenancePass(
      {
        model: "gpt-5.4",
        input: [
          {
            type: "function_call",
            id: "call_search",
            call_id: "call_search",
            name: "web_search",
            arguments: '{"q":"pando proxy memory"}',
          },
          {
            type: "function_call_output",
            call_id: "call_search",
            output: JSON.stringify({ results: searchResults }),
          },
        ],
      },
      recordWithTask(),
      config,
      "Bearer codex-login-test",
      "gpt-5.4",
    );

    assertEquals(requests[0].schemaName, "chunk_batch");
    assert(Array.isArray(requests[0].payload.results[0].content.results));
    assertEquals(requests[0].payload.results[0].content.results.length, 180);
    assertEquals(
      requests[0].payload.results[0].content.results[179].url,
      "https://example.test/180",
    );
  });
});

Deno.test("memory pipeline calls assistant_memory and retention for assistant responses", async () => {
  await withFakeMaintenanceUpstream(async ({ config, requests }) => {
    const result = await runMaintenancePass(
      {
        model: "gpt-5.4",
        input: [{
          type: "message",
          role: "assistant",
          id: "msg_1",
          content: [{ type: "output_text", text: "The live e2e test passed." }],
        }],
      },
      recordWithTask(),
      config,
      "Bearer codex-login-test",
      "gpt-5.4",
    );

    assertEquals(requests.map((request) => request.schemaName), [
      "assistant_memory",
      "retention_decision",
    ]);
    assertEquals(requests[0].payload.responses[0].responseId, "assistant_msg_1");
    assertEquals(requests[0].payload.responses[0].text, "The live e2e test passed.");
    assertEquals(result.record.memory.memoryLibrary.length, 1);
    assertEquals(result.record.memory.memoryLibrary[0].source, "assistant");
    assertEquals(result.record.memory.memoryLibrary[0].kind, "assistant/test_result");
    assertEquals(result.record.memory.memoryLibrary[0].taskIds, ["task_1"]);
  });
});

Deno.test("memory pipeline updates tasks before classifying same-request tool outputs", async () => {
  await withFakeMaintenanceUpstream(async ({ config, requests }) => {
    const result = await runMaintenancePass(
      {
        model: "gpt-5.4",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Now inspect package metadata" }],
          },
          {
            type: "function_call",
            id: "call_2",
            call_id: "call_2",
            name: "read_file",
            arguments: '{"path":"package.json"}',
          },
          {
            type: "function_call_output",
            call_id: "call_2",
            output: '{"name":"pando-proxy"}',
          },
        ],
      },
      emptySessionRecord(),
      config,
      "Bearer codex-login-test",
      "gpt-5.4",
    );

    assertEquals(requests.map((request) => request.schemaName), [
      "task_update",
      "chunk_batch",
      "retention_decision",
    ]);
    assertEquals(requests[1].payload.activeTaskId, "task_1");
    assertEquals(requests[1].payload.tasks.map((task: Record<string, unknown>) => task.id), [
      "task_1",
    ]);
    assertEquals(result.record.memory.activeTaskId, "task_1");
    assertEquals(result.record.memory.memoryLibrary[0].taskIds, ["task_1"]);
  });
});

type RecordedMaintenanceRequest = {
  schemaName: string;
  body: Record<string, unknown>;
  payload: any;
};

async function withFakeMaintenanceUpstream(
  callback: (
    context: { config: ProxyConfig; requests: RecordedMaintenanceRequest[] },
  ) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const requests: RecordedMaintenanceRequest[] = [];
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const body = await request.json();
    const schemaName = String(body.text?.format?.name ?? "");
    const payload = parseMaintenancePayload(body);
    requests.push({ schemaName, body, payload });

    return new Response(
      JSON.stringify({
        output_text: JSON.stringify(maintenanceResponse(schemaName, payload)),
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  });

  try {
    await callback({
      requests,
      config: {
        host: "127.0.0.1",
        port: 8787,
        upstreamBaseUrl: `http://127.0.0.1:${upstream.addr.port}`,
        apiKey: null,
        maintenanceModel: null,
        stateDir: tempDir,
        syntheticCharBudget: 12_000,
        maintenanceTimeoutMs: 5_000,
        memoryEnabled: true,
        logFile: null,
      },
    });
  } finally {
    await upstream.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
}

function parseMaintenancePayload(body: any): any {
  return JSON.parse(body.input[0].content[0].text);
}

function maintenanceResponse(schemaName: string, payload: any): Record<string, unknown> {
  if (schemaName === "task_update") {
    return taskUpdateResponse(payload);
  }
  if (schemaName === "chunk_batch") {
    return chunkBatchResponse(payload);
  }
  if (schemaName === "assistant_memory") {
    return assistantMemoryResponse(payload);
  }
  if (schemaName === "retention_decision") {
    return retentionResponse(payload);
  }
  throw new Error(`Unexpected maintenance schema ${schemaName}`);
}

function taskUpdateResponse(payload: any): Record<string, unknown> {
  const nextTaskId = `task_${payload.previousSeq + 1}`;
  const tasksAfter = [
    ...payload.tasks,
    {
      id: nextTaskId,
      text: payload.latestUserMessage.text,
      status: "in_progress",
      kind: "do",
    },
  ];
  return {
    taskUpdateSeq: payload.previousSeq + 1,
    latestUserMessageId: payload.latestUserMessage.messageId,
    result: "changed",
    tasksAfter,
    activeTaskId: nextTaskId,
    existingTaskActions: payload.tasks.map((task: Record<string, unknown>) => ({
      id: task.id,
      action: "keep",
    })),
    userMessageActions: [
      ...payload.keptUserMessages.map((message: Record<string, unknown>) => ({
        messageId: message.messageId,
        action: "keep",
        taskIds: message.taskIds,
        summary: message.summary,
      })),
      {
        messageId: payload.latestUserMessage.messageId,
        action: "keep",
        taskIds: [nextTaskId],
        summary: payload.latestUserMessage.text,
      },
    ],
  };
}

function chunkBatchResponse(payload: any): Record<string, unknown> {
  return {
    chunks: payload.results.map((_result: unknown, index: number) => ({
      sourceResultIndex: index,
      title: `Tool result ${index + 1}`,
      summary: "Classified non-Pando tool output.",
      kind: "tool/classified",
      taskIds: defaultTaskIds(payload),
      pointer: { classifiedBy: "fake-maintenance-model" },
    })),
  };
}

function assistantMemoryResponse(payload: any): Record<string, unknown> {
  return {
    chunks: payload.responses.map((_response: unknown, index: number) => ({
      sourceResponseIndex: index,
      title: `Assistant response ${index + 1}`,
      summary: "Retained assistant outcome.",
      kind: "test_result",
      taskIds: defaultTaskIds(payload),
      pointer: { classifiedBy: "fake-maintenance-model" },
    })),
  };
}

function retentionResponse(payload: any): Record<string, unknown> {
  return {
    keep: payload.candidates.map((chunk: Record<string, unknown>) => ({
      id: chunk.id,
      taskIds: Array.isArray(chunk.taskIds) && chunk.taskIds.length > 0
        ? chunk.taskIds
        : defaultTaskIds(payload),
    })),
    drop: [],
  };
}

function defaultTaskIds(payload: any): string[] {
  if (typeof payload.activeTaskId === "string") {
    return [payload.activeTaskId];
  }
  return payload.tasks.length > 0 ? [payload.tasks[0].id] : [];
}

function recordWithTask(): SessionRecord {
  return {
    memory: stateWithTask(),
    handledInputIds: [],
  };
}

function stateWithTask(): MemoryState {
  return {
    taskUpdateSeq: 1,
    tasks: [{ id: "task_1", text: "Inspect memory", status: "in_progress", kind: "do" }],
    activeTaskId: "task_1",
    keptUserMessages: [{
      messageId: "user_existing",
      summary: "Inspect memory",
      taskIds: ["task_1"],
    }],
    memoryLibrary: [],
  };
}

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
