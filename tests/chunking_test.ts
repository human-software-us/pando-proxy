import { chunkPandoInCode } from "../src/chunking.ts";
import { MemoryState } from "../src/memory_state.ts";
import { ToolResultEnvelope } from "../src/tool_results.ts";

Deno.test("pando find_nodes creates one chunk per node match", async () => {
  const chunks = await chunkPandoInCode(
    {
      id: "tool_1",
      origin: "mcp",
      toolName: "pando__find_nodes",
      content: {
        nodes: [{ name: "foo", path: "src/foo.ts" }, { name: "bar", path: "src/bar.ts" }],
      },
      activeTaskId: "task_1",
    },
    state(),
  );

  assertEquals(chunks.length, 2);
  assertEquals(chunks.map((chunk) => chunk.kind), ["pando/find_nodes", "pando/find_nodes"]);
  assertEquals(chunks[0].taskIds, ["task_1"]);
});

Deno.test("pando mutating tool creates a compact operation-summary chunk", async () => {
  const result: ToolResultEnvelope = {
    id: "tool_2",
    origin: "mcp",
    toolName: "pando__replace",
    content: { changedFiles: ["src/main.ts"] },
    activeTaskId: "task_1",
  };

  const chunks = await chunkPandoInCode(result, state());

  assertEquals(chunks.length, 1);
  assert(chunks[0].kind.includes("mutation"));
  assert(chunks[0].summary.includes("src/main.ts"));
});

function state(): MemoryState {
  return {
    taskUpdateSeq: 1,
    tasks: [{ id: "task_1", text: "Implement", status: "in_progress", kind: "do" }],
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
