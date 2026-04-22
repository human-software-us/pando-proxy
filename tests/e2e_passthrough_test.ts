import { ProxyConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { SessionStore } from "../src/store.ts";

Deno.test("E2E pass-through mode forwards Codex-like request auth and SSE unchanged", async () => {
  const tempDir = await Deno.makeTempDir();
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
        'event: response.completed\ndata: {"response":{"id":"resp_1"}}',
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
    logFile: null,
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
        'event: response.completed\ndata: {"response":{"id":"resp_1"}}',
        "",
      ].join("\n"),
    );
    assertEquals(captured.authorization, "Bearer codex-existing-auth");
    assertEquals(captured.body, requestBody);
  } finally {
    await proxy.shutdown();
    await upstream.shutdown();
    await Deno.remove(tempDir, { recursive: true });
  }
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
