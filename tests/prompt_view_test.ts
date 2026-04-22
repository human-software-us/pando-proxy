import { buildSyntheticMemoryText, rewriteRequestWithMemory } from "../src/prompt_view.ts";
import { MemoryState } from "../src/memory_state.ts";

Deno.test("prompt view includes live tasks and retained chunks", () => {
  const text = buildSyntheticMemoryText(state(), 4_000);

  assert(text?.includes("<context_memory>"));
  assert(text?.includes("task_1"));
  assert(text?.includes("Useful fact"));
});

Deno.test("request rewrite inserts exactly one synthetic memory item after instructions", () => {
  const body = {
    model: "test-model",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "work" }] },
    ],
    stream: true,
  };

  const rewritten = rewriteRequestWithMemory(body, state(), 4_000);
  const input = rewritten.input as Array<Record<string, unknown>>;

  assertEquals(input.length, 3);
  assertEquals(input[0].role, "developer");
  assertEquals(input[1].role, "user");
  assert(String(JSON.stringify(input[1])).includes("<context_memory>"));
  assertEquals(rewritten.model, "test-model");
  assertEquals(rewritten.stream, true);
});

function state(): MemoryState {
  return {
    taskUpdateSeq: 1,
    tasks: [{ id: "task_1", text: "Implement proxy", status: "in_progress", kind: "do" }],
    activeTaskId: "task_1",
    keptUserMessages: [{ messageId: "user_1", summary: "Implement it", taskIds: ["task_1"] }],
    memoryLibrary: [{
      id: "chunk_1",
      title: "Useful fact",
      summary: "The proxy must stream SSE unchanged.",
      kind: "tool",
      taskIds: ["task_1"],
      pointer: { toolName: "rg" },
    }],
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
