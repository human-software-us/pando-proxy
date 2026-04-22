import { applyTaskUpdate, validateTaskUpdate } from "../src/task_update.ts";
import { MemoryState } from "../src/memory_state.ts";

Deno.test("task update validation enforces complete previous-task and message actions", () => {
  const previous: MemoryState = {
    taskUpdateSeq: 1,
    tasks: [{ id: "task_1", text: "Build proxy", status: "in_progress", kind: "do" }],
    activeTaskId: "task_1",
    keptUserMessages: [{ messageId: "user_1", summary: "Build it", taskIds: ["task_1"] }],
    memoryLibrary: [],
  };

  const errors = validateTaskUpdate(
    {
      taskUpdateSeq: 2,
      latestUserMessageId: "user_2",
      result: "same_as_before",
      tasksAfter: previous.tasks,
      activeTaskId: "task_1",
      existingTaskActions: [],
      userMessageActions: [],
    },
    previous,
    { messageId: "user_2", text: "continue" },
  );

  assert(errors.some((error) => error.includes("Missing existingTaskAction")));
  assert(errors.some((error) => error.includes("Missing userMessageAction for user_1")));
  assert(errors.some((error) => error.includes("Missing userMessageAction for user_2")));
});

Deno.test("task update apply remaps merged task ids and prunes completed tasks", () => {
  const previous: MemoryState = {
    taskUpdateSeq: 1,
    tasks: [
      { id: "task_1", text: "Old", status: "open", kind: "do" },
      { id: "task_2", text: "New", status: "open", kind: "do" },
    ],
    activeTaskId: "task_1",
    keptUserMessages: [{ messageId: "user_1", summary: "old request", taskIds: ["task_1"] }],
    memoryLibrary: [{
      id: "chunk_1",
      title: "fact",
      summary: "fact",
      kind: "tool",
      taskIds: ["task_1"],
    }],
  };

  const next = applyTaskUpdate(previous, { messageId: "user_2", text: "merge" }, {
    taskUpdateSeq: 2,
    latestUserMessageId: "user_2",
    result: "changed",
    tasksAfter: [{ id: "task_2", text: "New", status: "in_progress", kind: "do" }],
    activeTaskId: "task_2",
    existingTaskActions: [
      { id: "task_1", action: "merge_into", mergeInto: "task_2" },
      { id: "task_2", action: "keep" },
    ],
    userMessageActions: [
      { messageId: "user_1", action: "keep", taskIds: ["task_2"], summary: "old request" },
      { messageId: "user_2", action: "drop" },
    ],
  });

  assertEquals(next.activeTaskId, "task_2");
  assertEquals(next.keptUserMessages[0].taskIds, ["task_2"]);
  assertEquals(next.memoryLibrary[0].taskIds, ["task_2"]);
});

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
