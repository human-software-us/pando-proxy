import { assertEquals } from "jsr:@std/assert";
import {
  applyGroupUpdate,
  type GroupMemoryClients,
  type RetainedPiecePruneRequest,
} from "../src/group_manager.ts";
import type { MemoryState, PieceDraft } from "../src/memory_state.ts";

Deno.test("applyGroupUpdate keeps new pieces when retention output is missing or uncertain", async () => {
  const state: MemoryState = {
    roundSeq: 0,
    groups: [],
    pieces: [],
    processedSourceIds: [],
  };
  const piece: PieceDraft = {
    id: "source_1:0",
    sourceKind: "user",
    sourceId: "source_1",
    content: "remember exact token ALPHA-123",
    previewText: "remember exact token ALPHA-123",
    byteSize: 30,
    selector: { kind: "whole" },
  };
  const clients: GroupMemoryClients = {
    groupIntent: () =>
      Promise.resolve({ groupsAfter: [], closedGroupIds: [], replacedGroupIds: [] }),
    pieceRetentionBatch: () =>
      Promise.resolve({
        decisions: [{
          pieceId: piece.id,
          keep: false,
          groupId: null,
          supersedesPieceIds: [],
          dropConfidence: "uncertain",
          dropReason: null,
        }],
      }),
    retainedPiecePrune: () => Promise.resolve({ dropPieceIds: ["source_1:0"] }),
  };

  const result = await applyGroupUpdate(
    state,
    [piece],
    { groupsAfter: [], closedGroupIds: [], replacedGroupIds: [] },
    clients,
  );

  assertEquals(result.keptNewPieceIds, [piece.id]);
  assertEquals(result.droppedNewPieceIds, []);
  assertEquals(result.memory.pieces.map((memoryPiece) => memoryPiece.id), [piece.id]);
  assertEquals(result.memory.groups.some((group) => group.id === "_retained"), true);
});

Deno.test("applyGroupUpdate ignores prune drops without certain reason-coded decisions", async () => {
  const oldPieceId = "source_old:0";
  const state: MemoryState = {
    roundSeq: 1,
    groups: [{
      id: "group_1",
      status: "active",
      routingLabel: "task",
      summary: "Exact task context.",
      lastTouchedSeq: 1,
    }],
    pieces: [{
      id: oldPieceId,
      groupId: "group_1",
      sourceKind: "user",
      sourceId: "source_old",
      previewText: "old exact value",
      byteSize: 15,
      createdSeq: 1,
      selector: { kind: "whole" },
    }],
    processedSourceIds: ["source_old"],
  };
  const newPiece: PieceDraft = {
    id: "source_new:0",
    sourceKind: "user",
    sourceId: "source_new",
    content: "new exact value",
    previewText: "new exact value",
    byteSize: 15,
    selector: { kind: "whole" },
  };
  const clients: GroupMemoryClients = {
    groupIntent: () =>
      Promise.resolve({
        groupsAfter: [],
        closedGroupIds: ["group_1"],
        replacedGroupIds: [],
      }),
    pieceRetentionBatch: () =>
      Promise.resolve({
        decisions: [{
          pieceId: newPiece.id,
          keep: true,
          groupId: "group_1",
          supersedesPieceIds: [],
          dropConfidence: "uncertain",
          dropReason: null,
        }],
      }),
    retainedPiecePrune: (request: RetainedPiecePruneRequest) =>
      Promise.resolve({
        dropPieceIds: request.retainedOldPieces.map((piece) => piece.id),
      }),
  };

  const result = await applyGroupUpdate(
    state,
    [newPiece],
    { groupsAfter: [], closedGroupIds: ["group_1"], replacedGroupIds: [] },
    clients,
  );

  assertEquals(result.droppedOldPieceIds, []);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [oldPieceId, newPiece.id]);
  assertEquals(result.groupIntent.closedGroupIds, []);
});
