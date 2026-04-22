import { applyRetention, validateRetention } from "../src/retention.ts";
import { MemoryChunk, MemoryState } from "../src/memory_state.ts";

Deno.test("retention validation requires every candidate exactly once", () => {
  const state = stateWithTask();
  const candidates = chunks();

  const errors = validateRetention(
    { keep: [{ id: "chunk_1", taskIds: ["task_1"] }], drop: [] },
    candidates,
    state,
  );

  assert(errors.some((error) => error.includes("chunk_2 missing")));
});

Deno.test("retention apply keeps only selected chunks with live task ids", () => {
  const state = stateWithTask();
  const [first, second] = chunks();
  const next = applyRetention(
    state,
    [first, second],
    { keep: [{ id: "chunk_2", taskIds: ["task_1"] }], drop: ["chunk_1"] },
  );

  assertEquals(next.memoryLibrary.map((chunk) => chunk.id), ["chunk_2"]);
  assertEquals(next.memoryLibrary[0].taskIds, ["task_1"]);
});

function stateWithTask(): MemoryState {
  return {
    taskUpdateSeq: 1,
    tasks: [{ id: "task_1", text: "Do work", status: "in_progress", kind: "do" }],
    activeTaskId: "task_1",
    keptUserMessages: [],
    memoryLibrary: [],
  };
}

function chunks(): MemoryChunk[] {
  return [
    { id: "chunk_1", title: "one", summary: "one", kind: "tool", taskIds: ["task_1"] },
    { id: "chunk_2", title: "two", summary: "two", kind: "tool", taskIds: ["task_1"] },
  ];
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
