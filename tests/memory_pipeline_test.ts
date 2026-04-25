import { assertEquals } from "jsr:@std/assert";

import { updateMemoryForCompletedRound } from "../src/memory_pipeline.ts";
import { emptyMemoryState, type MemoryState, type Task } from "../src/memory_state.ts";
import type { StructuredClients } from "../src/structured_model.ts";
import type { ProxyConfig } from "../src/config.ts";

Deno.test("updateMemoryForCompletedRound stores new request and assistant content exactly", async () => {
  const previous = withTasks([task("task_1", "Inspect the proxy")]);
  const body = {
    input: [{
      id: "user_msg_1",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Check the proxy" }],
    }],
  };
  const response = {
    id: "resp_1",
    output: [{
      id: "assistant_msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: '{"ok":true}' }],
    }],
  };

  const next = await updateMemoryForCompletedRound(
    body,
    previous,
    response,
    [],
    clients(),
    config(),
  );

  assertEquals(next.changed, true);
  assertEquals(next.memory.tasks.length, 1);
  assertEquals(next.memory.pieces.map((piece) => piece.id), ["user_msg_1:0", "assistant_msg_1:0"]);
});

Deno.test("updateMemoryForCompletedRound can drop everything explicitly", async () => {
  const previous = withTasks([task("task_1", "Inspect the proxy")]);
  const body = {
    input: [{
      id: "user_msg_2",
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    }],
  };

  const next = await updateMemoryForCompletedRound(
    body,
    previous,
    { id: "resp_empty", output: [] },
    [],
    clients({
      tasksAfter: [task("task_1", "Inspect the proxy")],
      pieceSelection: { mode: "drop_all" },
      keptPieceTaskLinks: [],
    }),
    config(),
  );

  assertEquals(next.memory.pieces.length, 0);
  assertEquals(next.newPieceIds.length, 0);
});

function withTasks(tasks: Task[]): MemoryState {
  return { ...emptyMemoryState(), tasks };
}

function task(id: string, text: string): Task {
  return { id, text, status: "open", kind: "do" };
}

function clients(
  roundUpdateResponse: unknown = {
    tasksAfter: [task("task_1", "Inspect the proxy")],
    pieceSelection: { mode: "keep_all" as const },
    keptPieceTaskLinks: [
      { id: "user_msg_1:0", taskIds: ["task_1"] },
      { id: "assistant_msg_1:0", taskIds: ["task_1"] },
    ],
  },
): StructuredClients {
  return {
    sourceChunk: async () => ({ chunks: [{ kind: "whole" }] }),
    roundUpdate: async (request) => {
      const response = roundUpdateResponse as {
        tasksAfter: Task[];
        pieceSelection: { mode: string };
        keptPieceTaskLinks: Array<{ id: string; taskIds: string[] }>;
      };
      if (response.pieceSelection.mode === "keep_all") {
        return {
          tasksAfter: response.tasksAfter,
          pieceSelection: { mode: "keep_all" },
          keptPieceTaskLinks: request.newPieces.map((piece) => ({
            id: piece.id,
            taskIds: ["task_1"],
          })),
        };
      }
      return response;
    },
  };
}

function config(): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    upstreamBaseUrl: "https://api.openai.com/v1",
    apiKey: null,
    smallStructuredModel: "gpt-4.1-mini",
    overflowStructuredModel: "gpt-5-mini",
    smallStructuredContextWindow: 32_000,
    overflowStructuredContextWindow: 128_000,
    modelTimeoutMs: 30_000,
    stateDir: "/tmp/pando-proxy-tests",
    memoryEnabled: true,
    logFile: null,
    inlinePieceByteLimit: 4_096,
    piecePreviewCharLimit: 80,
    maxIndexedPiecesPerTask: 8,
    maxLocalContextToolCalls: 3,
  };
}
