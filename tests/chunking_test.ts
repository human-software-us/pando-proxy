import { chunkNonPandoInBatches, chunkPandoInCode } from "../src/chunking.ts";
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

Deno.test("pando find_nodes handles nested pando result envelopes", async () => {
  const chunks = await chunkPandoInCode(
    {
      id: "tool_nested",
      origin: "mcp",
      toolName: "find_nodes",
      content: {
        success: true,
        data: {
          results: [
            { name: "pandoLiveValue", file_path: "tests/pando_live_chunk_fixture.ts" },
            { name: "pandoLiveCaller", file_path: "tests/pando_live_chunk_fixture.ts" },
          ],
          page: { limit: 5, offset: 0, hasMore: false },
        },
      },
      activeTaskId: "task_1",
    },
    state(),
  );

  assertEquals(chunks.length, 2);
  assertEquals(chunks.map((chunk) => chunk.kind), ["pando/find_nodes", "pando/find_nodes"]);
  assert(chunks[0].summary.includes("pandoLiveValue"));
});

Deno.test("pando analysis pointer chunks preserve nested pagination", async () => {
  const chunks = await chunkPandoInCode(
    {
      id: "tool_page",
      origin: "mcp",
      toolName: "query_db",
      content: {
        success: true,
        data: {
          page: { limit: 100, offset: 0, hasMore: true },
        },
      },
      activeTaskId: "task_1",
    },
    state(),
  );

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].kind, "pando/query_db");
  assertEquals(chunks[0].pointer?.pagination, { limit: 100, offset: 0, hasMore: true });
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

Deno.test("pando mutating tool finds nested changed files", async () => {
  const chunks = await chunkPandoInCode(
    {
      id: "tool_nested_mutation",
      origin: "mcp",
      toolName: "replace_body",
      content: {
        success: true,
        data: {
          details: {
            changedFiles: ["tests/pando_live_chunk_fixture.ts"],
          },
        },
      },
      activeTaskId: "task_1",
    },
    state(),
  );

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].pointer?.changedPaths, ["tests/pando_live_chunk_fixture.ts"]);
  assert(chunks[0].summary.includes("tests/pando_live_chunk_fixture.ts"));
});

Deno.test("pando workspace_overview is classified as read-only analysis", async () => {
  const chunks = await chunkPandoInCode(
    {
      id: "tool_3",
      origin: "mcp",
      toolName: "workspace_overview",
      content: {
        files: { total: 3 },
        modules: { detected: ["src/main.ts"] },
      },
      activeTaskId: "task_1",
    },
    state(),
  );

  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].kind, "pando/workspace_overview");
  assert(!chunks[0].kind.includes("mutation"));
  assertEquals(chunks[0].taskIds, ["task_1"]);
});

// Workspace overview commonly returns one large object rather than rows/items,
// so the pointer-chunk path is the expected read-only representation.

Deno.test("non-pando chunk request includes kept user context", async () => {
  let seenRequest: unknown;
  const chunks = await chunkNonPandoInBatches(
    [{
      id: "tool_shell",
      origin: "native",
      toolName: "shell_exec",
      params: { cmd: "printf alpha" },
      content: "alpha",
      activeTaskId: "task_1",
    }],
    {
      ...state(),
      keptUserMessages: [{
        messageId: "user_keep",
        summary: "User wants the shell output retained for the current task.",
        taskIds: ["task_1"],
      }],
    },
    (request) => {
      seenRequest = request;
      return Promise.resolve({
        chunks: [{
          sourceResultIndex: 0,
          title: "Shell output",
          summary: "The command printed alpha.",
          kind: "tool/shell",
          taskIds: ["task_1"],
          pointer: null,
        }],
      });
    },
  );

  assertEquals(chunks.length, 1);
  assertEquals(
    (seenRequest as { keptUserMessages: unknown[] }).keptUserMessages,
    [{
      messageId: "user_keep",
      summary: "User wants the shell output retained for the current task.",
      taskIds: ["task_1"],
    }],
  );
});

Deno.test("non-pando chunker materializes multiple semantic chunks from one result", async () => {
  const chunks = await chunkNonPandoInBatches(
    [{
      id: "tool_search",
      origin: "native",
      toolName: "web_search",
      params: { q: "pando proxy memory" },
      content: {
        results: [
          { title: "Memory design", url: "https://example.test/design" },
          { title: "Proxy reference", url: "https://example.test/reference" },
        ],
      },
      activeTaskId: "task_1",
    }],
    state(),
    () =>
      Promise.resolve({
        chunks: [
          {
            sourceResultIndex: 0,
            title: "Search result 1: Memory design",
            summary: "Design result for pando proxy memory.",
            kind: "tool/search_result",
            taskIds: ["task_1"],
            pointer: {
              itemIndex: 0,
              url: "https://example.test/design",
            },
          },
          {
            sourceResultIndex: 0,
            title: "Search result 2: Proxy reference",
            summary: "Reference result for pando proxy memory.",
            kind: "tool/search_result",
            taskIds: ["task_1"],
            pointer: {
              itemIndex: 1,
              url: "https://example.test/reference",
            },
          },
        ],
      }),
  );

  assertEquals(chunks.length, 2);
  assertEquals(chunks.map((chunk) => chunk.kind), ["tool/search_result", "tool/search_result"]);
  assertEquals(chunks[0].pointer?.itemIndex, 0);
  assertEquals(chunks[1].pointer?.url, "https://example.test/reference");
});

Deno.test("non-pando chunking allows one request for full tool data", async () => {
  const calls: unknown[] = [];
  const chunks = await chunkNonPandoInBatches(
    [{
      id: "tool_search",
      origin: "native",
      toolName: "web_search",
      params: { q: "memory" },
      content: { results: [{ title: "Result", url: "https://example.test" }] },
      activeTaskId: "task_1",
    }],
    state(),
    (request) => {
      calls.push(request);
      if (!request.infoRequestAttempt) {
        return Promise.resolve({
          needsMoreInfo: true,
          requestedInfo: [{
            type: "tool_result",
            id: "tool_search",
            reason: "Need the complete result object before choosing chunk boundaries.",
          }],
        });
      }
      assertEquals(request.extraContext[0].type, "tool_result");
      assertEquals(request.extraContext[0].id, "tool_search");
      return Promise.resolve({
        needsMoreInfo: false,
        requestedInfo: [],
        chunks: [{
          sourceResultIndex: 0,
          title: "Search result",
          summary: "Search returned a relevant result.",
          kind: "tool/search_result",
          taskIds: ["task_1"],
          pointer: { itemIndex: 0, url: "https://example.test" },
        }],
      });
    },
  );

  assertEquals(calls.length, 2);
  assertEquals(chunks.length, 1);
  assertEquals(chunks[0].kind, "tool/search_result");
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
