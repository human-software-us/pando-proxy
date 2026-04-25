import { assertEquals } from "jsr:@std/assert";

import { SessionStore } from "../src/store.ts";

Deno.test("SessionStore externalizes large payloads and context_get returns exact payloads", async () => {
  const tempDir = await Deno.makeTempDir();
  const store = new SessionStore(tempDir, 10);

  await store.save("session_1", {
    memory: {
      roundSeq: 1,
      tasks: [{ id: "task_1", text: "Inspect", status: "open", kind: "do" }],
      pieces: [{
        id: "piece_1",
        sourceKind: "tool",
        sourceId: "tool_1",
        taskIds: ["task_1"],
        payloadInline: { text: "this payload is definitely larger than ten bytes" },
        byteSize: 60,
        createdSeq: 1,
        selector: { kind: "whole" },
      }],
      processedSourceIds: [],
    },
  });

  const loaded = await store.load("session_1");
  assertEquals(typeof loaded.memory.pieces[0].payloadRef, "string");
  assertEquals(loaded.memory.pieces[0].payloadInline, undefined);

  const exact = await store.getExactPieces("session_1", ["piece_1"]);
  assertEquals(exact.length, 1);
  assertEquals(
    (exact[0].payload as Record<string, unknown>).text,
    "this payload is definitely larger than ten bytes",
  );
});
