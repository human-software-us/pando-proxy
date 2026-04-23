import { buildSyntheticMemoryText, rewriteRequestWithMemory } from "../src/prompt_view.ts";
import { MemoryState } from "../src/memory_state.ts";

Deno.test("prompt view includes live tasks and retained chunks", () => {
  const text = buildSyntheticMemoryText(state(), 4_000);

  assert(text?.includes("<context_memory>"));
  assert(text?.includes("task_1"));
  assert(text?.includes("Useful fact"));
});

Deno.test("request rewrite inserts exactly one synthetic memory item after instructions", () => {
  return (async () => {
  const body = {
    model: "test-model",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "work" }] },
    ],
    stream: true,
  };

    const rewritten = await rewriteRequestWithMemory(body, state(), 4_000);
    const input = rewritten.body.input as Array<Record<string, unknown>>;

    assertEquals(input.length, 3);
    assertEquals(input[0].role, "developer");
    assertEquals(input[1].role, "user");
    assert(String(JSON.stringify(input[1])).includes("<context_memory>"));
    assertEquals(rewritten.body.model, "test-model");
    assertEquals(rewritten.body.stream, true);
    assert(rewritten.diff.insertedSyntheticMemoryChars > 0);
  })();
});

Deno.test("request rewrite drops older handled protocol segments and keeps the latest cycle", () => {
  return (async () => {
    const body = {
      input: [
        { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>" }],
        },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Work on it." }] },
        {
          type: "message",
          role: "assistant",
          id: "msg_1",
          content: [{ type: "output_text", text: "Older handled cycle." }],
        },
        {
          type: "function_call",
          id: "call_1",
          call_id: "call_1",
          name: "exec_command",
          arguments: "{\"cmd\":\"echo old\"}",
        },
        {
          type: "function_call_output",
          id: "out_1",
          call_id: "call_1",
          output: "old output",
        },
        { type: "reasoning", encrypted_content: "old-reasoning" },
        {
          type: "message",
          role: "assistant",
          id: "msg_2",
          content: [{ type: "output_text", text: "Latest cycle stays raw." }],
        },
        {
          type: "function_call",
          id: "call_2",
          call_id: "call_2",
          name: "exec_command",
          arguments: "{\"cmd\":\"echo latest\"}",
        },
        {
          type: "function_call_output",
          id: "out_2",
          call_id: "call_2",
          output: "latest output",
        },
      ],
    };

    const rewritten = await rewriteRequestWithMemory(body, state(), 4_000, {
      handledInputIds: ["assistant_msg_1", "tool_out_1"],
    });
    const input = rewritten.body.input as Array<Record<string, unknown>>;

    assertEquals(
      input.map((item) => `${String(item.type)}:${String(item.role ?? item.call_id ?? "")}`),
      [
        "message:developer",
        "message:user",
        "message:user",
        "message:assistant",
        "function_call:call_2",
        "function_call_output:call_2",
      ],
    );
    assert(rewritten.diff.droppedInputIds.includes("assistant_msg_1"));
    assert(rewritten.diff.droppedInputIds.includes("tool_out_1"));
  })();
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
