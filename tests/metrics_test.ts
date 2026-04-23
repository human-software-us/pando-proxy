import {
  extractUsageMetricsFromResponseText,
  METRICS_MARKER,
  requestContextMetrics,
  TokenUsageTracker,
} from "../src/metrics.ts";

Deno.test("usage metrics parse Responses SSE usage", () => {
  const usage = extractUsageMetricsFromResponseText([
    'event: response.output_text.delta\ndata: {"delta":"ok"}',
    "",
    'event: response.completed\ndata: {"response":{"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}',
    "",
  ].join("\n"));

  assertEquals(usage?.inputTokens, 11);
  assertEquals(usage?.outputTokens, 7);
  assertEquals(usage?.totalTokens, 18);
});

Deno.test("token usage tracker accumulates per session", () => {
  const tracker = new TokenUsageTracker();
  assertEquals(
    tracker.add("session_1", {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      raw: {},
    }),
    { responsesWithUsage: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  );
  assertEquals(
    tracker.add("session_1", {
      inputTokens: 3,
      outputTokens: 4,
      totalTokens: 7,
      raw: {},
    }),
    { responsesWithUsage: 2, inputTokens: 13, outputTokens: 9, totalTokens: 22 },
  );
});

Deno.test("request context metrics count transcript items", () => {
  const metrics = requestContextMetrics({
    model: "gpt-test",
    stream: true,
    input: [
      { type: "message", role: "developer", content: "rules" },
      { type: "message", role: "user", content: "hello" },
      { type: "function_call", name: "shell" },
      { type: "function_call_output", output: "world" },
    ],
  });

  assertEquals(metrics.model, "gpt-test");
  assertEquals(metrics.inputItemCount, 4);
  assertEquals(metrics.developerMessageCount, 1);
  assertEquals(metrics.userMessageCount, 1);
  assertEquals(metrics.toolCallCount, 1);
  assertEquals(metrics.toolOutputCount, 1);
  assertEquals(metrics.approxInputTokens !== undefined, true);
});

Deno.test("metrics marker is searchable", () => {
  assertEquals(METRICS_MARKER, "PANDO_PROXY_METRICS");
});

function assertEquals(actual: unknown, expected: unknown): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`Expected ${expectedJson}, got ${actualJson}`);
  }
}
