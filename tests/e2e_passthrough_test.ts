import { ProxyConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { SessionStore } from "../src/store.ts";

Deno.test("E2E pass-through mode forwards Codex-like request auth and SSE unchanged", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = `${tempDir}/proxy.jsonl`;
  const captured: {
    authorization: string | null;
    body: Record<string, unknown> | null;
  } = {
    authorization: null,
    body: null,
  };

  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    captured.authorization = request.headers.get("authorization");
    captured.body = await request.json();
    return new Response(
      [
        'event: response.output_text.delta\ndata: {"delta":"hello"}',
        "",
        'event: response.completed\ndata: {"response":{"id":"resp_1","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
        "",
      ].join("\n"),
      {
        headers: {
          "content-type": "text/event-stream",
          "x-upstream-test": "yes",
        },
      },
    );
  });

  const proxyConfig: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.addr.port}`,
    apiKey: null,
    smallStructuredModel: "gpt-4.1-mini",
    overflowStructuredModel: "gpt-5-mini",
    smallStructuredContextWindow: 32_000,
    overflowStructuredContextWindow: 128_000,
    modelTimeoutMs: 5_000,
    stateDir: tempDir,
    memoryEnabled: false,
    logFile,
    codexAutoCompactTokenLimit: 280_000,
  };
  const proxyHandler = createHandler(proxyConfig, new SessionStore(tempDir));
  const proxy = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, proxyHandler.handler);

  try {
    const requestBody = {
      model: "gpt-test",
      stream: true,
      store: false,
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Follow the rules." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Say hello." }],
        },
      ],
      reasoning: { effort: "low" },
      text: { format: { type: "text" } },
      tools: [],
    };

    const response = await fetch(`http://127.0.0.1:${proxy.addr.port}/v1/responses`, {
      method: "POST",
      headers: {
        "authorization": "Bearer codex-existing-auth",
        "content-type": "application/json",
        "x-pando-session-id": "e2e-session",
      },
      body: JSON.stringify(requestBody),
    });

    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), "text/event-stream");
    assertEquals(response.headers.get("x-upstream-test"), "yes");
    assertEquals(
      await response.text(),
      [
        'event: response.output_text.delta\ndata: {"delta":"hello"}',
        "",
        'event: response.completed\ndata: {"response":{"id":"resp_1","usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16}}}',
        "",
      ].join("\n"),
    );
    assertEquals(captured.authorization, "Bearer codex-existing-auth");
    assertEquals(captured.body, requestBody);

    const logEntries = await waitForLogEvent(logFile, "incoming_request");
    const incomingMetrics = logEntries.find((entry) => entry.event === "incoming_request");
    assert(typeof incomingMetrics?.ts === "string");
    assertEquals(incomingMetrics?.userMessageCount, 1);
    assertEquals(incomingMetrics?.memoryEnabled, false);
  } finally {
    await proxy.shutdown();
    await upstream.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("E2E full logging captures synthetic memory, structured, task switch, and recall flows", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = `${tempDir}/proxy.jsonl`;
  const sessionKey = "synthetic-data-flow";
  const structuredClassifiers: string[] = [];

  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const body = await request.json();
    const classifier = structuredClassifier(body);
    if (classifier) {
      structuredClassifiers.push(classifier);
      return structuredResponse(classifier, body);
    }
    return mainModelResponse(body);
  });

  const proxyConfig: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.addr.port}`,
    apiKey: null,
    smallStructuredModel: "gpt-4.1-mini",
    overflowStructuredModel: "gpt-5-mini",
    smallStructuredContextWindow: 32_000,
    overflowStructuredContextWindow: 128_000,
    modelTimeoutMs: 5_000,
    stateDir: tempDir,
    memoryEnabled: true,
    logFile,
    codexAutoCompactTokenLimit: 280_000,
  };
  const store = new SessionStore(tempDir);
  const proxyHandler = createHandler(proxyConfig, store);
  const proxy = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, proxyHandler.handler);

  try {
    await postProxyRound(proxy.addr.port, sessionKey, [
      developerMessage("Follow synthetic logging test instructions."),
      userMessage([
        "Task A: keep this exact block.",
        "BEGIN_EXACT",
        "SECRET_ALPHA=alpha-123",
        "PATH=src/auth/session.ts",
        "END_EXACT",
      ].join("\n")),
    ]);
    await proxyHandler.awaitIdle();

    await postProxyRound(proxy.addr.port, sessionKey, [
      developerMessage("Follow synthetic logging test instructions."),
      userMessage("New unrelated task: current UI task, remember THEME_BETA=blue."),
    ]);
    await proxyHandler.awaitIdle();

    await postProxyRound(proxy.addr.port, sessionKey, [
      developerMessage("Follow synthetic logging test instructions."),
      userMessage("Return to previous task and recover the archived exact value with recall."),
    ]);
    await proxyHandler.awaitIdle();

    const entries = await waitForLogEvent(logFile, "archive_recall");
    const eventNames = entries.map((entry) => entry.event);
    assert(!eventNames.includes("memory_update_failed"), "memory update should not fail");
    for (
      const required of [
        "incoming_request",
        "materialized_memory_loaded",
        "rewritten_context",
        "upstream_loop_iteration",
        "upstream_request",
        "upstream_response",
        "structured_model_request",
        "structured_model_response",
        "memory_update_inputs",
        "memory_round_sources",
        "memory_round_chunked",
        "memory_round_decision",
        "memory_state_saved",
        "archive_recall",
        "round_complete",
      ]
    ) {
      assert(eventNames.includes(required), `missing log event ${required}`);
    }

    assert(structuredClassifiers.includes("source_chunk_batch"));
    assert(structuredClassifiers.includes("piece_drop_batch"));
    assert(structuredClassifiers.includes("task_route"));

    const incoming = entries.find((entry) => entry.event === "incoming_request");
    assert(incoming?.body, "incoming request body was not logged");

    const structuredRequest = entries.find((entry) =>
      entry.event === "structured_model_request" && entry.classifier === "piece_drop_batch"
    );
    assert(structuredRequest?.requestBody, "structured model request body was not logged");
    assertEquals(
      (structuredRequest.requestHeaders as Record<string, unknown>).authorization,
      "[redacted]",
    );

    const sourceLog = entries.find((entry) => entry.event === "memory_round_sources");
    const sourcePayloadText = JSON.stringify(sourceLog?.sources ?? []);
    assert(
      sourcePayloadText.includes("SECRET_ALPHA=alpha-123"),
      "source payload missing exact user data",
    );

    const decisionLog = entries.find((entry) => entry.event === "memory_round_decision");
    assert(Array.isArray(decisionLog?.pruneCandidatePieceIds));
    assert(Array.isArray(decisionLog?.acceptedPruneDropPieceIds));
    assert(Array.isArray(decisionLog?.sanityRejectedDropPieceIds));

    const chunkLog = entries.find((entry) =>
      entry.event === "memory_round_chunked" &&
      Number(entry.chunkedDeterministicSourceCount ?? 0) > 0
    );
    assert(chunkLog, "deterministic tool chunking was not exercised");
    assert(JSON.stringify(chunkLog.pieces).includes("src/auth/session.ts"));

    const rewriteWithMemory = entries.find((entry) =>
      entry.event === "rewritten_context" && entry.insertedMemory === true
    );
    assert(rewriteWithMemory?.rewrittenBody, "rewritten memory prompt body was not logged");

    const loopWithRecallOutput = entries.find((entry) =>
      entry.event === "upstream_loop_iteration" && Number(entry.loopOutputCount ?? 0) > 0
    );
    assert(loopWithRecallOutput?.requestBody, "recall loop request body was not logged");

    const recallLog = entries.find((entry) => entry.event === "archive_recall");
    assert(recallLog?.returnedSources, "archive recall returned sources were not logged");
    assert(JSON.stringify(recallLog.returnedSources).includes("SECRET_ALPHA=alpha-123"));

    const memoryUpdateInputs = entries.find((entry) => entry.event === "memory_update_inputs");
    assert(memoryUpdateInputs?.loopFinalBody, "memory update final response body was not logged");
    assert(
      memoryUpdateInputs?.materializedPriorPieces,
      "materialized prior pieces were not logged",
    );

    const state = await store.load(sessionKey);
    assert(state.memory.activeTask, "active task should exist after synthetic rounds");
    assert(
      state.memory.archivedTasks.length >= 1,
      "task switch/revive should leave an archived bundle",
    );
  } finally {
    await proxy.shutdown();
    await upstream.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await Deno.readTextFile(path);
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForLogEvent(
  path: string,
  event: string,
): Promise<Array<Record<string, unknown>>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    const entries = await readJsonl(path).catch(() => []);
    if (entries.some((entry) => entry.event === event)) {
      return entries;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return await readJsonl(path);
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

async function postProxyRound(
  port: number,
  sessionKey: string,
  input: Record<string, unknown>[],
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST",
    headers: {
      "authorization": "Bearer codex-existing-auth",
      "content-type": "application/json",
      "x-pando-session-id": sessionKey,
    },
    body: JSON.stringify({
      model: "gpt-test",
      stream: false,
      store: false,
      input,
      reasoning: { effort: "low" },
      text: { format: { type: "text" } },
      tools: [],
    }),
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`Expected 200, got ${response.status}: ${text}`);
  }
  return text;
}

function developerMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "developer",
    content: [{ type: "input_text", text }],
  };
}

function userMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function structuredClassifier(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const text = (body as Record<string, unknown>).text;
  if (!text || typeof text !== "object" || Array.isArray(text)) {
    return null;
  }
  const format = (text as Record<string, unknown>).format;
  if (!format || typeof format !== "object" || Array.isArray(format)) {
    return null;
  }
  const name = (format as Record<string, unknown>).name;
  return typeof name === "string" ? name : null;
}

function structuredResponse(classifier: string, body: Record<string, unknown>): Response {
  const payload = structuredPayload(body);
  let value: Record<string, unknown>;
  if (classifier === "source_chunk_batch") {
    const sources = parseStructuredChunkSources(payload);
    const returnedSources = sources.length > 1 ? sources.slice(0, -1) : sources;
    value = {
      results: returnedSources.map((source) => {
        const start = source.contentText.indexOf("BEGIN_EXACT");
        const endMarker = "END_EXACT";
        const end = source.contentText.indexOf(endMarker);
        return {
          sourceId: source.sourceId,
          selectors: start >= 0 && end >= start
            ? [{
              kind: "chunks",
              chunks: [{ text: source.contentText.slice(start, end + endMarker.length) }],
            }]
            : [{ kind: "whole" }],
        };
      }),
    };
  } else if (classifier === "task_route") {
    value = payload.includes("New unrelated task")
      ? { kind: "new_task", relativeIndex: 0 }
      : payload.includes("Return to previous task")
      ? { kind: "revive_task", relativeIndex: -1 }
      : { kind: "same_task", relativeIndex: 0 };
  } else if (classifier === "piece_drop_batch") {
    const request = JSON.parse(payload) as {
      activeTask: { startedRound?: number } | null;
      taskRoute: { kind?: string };
      evaluatedPieces: Array<{ id: string; contentText: string; createdSeq?: number }>;
    };
    value = {
      defaultDecision: { drop: false, reason: null },
      overrides: request.evaluatedPieces
        .filter((piece) =>
          piece.contentText.includes("ACK transient") ||
          (request.taskRoute.kind === "new_task" &&
            typeof request.activeTask?.startedRound === "number" &&
            typeof piece.createdSeq === "number" &&
            piece.createdSeq < request.activeTask.startedRound)
        )
        .map((piece) => ({
          pieceId: piece.id,
          drop: true,
          reason: piece.contentText.includes("ACK transient")
            ? "pure_ack_or_chatter"
            : "old_task_after_confirmed_task_switch",
        })),
    };
  } else {
    value = {};
  }
  return jsonResponse({
    id: `structured_${classifier}`,
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    }],
    usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
  });
}

function parseStructuredChunkSources(
  payload: string,
): Array<{ sourceId: string; contentText: string }> {
  const sources: Array<{ sourceId: string; contentText: string }> = [];
  const pattern =
    /<source sourceId=("[^"]+") sourceKind="[^"]+"(?: toolName="[^"]+")? length=\d+>\n<raw_source_body>\n([\s\S]*?)\n<\/raw_source_body>\n<\/source>/g;
  for (const match of payload.matchAll(pattern)) {
    sources.push({
      sourceId: JSON.parse(match[1]) as string,
      contentText: match[2],
    });
  }
  return sources;
}

function structuredPayload(body: Record<string, unknown>): string {
  const input = body.input;
  if (!Array.isArray(input)) {
    return "{}";
  }
  const first = input[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return "{}";
  }
  const content = (first as Record<string, unknown>).content;
  if (!Array.isArray(content)) {
    return "{}";
  }
  const part = content[0];
  if (!part || typeof part !== "object" || Array.isArray(part)) {
    return "{}";
  }
  const text = (part as Record<string, unknown>).text;
  return typeof text === "string" ? text : "{}";
}

function mainModelResponse(body: Record<string, unknown>): Response {
  const text = JSON.stringify(body.input);
  if (text.includes("function_call_output") && text.includes("recall_call_1")) {
    return jsonResponse({
      id: "main_after_recall",
      output: [
        assistantMessage("msg_after_recall", "Recovered SECRET_ALPHA=alpha-123 from recall."),
      ],
      usage: { input_tokens: 55, output_tokens: 8, total_tokens: 63 },
    });
  }
  if (text.includes("recover the archived exact value")) {
    return jsonResponse({
      id: "main_recall_request",
      output: [{
        id: "recall_call_item",
        type: "function_call",
        name: "recall",
        call_id: "recall_call_1",
        arguments: JSON.stringify({ offset: 0, limit: 10 }),
      }],
      usage: { input_tokens: 45, output_tokens: 6, total_tokens: 51 },
    });
  }
  if (text.includes("New unrelated task")) {
    return jsonResponse({
      id: "main_new_task",
      output: [
        assistantMessage("msg_new_task", "Current UI task stored: THEME_BETA=blue."),
      ],
      usage: { input_tokens: 25, output_tokens: 7, total_tokens: 32 },
    });
  }
  return jsonResponse({
    id: "main_initial",
    output: [
      assistantMessage("msg_initial_ack", "ACK transient. I will inspect the indexed nodes."),
      {
        id: "reason_initial",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Need exact block and search result." }],
      },
      {
        id: "tool_call_exec",
        type: "function_call",
        name: "exec_command",
        call_id: "call_exec_1",
        arguments: JSON.stringify({ cmd: "sed -n '1,20p' src/auth/session.ts" }),
      },
      {
        id: "tool_output_exec",
        type: "function_call_output",
        call_id: "call_exec_1",
        output:
          "Chunk ID: abc\nWall time: 0.01\nOutput:\nexport const SECRET_ALPHA = 'alpha-123';\n",
      },
      {
        id: "tool_call_pando",
        type: "function_call",
        name: "mcp__pando__find_nodes",
        call_id: "call_pando_1",
        arguments: JSON.stringify({ query: "SECRET_ALPHA" }),
      },
      {
        id: "tool_output_pando",
        type: "function_call_output",
        call_id: "call_pando_1",
        output: {
          results: [
            { path: "src/auth/session.ts", symbol: "SECRET_ALPHA", score: 0.99 },
            { path: "test/auth/session_test.ts", symbol: "session-test", score: 0.75 },
          ],
        },
      },
    ],
    usage: { input_tokens: 30, output_tokens: 20, total_tokens: 50 },
  });
}

function assistantMessage(id: string, text: string): Record<string, unknown> {
  return {
    id,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
