import { assertEquals, assertRejects } from "@std/assert";

import type { ProxyConfig } from "../src/config.ts";
import { createStructuredClients } from "../src/structured_model.ts";

Deno.test("structured model selection uses full GPT-5.4 for source chunks and small model for route/prune", async () => {
  const requests: Array<{ classifier: string | null; body: Record<string, unknown> }> = [];
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const body = await request.json() as Record<string, unknown>;
    const classifier = structuredClassifier(body);
    requests.push({ classifier, body });
    return jsonStructuredResponse(responseForClassifier(classifier));
  });

  const selections: Array<{ classifier: string; chosenModel: string; selectionReason: string }> =
    [];
  const config: ProxyConfig = {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.addr.port}`,
    apiKey: null,
    smallStructuredModel: "gpt-5.4-mini",
    overflowStructuredModel: "gpt-5.4",
    smallStructuredContextWindow: 400_000,
    overflowStructuredContextWindow: 1_047_576,
    modelTimeoutMs: 5_000,
    stateDir: "/tmp/pando-proxy-test",
    memoryEnabled: true,
    logFile: null,
    codexAutoCompactTokenLimit: 280_000,
  };
  const clients = createStructuredClients(
    config,
    "codex-request-model",
    "Bearer sk-test",
    (selection) => {
      selections.push({
        classifier: selection.classifier,
        chosenModel: selection.chosenModel,
        selectionReason: selection.selectionReason,
      });
    },
  );

  try {
    await clients.taskRoute({
      activeTask: null,
      activePieces: [],
      archivePage: { offset: 0, pageSize: 5, hasMore: false, nextRelativeIndex: null },
      archivedTasks: [],
      newUserPieces: [],
    });
    await clients.pieceDropBatch({
      activeTask: null,
      taskRoute: { kind: "same_task" },
      latestUserPieces: [],
      sharedUserPieces: [],
      candidateManifest: [],
      evaluatedPieces: [{
        id: "p1",
        sourceKind: "tool",
        sourceId: "s1",
        createdSeq: 1,
        byteSize: 5,
        contentText: "alpha",
      }],
    });
    await clients.sourceChunkBatch({
      sources: [{
        sourceId: "s1",
        sourceKind: "tool",
        contentText: "alpha\nbeta\n",
      }],
    });
  } finally {
    await upstream.shutdown();
  }

  assertEquals(
    selections.map((selection) => [
      selection.classifier,
      selection.chosenModel,
      selection.selectionReason,
    ]),
    [
      ["task_route", "gpt-5.4-mini", "fits_small_window"],
      ["piece_drop_batch", "gpt-5.4-mini", "fits_small_window"],
      ["source_chunk_batch", "gpt-5.4", "forced_source_chunk_full_model"],
    ],
  );

  const bodiesByClassifier = new Map(requests.map((request) => [request.classifier, request.body]));
  assertEquals(bodiesByClassifier.get("task_route")?.model, "gpt-5.4-mini");
  assertEquals(bodiesByClassifier.get("piece_drop_batch")?.model, "gpt-5.4-mini");
  assertEquals(bodiesByClassifier.get("source_chunk_batch")?.model, "gpt-5.4");
  assertEquals(bodiesByClassifier.get("task_route")?.reasoning, undefined);
  assertEquals(bodiesByClassifier.get("piece_drop_batch")?.reasoning, undefined);
  assertEquals(bodiesByClassifier.get("source_chunk_batch")?.reasoning, { effort: "low" });
  assertEquals(bodiesByClassifier.get("task_route")?.service_tier, undefined);
  assertEquals(bodiesByClassifier.get("piece_drop_batch")?.service_tier, undefined);
  assertEquals(bodiesByClassifier.get("source_chunk_batch")?.service_tier, "priority");
});

Deno.test("source_chunk_batch rejects chunks that do not join to the source text", async () => {
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, () =>
    jsonStructuredResponse({
      results: [{
        sourceId: "s1",
        chunks: ["alpha", "MISSING"],
      }],
    }));
  const clients = createStructuredClients(
    testConfig(`http://127.0.0.1:${upstream.addr.port}`),
    "codex-request-model",
    "Bearer sk-test",
  );

  try {
    await assertRejects(
      () =>
        clients.sourceChunkBatch({
          sources: [{ sourceId: "s1", sourceKind: "tool", contentText: "alpha\nbeta\n" }],
        }),
      Error,
      "must join exactly to the source text",
    );
  } finally {
    await upstream.shutdown();
  }
});

Deno.test("source_chunk_batch overflow fallback returns one whole verbatim chunk per source", async () => {
  const clients = createStructuredClients(
    {
      ...testConfig("http://127.0.0.1:1"),
      overflowStructuredContextWindow: 1,
    },
    "codex-request-model",
    "Bearer sk-test",
  );

  const result = await clients.sourceChunkBatch({
    sources: [
      { sourceId: "s1", sourceKind: "tool", contentText: "alpha\nbeta\n" },
      { sourceId: "s2", sourceKind: "assistant", contentText: "gamma\n" },
    ],
  });

  assertEquals(result, {
    results: [
      { sourceId: "s1", chunks: ["alpha\nbeta\n"] },
      { sourceId: "s2", chunks: ["gamma\n"] },
    ],
  });
});

function structuredClassifier(body: Record<string, unknown>): string | null {
  const text = body.text;
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

function responseForClassifier(classifier: string | null): Record<string, unknown> {
  if (classifier === "task_route") {
    return { kind: "same_task", relativeIndex: 0 };
  }
  if (classifier === "piece_drop_batch") {
    return {
      defaultDecision: { drop: false, reason: null },
      overrides: [],
    };
  }
  if (classifier === "source_chunk_batch") {
    return {
      results: [{
        sourceId: "s1",
        chunks: ["alpha\n", "beta\n"],
      }],
    };
  }
  return {};
}

function testConfig(upstreamBaseUrl: string): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl,
    apiKey: null,
    smallStructuredModel: "gpt-5.4-mini",
    overflowStructuredModel: "gpt-5.4",
    smallStructuredContextWindow: 400_000,
    overflowStructuredContextWindow: 1_047_576,
    modelTimeoutMs: 5_000,
    stateDir: "/tmp/pando-proxy-test",
    memoryEnabled: true,
    logFile: null,
    codexAutoCompactTokenLimit: 280_000,
  };
}

function jsonStructuredResponse(value: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      id: "resp_test",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
    {
      headers: { "content-type": "application/json" },
    },
  );
}
