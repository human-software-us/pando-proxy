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
    maintenanceModel: null,
    stateDir: tempDir,
    syntheticCharBudget: 4_000,
    maintenanceTimeoutMs: 5_000,
    memoryEnabled: false,
    logFile,
  };
  const proxy = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, createHandler(proxyConfig, new SessionStore(tempDir)));

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

    const logEntries = await waitForLogEvent(logFile, "pando_proxy_metrics_upstream_response");
    const incomingMetrics = logEntries.find((entry) =>
      entry.event === "pando_proxy_metrics_incoming_context"
    );
    const responseMetrics = logEntries.find((entry) =>
      entry.event === "pando_proxy_metrics_upstream_response"
    );
    assert(typeof incomingMetrics?.ts === "string");
    assertEquals(incomingMetrics?.marker, "PANDO_PROXY_METRICS");
    assertEquals(incomingMetrics?.userMessageCount, 1);
    assert(typeof responseMetrics?.ts === "string");
    assertEquals(responseMetrics?.marker, "PANDO_PROXY_METRICS");
    assertEquals(responseMetrics?.termination, "end");
    assertEquals(responseMetrics?.actualTotalTokens, 16);
    assertEquals(responseMetrics?.cumulativeUsage, {
      responsesWithUsage: 1,
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
    });
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
