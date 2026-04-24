import type { ProxyConfig } from "../src/config.ts";
import { createHandler } from "../src/server.ts";
import { SessionStore } from "../src/store.ts";

Deno.test("E2E constraint pins survive bad retention decisions and stay inline next round", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = `${tempDir}/proxy.jsonl`;
  const config = testConfig(tempDir, logFile);
  const store = new SessionStore(tempDir, config.inlinePieceByteLimit);
  const upstreamBodies: Record<string, unknown>[] = [];
  const originalFetch = globalThis.fetch;
  let workingMemoryUpdateCalls = 0;

  globalThis.fetch = async (_input, init) => {
    await Promise.resolve();
    const body = JSON.parse(String((init as RequestInit | undefined)?.body ?? "{}"));
    const formatName = body?.text?.format?.name;

    if (formatName === "source_chunk") {
      return jsonResponse({
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: '{"chunks":[{"kind":"whole"}]}' }],
        }],
      });
    }

    if (formatName === "working_memory_update") {
      workingMemoryUpdateCalls += 1;
      const request = JSON.parse(String(body?.input?.[0]?.content?.[0]?.text ?? "{}"));

      if (workingMemoryUpdateCalls <= 3) {
        return jsonResponse({
          output: [{
            type: "message",
            role: "assistant",
            content: [{
              type: "output_text",
              text: JSON.stringify({
                objectiveAfter: "Continue the logging fix without changing auth.",
                keepOldChunkIds: [],
                keepNewChunkIds: [],
              }),
            }],
          }],
        });
      }

      return jsonResponse({
        output: [{
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              objectiveAfter: "Continue the logging fix without changing auth.",
              keepOldChunkIds: (request.chunks as Array<{ id: string }>).map((chunk) => chunk.id),
              keepNewChunkIds: [],
            }),
          }],
        }],
      });
    }

    upstreamBodies.push(body);
    const round = upstreamBodies.length;
    return jsonResponse({
      id: `resp_${round}`,
      output: [{
        id: `assistant_msg_${round}`,
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: round === 1
            ? "I will inspect the logging path."
            : "Continuing with the logging fix.",
        }],
      }],
      usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
    });
  };

  try {
    const { handler, awaitIdle } = createHandler(config, store);

    const roundOneResponse = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer test",
          "x-pando-session-id": "constraint-session",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: [{
            id: "user_round_1",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Fix the logging, but don't touch auth." }],
          }],
        }),
      }),
    );

    assertEquals(roundOneResponse.status, 200);
    await roundOneResponse.json();
    await awaitIdle();

    const roundOneDecision = await waitForLogEvent(logFile, "memory_round_decision");
    const forcedKeepOldChunkIds = Array.isArray(roundOneDecision.forcedKeepOldChunkIds)
      ? roundOneDecision.forcedKeepOldChunkIds
      : [];
    const forcedKeepNewChunkIds = Array.isArray(roundOneDecision.forcedKeepNewChunkIds)
      ? roundOneDecision.forcedKeepNewChunkIds
      : [];
    assertEquals(forcedKeepOldChunkIds, []);
    assert(forcedKeepNewChunkIds.length >= 1);
    assertMatch(JSON.stringify(roundOneDecision.forcedKeepReasons), /constraint_negative_change/);

    const storedAfterRoundOne = await store.load("constraint-session");
    assertEquals(storedAfterRoundOne.memory.chunks.length, 2);
    assertMatch(JSON.stringify(storedAfterRoundOne.memory.chunks), /don't touch auth/i);

    const roundTwoResponse = await handler(
      new Request("http://127.0.0.1/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": "Bearer test",
          "x-pando-session-id": "constraint-session",
        },
        body: JSON.stringify({
          model: "gpt-5.4",
          input: [{
            id: "user_round_2",
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Continue the fix." }],
          }],
        }),
      }),
    );

    assertEquals(roundTwoResponse.status, 200);
    await roundTwoResponse.json();
    await awaitIdle();

    assertEquals(upstreamBodies.length, 2);
    const rewrittenRoundTwo = upstreamBodies[1];
    assertMatch(JSON.stringify(rewrittenRoundTwo.input), /don't touch auth/i);
    assertEquals(
      (rewrittenRoundTwo.tools as Array<Record<string, unknown>>).some((tool) =>
        tool.name === "memory"
      ),
      true,
    );
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

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await Deno.readTextFile(path);
  return text.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForLogEvent(path: string, event: string): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    const entries = await readJsonl(path).catch(() => []);
    const match = entries.find((entry) => entry.event === event);
    if (match) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  const entries = await readJsonl(path);
  const match = entries.find((entry) => entry.event === event);
  if (!match) {
    throw new Error(`Expected log event ${event}`);
  }
  return match;
}

function testConfig(stateDir: string, logFile: string): ProxyConfig {
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
    logFile,
    inlinePieceByteLimit: 4_096,
    piecePreviewCharLimit: 80,
    maxIndexedPiecesPerTask: 1,
    maxLocalContextToolCalls: 3,
    codexAutoCompactTokenLimit: 280_000,
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

function assertMatch(actual: string, expected: RegExp): void {
  if (!expected.test(actual)) {
    throw new Error(`Expected ${JSON.stringify(actual)} to match ${String(expected)}`);
  }
}
