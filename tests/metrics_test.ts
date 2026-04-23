import { assertEquals } from "jsr:@std/assert";

import { memoryStateMetrics, requestContextMetrics } from "../src/metrics.ts";
import { emptyMemoryState } from "../src/memory_state.ts";

Deno.test("requestContextMetrics counts current input items", () => {
  const metrics = requestContextMetrics({
    input: [
      { type: "message", role: "developer", content: [] },
      { type: "message", role: "user", content: [] },
      { type: "function_call_output", call_id: "call_1", output: "ok" },
    ],
  });

  assertEquals(metrics.inputItemCount, 3);
  assertEquals(metrics.userMessageCount, 1);
  assertEquals(metrics.toolOutputCount, 1);
});

Deno.test("memoryStateMetrics reports task and piece totals", () => {
  const state = {
    ...emptyMemoryState(),
    tasks: [{ id: "task_1", text: "Inspect", status: "open" as const, kind: "do" as const }],
    pieces: [{
      id: "piece_1",
      sourceKind: "user" as const,
      sourceId: "src_1",
      taskIds: ["task_1"],
      payloadInline: "hello",
      byteSize: 5,
      createdSeq: 1,
      selector: { kind: "whole" as const },
    }],
  };

  const metrics = memoryStateMetrics(state);

  assertEquals(metrics.taskCount, 1);
  assertEquals(metrics.pieceCount, 1);
  assertEquals(metrics.pieceBytes, 5);
});
