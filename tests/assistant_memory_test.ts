import {
  chunkAssistantResponses,
  validateAssistantMemoryResponse,
} from "../src/assistant_memory.ts";
import { MemoryState } from "../src/memory_state.ts";

Deno.test("assistant memory validation requires live task ids", () => {
  const result = validateAssistantMemoryResponse(
    {
      chunks: [{
        sourceResponseIndex: 0,
        title: "Decision",
        summary: "Use the wrapper provider override.",
        kind: "decision",
        taskIds: ["missing_task"],
      }],
    },
    [{ responseId: "assistant_1", text: "Use the wrapper provider override." }],
    state(),
  );

  assert(!result.ok);
  assert(result.errors.some((error) => error.includes("missing task")));
});

Deno.test("assistant responses materialize task-linked chunks", async () => {
  const chunks = await chunkAssistantResponses(
    [{ responseId: "assistant_1", text: "The live test passed with stream end." }],
    state(),
    () =>
      Promise.resolve({
        chunks: [{
          sourceResponseIndex: 0,
          title: "Live test result",
          summary: "The live test passed with stream end.",
          kind: "test_result",
          taskIds: ["task_1"],
        }],
      }),
  );

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].source, "assistant");
  assertEquals(chunks[0].kind, "assistant/test_result");
  assertEquals(chunks[0].taskIds, ["task_1"]);
  assertEquals(chunks[0].pointer?.sourceResponseId, "assistant_1");
});

Deno.test("assistant response review allows one request for extra context", async () => {
  const calls: unknown[] = [];
  const chunks = await chunkAssistantResponses(
    [{ responseId: "assistant_1", text: "That failed because of the previous tool result." }],
    {
      ...state(),
      memoryLibrary: [{
        id: "chunk_tool",
        title: "Tool result",
        summary: "The tool returned a permission error.",
        kind: "tool/error",
        taskIds: ["task_1"],
        source: "tool",
      }],
    },
    (request) => {
      calls.push(request);
      if (!request.infoRequestAttempt) {
        return Promise.resolve({
          needsMoreInfo: true,
          requestedInfo: [{
            type: "all_memory_chunks",
            id: null,
            reason: "Need the referenced previous tool result.",
          }],
        });
      }
      assertEquals(request.extraContext[0].type, "all_memory_chunks");
      return Promise.resolve({
        needsMoreInfo: false,
        requestedInfo: [],
        chunks: [{
          sourceResponseIndex: 0,
          title: "Permission error diagnosis",
          summary: "Assistant connected the failure to the prior permission error.",
          kind: "diagnosis",
          taskIds: ["task_1"],
          pointer: null,
        }],
      });
    },
  );

  assertEquals(calls.length, 2);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].kind, "assistant/diagnosis");
});

Deno.test("assistant response review fails if model requests info twice", async () => {
  let threw = false;
  try {
    await chunkAssistantResponses(
      [{ responseId: "assistant_1", text: "Need previous context." }],
      state(),
      () =>
        Promise.resolve({
          needsMoreInfo: true,
          requestedInfo: [{
            type: "all_memory_chunks",
            id: null,
            reason: "Need context.",
          }],
        }),
    );
  } catch (error) {
    threw = String(error).includes("single allowed request");
  }
  assert(threw);
});

function state(): MemoryState {
  return {
    taskUpdateSeq: 1,
    tasks: [{ id: "task_1", text: "Implement memory", status: "in_progress", kind: "do" }],
    activeTaskId: "task_1",
    keptUserMessages: [],
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
