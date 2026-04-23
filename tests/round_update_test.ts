import { assertEquals, assertThrows } from "jsr:@std/assert";

import { emptyMemoryState } from "../src/memory_state.ts";
import { applyRoundUpdate, parseAndValidateRoundUpdate, resolveKeptPieceIds } from "../src/round_update.ts";

Deno.test("resolveKeptPieceIds enforces explicit keep/drop selection", () => {
  assertEquals(
    [...resolveKeptPieceIds({ mode: "keep_only", ids: ["piece_1"] }, ["piece_1", "piece_2"])],
    ["piece_1"],
  );
  assertEquals(
    [...resolveKeptPieceIds({ mode: "drop_only", ids: ["piece_2"] }, ["piece_1", "piece_2"])],
    ["piece_1"],
  );
});

Deno.test("parseAndValidateRoundUpdate rejects implicit keep sets", () => {
  const parsed = parseAndValidateRoundUpdate(
    {
      tasksAfter: [{ id: "task_1", text: "Inspect", status: "open", kind: "do" }],
      pieceSelection: { mode: "keep_only", ids: ["piece_1"] },
      keptPieceTaskLinks: [],
    },
    emptyMemoryState(),
    [{ id: "piece_1", sourceKind: "user", sourceId: "user_1", payloadInline: "hi", byteSize: 2, selector: { kind: "whole" } }],
  );

  assertEquals(parsed.ok, false);
});

Deno.test("applyRoundUpdate persists only explicitly kept pieces", async () => {
  const next = await applyRoundUpdate(
    {
      ...emptyMemoryState(),
      tasks: [{ id: "task_1", text: "Inspect", status: "open", kind: "do" }],
    },
    [
      { id: "piece_1", sourceKind: "user", sourceId: "user_1", payloadInline: "a", byteSize: 1, selector: { kind: "whole" } },
      { id: "piece_2", sourceKind: "assistant", sourceId: "assistant_1", payloadInline: "b", byteSize: 1, selector: { kind: "whole" } },
    ],
    async () => ({
      tasksAfter: [{ id: "task_1", text: "Inspect", status: "open", kind: "do" }],
      pieceSelection: { mode: "keep_only", ids: ["piece_2"] },
      keptPieceTaskLinks: [{ id: "piece_2", taskIds: ["task_1"] }],
    }),
  );

  assertEquals(next.pieces.map((piece) => piece.id), ["piece_2"]);
});

Deno.test("applyRoundUpdate fails closed on invalid round output", async () => {
  await assertThrows(
    () =>
      applyRoundUpdate(
        emptyMemoryState(),
        [{ id: "piece_1", sourceKind: "user", sourceId: "user_1", payloadInline: "a", byteSize: 1, selector: { kind: "whole" } }],
        async () => ({
          tasksAfter: [{ id: "task_1", text: "Inspect", status: "open", kind: "do" }],
          pieceSelection: { mode: "keep_all" },
          keptPieceTaskLinks: [],
        }),
      ),
    Error,
    "round_update validation failed",
  );
});
