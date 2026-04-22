import { SessionStore } from "../src/store.ts";

Deno.test("session store loads latest snapshot and persisted handled input ids", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const store = new SessionStore(tempDir);
    await store.save("session/one", {
      memory: {
        taskUpdateSeq: 1,
        tasks: [{ id: "task_1", text: "old", status: "open", kind: "do" }],
        activeTaskId: "task_1",
        keptUserMessages: [],
        memoryLibrary: [],
      },
      handledInputIds: ["user_1"],
    });
    await store.save("session/one", {
      memory: {
        taskUpdateSeq: 2,
        tasks: [{ id: "task_2", text: "new", status: "in_progress", kind: "do" }],
        activeTaskId: "task_2",
        keptUserMessages: [],
        memoryLibrary: [],
      },
      handledInputIds: ["tool_1", "user_2"],
    });

    const loaded = await store.load("session/one");

    assertEquals(loaded.memory.taskUpdateSeq, 2);
    assertEquals(loaded.memory.activeTaskId, "task_2");
    assertEquals(loaded.handledInputIds, ["tool_1", "user_2"]);
  } finally {
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
