import { applyRetention, retainMemory, validateRetention } from "../src/retention.ts";
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

Deno.test("retention fails after invalid repair attempt instead of falling back", async () => {
  const state = stateWithTask();
  const candidates = chunks();
  let calls = 0;

  await assertRejects(
    () =>
      retainMemory(state, candidates, () => {
        calls += 1;
        return Promise.resolve({ keep: [], drop: [] });
      }),
    "Retention validation failed",
  );
  assertEquals(calls, 2);
});

Deno.test("retention retry succeeds when validation errors are fed back", async () => {
  const state = stateWithTask();
  const candidates = chunks();
  const requests: Array<{ hasValidationErrors: boolean; errors?: string[] }> = [];

  const next = await retainMemory(state, candidates, (request) => {
    requests.push({
      hasValidationErrors: Array.isArray(request.validationErrors) &&
        request.validationErrors.length > 0,
      errors: request.validationErrors,
    });
    if (requests.length === 1) {
      return Promise.resolve({
        keep: [{ id: "chunk_1", taskIds: ["task_1"] }],
        drop: [],
      });
    }
    return Promise.resolve({
      keep: [
        { id: "chunk_1", taskIds: ["task_1"] },
        { id: "chunk_2", taskIds: ["task_1"] },
      ],
      drop: [],
    });
  });

  assertEquals(requests.length, 2);
  assertEquals(requests[0].hasValidationErrors, false);
  assertEquals(requests[1].hasValidationErrors, true);
  assert(
    requests[1].errors?.some((message) => message.includes("chunk_2 missing")) ?? false,
    `retry request did not carry the candidate-missing validation error, got ${
      JSON.stringify(requests[1].errors)
    }`,
  );
  assertEquals(next.memoryLibrary.map((chunk) => chunk.id), ["chunk_1", "chunk_2"]);
});

Deno.test("retention retry repairs transposed chunk ids reported by the model", async () => {
  const state = stateWithTask();
  const candidates = chunks();
  let calls = 0;

  const next = await retainMemory(state, candidates, () => {
    calls += 1;
    if (calls === 1) {
      return Promise.resolve({
        keep: [
          { id: "chunk_1", taskIds: ["task_1"] },
          { id: "chnuk_2", taskIds: ["task_1"] },
        ],
        drop: [],
      });
    }
    return Promise.resolve({
      keep: [
        { id: "chunk_1", taskIds: ["task_1"] },
        { id: "chunk_2", taskIds: ["task_1"] },
      ],
      drop: [],
    });
  });

  assertEquals(calls, 2);
  assertEquals(next.memoryLibrary.map((chunk) => chunk.id), ["chunk_1", "chunk_2"]);
});

Deno.test("retention propagates maintenance call failures", async () => {
  const state = stateWithTask();
  const candidates = chunks();
  let calls = 0;

  await assertRejects(
    () =>
      retainMemory(state, candidates, () => {
        calls += 1;
        return Promise.reject(new Error("retention transport failed"));
      }),
    "retention transport failed",
  );
  assertEquals(calls, 1);
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

async function assertRejects(callback: () => Promise<unknown>, includes: string): Promise<void> {
  try {
    await callback();
  } catch (error) {
    assert(String(error).includes(includes), `Expected error containing ${includes}, got ${error}`);
    return;
  }
  throw new Error("Expected callback to reject");
}
