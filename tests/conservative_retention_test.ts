import { assert, assertEquals } from "@std/assert";
import {
  applyWorkingSetUpdate,
  type MemoryManagerClients,
  type PieceDropBatchRequest,
} from "../src/working_set_manager.ts";
import type {
  MaterializedMemoryPiece,
  MemoryPiece,
  MemoryState,
  PieceDraft,
} from "../src/memory_state.ts";
import { buildPromptMemoryText } from "../src/prompt_view.ts";

const keepAllClients: MemoryManagerClients = {
  taskRoute: () => Promise.resolve({ kind: "same_task" }),
  sourceChunkBatch: () => Promise.resolve({ results: [] }),
  pieceDropBatch: (request: PieceDropBatchRequest) =>
    Promise.resolve({
      decisions: request.evaluatedPieces.map((piece) => ({
        pieceId: piece.id,
        drop: false,
        reason: null,
      })),
    }),
};

Deno.test("applyWorkingSetUpdate keeps pieces when drop reason is missing or unsupported", async () => {
  const piece = draft("source_1:0", "source_1", "remember exact token ALPHA-123");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((candidate) => ({
          pieceId: candidate.id,
          drop: true,
          reason: null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    emptyState(),
    [piece],
    { kind: "new_task" },
    clients,
  );

  assertEquals(result.keptNewPieceIds, [piece.id]);
  assertEquals(result.droppedNewPieceIds, []);
  assertEquals(result.memory.activeTask?.pieceIds, [piece.id]);
  assertEquals(result.memory.pieces.map((memoryPiece) => memoryPiece.id), [piece.id]);
});

Deno.test("applyWorkingSetUpdate marks exact duplicates instead of losing duplicate locations", async () => {
  const first = draft("source_a:0", "source_a", "same exact content");
  const duplicate = draft("source_b:0", "source_b", "same exact content");

  const result = await applyWorkingSetUpdate(
    emptyState(),
    [first, duplicate],
    { kind: "new_task" },
    keepAllClients,
  );

  assertEquals(result.keptNewPieceIds, [first.id]);
  assertEquals(result.droppedNewPieceIds, [duplicate.id]);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [first.id]);
  assertEquals(result.memory.pieces[0].duplicateSources, [{
    pieceId: duplicate.id,
    sourceId: duplicate.sourceId,
    sourceKind: duplicate.sourceKind,
  }]);
  const prompt = buildPromptMemoryText(
    { ...result.memory, pieces: [materialized(result.memory.pieces[0], "same exact content")] },
    [materialized(result.memory.pieces[0], "same exact content")],
  );
  assert(prompt.includes("same exact content"));
  assert(prompt.includes("duplicateSourceId=source_b"));
  assert(prompt.includes("<duplicate_observations>"));
});

Deno.test("applyWorkingSetUpdate drops old active pieces with accepted full-payload prune decisions", async () => {
  const oldPiece = memoryPiece("source_old:0", "source_old", "old assistant restatement");
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      pieceIds: [oldPiece.id],
      startedRound: 1,
      lastRound: 1,
    },
    archivedTasks: [],
    pieces: [oldPiece],
    processedSourceIds: ["source_old"],
  };
  const newPiece = draft("source_new:0", "source_new", "new exact value");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((candidate) => ({
          pieceId: candidate.id,
          drop: candidate.id === oldPiece.id,
          reason: candidate.id === oldPiece.id ? "pure_ack_or_chatter" : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "same_task" },
    clients,
    [materialized(oldPiece, "old assistant restatement")],
  );

  assertEquals(result.droppedOldPieceIds, [oldPiece.id]);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [newPiece.id]);
  assertEquals(result.memory.activeTask?.pieceIds, [newPiece.id]);
});

Deno.test("applyWorkingSetUpdate accepts batch default prune decisions", async () => {
  const piece = draft("source_1:0", "source_1", "transient reply OK only");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: () =>
      Promise.resolve({
        defaultDecision: {
          drop: true,
          reason: "transient_format_request_only",
        },
        overrides: [],
      }),
  };

  const result = await applyWorkingSetUpdate(
    emptyState(),
    [piece],
    { kind: "new_task" },
    clients,
  );

  assertEquals(result.keptNewPieceIds, []);
  assertEquals(result.droppedNewPieceIds, [piece.id]);
  assertEquals(result.memory.pieces, []);
});

Deno.test("applyWorkingSetUpdate archives old active memory on a new task", async () => {
  const oldPiece = memoryPiece("source_old:0", "source_old", "old task fact");
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      pieceIds: [oldPiece.id],
      startedRound: 1,
      lastRound: 1,
    },
    archivedTasks: [],
    pieces: [oldPiece],
    processedSourceIds: ["source_old"],
  };
  const newPiece = draft("source_new:0", "source_new", "start unrelated task");

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "new_task" },
    keepAllClients,
    [materialized(oldPiece, "old task fact")],
  );

  assertEquals(result.keptOldPieceIds, []);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [newPiece.id]);
  assertEquals(result.memory.activeTask?.pieceIds, [newPiece.id]);
  assertEquals(result.memory.archivedTasks.map((task) => task.id), ["task_1"]);
  assertEquals(result.memory.archivedTasks[0].pieces.map((piece) => piece.id), [oldPiece.id]);
});

Deno.test("applyWorkingSetUpdate revives previous task by relative index", async () => {
  const currentPiece = memoryPiece("source_current:0", "source_current", "current task fact");
  const archivedPiece = memoryPiece("source_archived:0", "source_archived", "archived task fact");
  const state: MemoryState = {
    roundSeq: 3,
    activeTask: {
      id: "task_current",
      pieceIds: [currentPiece.id],
      startedRound: 3,
      lastRound: 3,
    },
    archivedTasks: [{
      id: "task_archived",
      pieces: [archivedPiece],
      startedRound: 1,
      archivedRound: 2,
    }],
    pieces: [currentPiece],
    processedSourceIds: ["source_current", "source_archived"],
  };
  const newPiece = draft("source_new:0", "source_new", "continue previous task");

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "revive_task", relativeIndex: -1 },
    keepAllClients,
    [
      materialized(currentPiece, "current task fact"),
      materialized(archivedPiece, "archived task fact"),
    ],
  );

  assertEquals(result.memory.activeTask?.id, "task_archived");
  assertEquals(result.memory.pieces.map((piece) => piece.id), [archivedPiece.id, newPiece.id]);
  assertEquals(result.memory.archivedTasks.map((task) => task.id), ["task_current"]);
});

Deno.test("applyWorkingSetUpdate keeps current task when revive index is unavailable", async () => {
  const currentPiece = memoryPiece("source_current:0", "source_current", "current task fact");
  const state: MemoryState = {
    roundSeq: 3,
    activeTask: {
      id: "task_current",
      pieceIds: [currentPiece.id],
      startedRound: 3,
      lastRound: 3,
    },
    archivedTasks: [],
    pieces: [currentPiece],
    processedSourceIds: ["source_current"],
  };
  const newPiece = draft("source_new:0", "source_new", "bad revive should continue current task");

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "revive_task", relativeIndex: -1 },
    keepAllClients,
    [materialized(currentPiece, "current task fact")],
  );

  assertEquals(result.taskRoute, { kind: "same_task" });
  assertEquals(result.memory.activeTask?.id, "task_current");
  assertEquals(result.memory.archivedTasks, []);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [currentPiece.id, newPiece.id]);
});

Deno.test("applyWorkingSetUpdate handles 8+ rounds of turnover, drops, and reciprocal revives", async () => {
  const renderTextByPieceId = new Map<string, string>();
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        defaultDecision: { drop: false, reason: null },
        overrides: request.evaluatedPieces
          .filter((piece) => piece.contentText.includes("DROP_ME"))
          .map((piece) => ({
            pieceId: piece.id,
            drop: true,
            reason: "pure_ack_or_chatter",
          })),
      }),
  };
  let state = emptyState();

  async function step(
    route: Parameters<typeof applyWorkingSetUpdate>[2],
    id: string,
    text: string,
  ): Promise<void> {
    const piece = draft(id, id.replace(/:0$/, ""), text);
    renderTextByPieceId.set(piece.id, text);
    const result = await applyWorkingSetUpdate(
      state,
      [piece],
      route,
      clients,
      materializedKnownPieces(state, renderTextByPieceId),
    );
    state = result.memory;
  }

  await step({ kind: "new_task" }, "a_root:0", "Task A root KEEP alpha-001");
  const taskAId = state.activeTask!.id;
  await step({ kind: "same_task" }, "a_noise:0", "Task A assistant chatter DROP_ME");
  await step({ kind: "same_task" }, "a_keep:0", "Task A useful KEEP path src/a.ts");
  assertEquals(state.pieces.map((piece) => piece.id), ["a_root:0", "a_keep:0"]);

  await step({ kind: "new_task" }, "b_root:0", "Task B root KEEP beta-002");
  const taskBId = state.activeTask!.id;
  assertEquals(state.archivedTasks.map((task) => task.id), [taskAId]);
  await step({ kind: "same_task" }, "b_noise:0", "Task B resolved chatter DROP_ME");
  await step({ kind: "same_task" }, "b_keep:0", "Task B useful KEEP path src/b.ts");
  assertEquals(state.pieces.map((piece) => piece.id), ["b_root:0", "b_keep:0"]);

  await step({ kind: "new_task" }, "c_root:0", "Task C root KEEP gamma-003");
  const taskCId = state.activeTask!.id;
  await step({ kind: "new_task" }, "d_root:0", "Task D root KEEP delta-004");
  const taskDId = state.activeTask!.id;
  assertEquals(state.archivedTasks.map((task) => task.id), [taskAId, taskBId, taskCId]);

  await step({ kind: "revive_task", relativeIndex: -3 }, "a_revival:0", "Revive Task A KEEP");
  assertEquals(state.activeTask?.id, taskAId);
  assertEquals(state.pieces.map((piece) => piece.id), ["a_root:0", "a_keep:0", "a_revival:0"]);
  assertEquals(state.archivedTasks.map((task) => task.id), [taskBId, taskCId, taskDId]);
  assertEquals(
    state.archivedTasks.find((task) => task.id === taskDId)?.pieces.map((piece) => piece.id),
    ["d_root:0"],
  );

  await step(
    { kind: "revive_task", relativeIndex: -1 },
    "d_revival:0",
    "Revive displaced Task D KEEP",
  );
  assertEquals(state.activeTask?.id, taskDId);
  assertEquals(state.pieces.map((piece) => piece.id), ["d_root:0", "d_revival:0"]);
  assertEquals(state.archivedTasks.map((task) => task.id), [taskBId, taskCId, taskAId]);
  assertEquals(
    state.archivedTasks.find((task) => task.id === taskAId)?.pieces.map((piece) => piece.id),
    ["a_root:0", "a_keep:0", "a_revival:0"],
  );

  await step({ kind: "same_task" }, "d_noise:0", "Task D final transient DROP_ME");
  await step({ kind: "same_task" }, "d_keep:0", "Task D final useful KEEP src/d.ts");
  assertEquals(state.activeTask?.id, taskDId);
  assertEquals(state.pieces.map((piece) => piece.id), ["d_root:0", "d_revival:0", "d_keep:0"]);
  assertEquals(state.archivedTasks.map((task) => task.id), [taskBId, taskCId, taskAId]);
});

Deno.test("applyWorkingSetUpdate handles 8+ large-chunk turnover with batched drops and revives", async () => {
  const renderTextByPieceId = new Map<string, string>();
  const pruneBatches: PieceDropBatchRequest[] = [];
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pruneBatchTokenLimit: 2_400,
    pieceDropBatch: (request: PieceDropBatchRequest) => {
      pruneBatches.push(request);
      return Promise.resolve({
        defaultDecision: { drop: false, reason: null },
        overrides: request.evaluatedPieces
          .filter((piece) => piece.contentText.includes("DROP_LARGE"))
          .map((piece) => ({
            pieceId: piece.id,
            drop: true,
            reason: "clearly_unrelated_to_current_work",
          })),
      });
    },
  };
  let state = emptyState();

  async function step(
    route: Parameters<typeof applyWorkingSetUpdate>[2],
    drafts: PieceDraft[],
  ): Promise<void> {
    for (const piece of drafts) {
      renderTextByPieceId.set(piece.id, renderDraft(piece));
    }
    const result = await applyWorkingSetUpdate(
      state,
      drafts,
      route,
      clients,
      materializedKnownPieces(state, renderTextByPieceId),
    );
    state = result.memory;
  }

  await step({ kind: "new_task" }, [
    draft("la_user:0", "la_user", "Large Task A root KEEP_LARGE alpha"),
    draftKind("la_keep_1:0", "la_keep_1", "assistant", largeText("A_KEEP_1", "KEEP_LARGE")),
    draftKind("la_drop_1:0", "la_drop_1", "assistant", largeText("A_DROP_1", "DROP_LARGE")),
    draftKind("la_keep_2:0", "la_keep_2", "tool", largeText("A_KEEP_2", "KEEP_LARGE")),
  ]);
  const taskAId = state.activeTask!.id;
  assertSameIds(state.pieces.map((piece) => piece.id), [
    "la_user:0",
    "la_keep_1:0",
    "la_keep_2:0",
  ]);

  await step({ kind: "same_task" }, [
    draftKind("la_drop_2:0", "la_drop_2", "assistant", largeText("A_DROP_2", "DROP_LARGE")),
    draftKind("la_keep_3:0", "la_keep_3", "assistant", largeText("A_KEEP_3", "KEEP_LARGE")),
  ]);
  assertSameIds(state.pieces.map((piece) => piece.id), [
    "la_user:0",
    "la_keep_1:0",
    "la_keep_2:0",
    "la_keep_3:0",
  ]);

  await step({ kind: "new_task" }, [
    draft("lb_user:0", "lb_user", "Large Task B root KEEP_LARGE beta"),
    draftKind("lb_drop_1:0", "lb_drop_1", "assistant", largeText("B_DROP_1", "DROP_LARGE")),
    draftKind("lb_keep_1:0", "lb_keep_1", "tool", largeText("B_KEEP_1", "KEEP_LARGE")),
  ]);
  const taskBId = state.activeTask!.id;
  await step({ kind: "same_task" }, [
    draftKind("lb_keep_2:0", "lb_keep_2", "assistant", largeText("B_KEEP_2", "KEEP_LARGE")),
    draftKind("lb_drop_2:0", "lb_drop_2", "tool", largeText("B_DROP_2", "DROP_LARGE")),
  ]);

  await step({ kind: "new_task" }, [
    draft("lc_user:0", "lc_user", "Large Task C root KEEP_LARGE gamma"),
    draftKind("lc_keep_1:0", "lc_keep_1", "assistant", largeText("C_KEEP_1", "KEEP_LARGE")),
  ]);
  const taskCId = state.activeTask!.id;
  await step({ kind: "new_task" }, [
    draft("ld_user:0", "ld_user", "Large Task D root KEEP_LARGE delta"),
    draftKind("ld_keep_1:0", "ld_keep_1", "assistant", largeText("D_KEEP_1", "KEEP_LARGE")),
    draftKind("ld_drop_1:0", "ld_drop_1", "assistant", largeText("D_DROP_1", "DROP_LARGE")),
  ]);
  const taskDId = state.activeTask!.id;
  assertEquals(state.archivedTasks.map((task) => task.id), [taskAId, taskBId, taskCId]);

  await step({ kind: "revive_task", relativeIndex: -3 }, [
    draft("la_recall:0", "la_recall", "Recall old large Task A KEEP_LARGE"),
    draftKind("la_drop_3:0", "la_drop_3", "assistant", largeText("A_DROP_3", "DROP_LARGE")),
  ]);
  assertEquals(state.activeTask?.id, taskAId);
  assertEquals(state.archivedTasks.map((task) => task.id), [taskBId, taskCId, taskDId]);
  assertSameIds(
    state.archivedTasks.find((task) => task.id === taskDId)?.pieces.map((piece) => piece.id),
    ["ld_user:0", "ld_keep_1:0"],
  );
  assertSameIds(state.pieces.map((piece) => piece.id), [
    "la_user:0",
    "la_keep_1:0",
    "la_keep_2:0",
    "la_keep_3:0",
    "la_recall:0",
  ]);

  await step({ kind: "revive_task", relativeIndex: -1 }, [
    draft("ld_recall:0", "ld_recall", "Recall displaced large Task D KEEP_LARGE"),
  ]);
  assertEquals(state.activeTask?.id, taskDId);
  assertEquals(state.archivedTasks.map((task) => task.id), [taskBId, taskCId, taskAId]);
  assertSameIds(
    state.archivedTasks.find((task) => task.id === taskAId)?.pieces.map((piece) => piece.id),
    ["la_user:0", "la_keep_1:0", "la_keep_2:0", "la_keep_3:0", "la_recall:0"],
  );
  assertSameIds(state.pieces.map((piece) => piece.id), [
    "ld_user:0",
    "ld_keep_1:0",
    "ld_recall:0",
  ]);

  await step({ kind: "same_task" }, [
    draftKind("ld_drop_2:0", "ld_drop_2", "assistant", largeText("D_DROP_2", "DROP_LARGE")),
    draftKind("ld_keep_2:0", "ld_keep_2", "tool", largeText("D_KEEP_2", "KEEP_LARGE")),
  ]);
  assertEquals(state.activeTask?.id, taskDId);
  assertSameIds(state.pieces.map((piece) => piece.id), [
    "ld_user:0",
    "ld_keep_1:0",
    "ld_recall:0",
    "ld_keep_2:0",
  ]);
  assertEquals(state.archivedTasks.map((task) => task.id), [taskBId, taskCId, taskAId]);
  assert(pruneBatches.length >= 12, "expected many prune batches");
  assert(
    pruneBatches.some((batch) => batch.evaluatedPieces.length === 1) &&
      pruneBatches.some((batch) => batch.evaluatedPieces.length > 1),
    "expected mixed single-piece and multi-piece prune batches",
  );
  assert(
    pruneBatches.some((batch) =>
      batch.sharedUserPieces.some((piece) => piece.contentText.includes("Large Task"))
    ),
    "expected shared user context in prune batches",
  );
});

function emptyState(): MemoryState {
  return {
    roundSeq: 0,
    activeTask: null,
    archivedTasks: [],
    pieces: [],
    processedSourceIds: [],
  };
}

function draft(id: string, sourceId: string, text: string): PieceDraft {
  return draftKind(id, sourceId, "user", text);
}

function draftKind(
  id: string,
  sourceId: string,
  sourceKind: PieceDraft["sourceKind"],
  text: string,
): PieceDraft {
  return {
    id,
    sourceKind,
    sourceId,
    content: text,
    previewText: text,
    byteSize: text.length,
    selector: { kind: "whole" },
  };
}

function renderDraft(piece: PieceDraft): string {
  return typeof piece.content === "string" ? piece.content : JSON.stringify(piece.content);
}

function largeText(label: string, marker: string): string {
  const repeated = Array.from(
    { length: 45 },
    (_, index) =>
      `${label} ${marker} line_${index.toString().padStart(2, "0")} ` +
      "0123456789abcdef ".repeat(4),
  );
  return [`BEGIN_${label}`, ...repeated, `END_${label}`].join("\n");
}

function memoryPiece(id: string, sourceId: string, previewText: string): MemoryPiece {
  return {
    id,
    sourceKind: "assistant",
    sourceId,
    previewText,
    byteSize: previewText.length,
    createdSeq: 1,
    selector: { kind: "whole" },
    contentHash: `${id}_hash`,
  };
}

function materialized(piece: MemoryPiece, renderText: string): MaterializedMemoryPiece {
  return { ...piece, renderText };
}

function materializedKnownPieces(
  state: MemoryState,
  renderTextByPieceId: Map<string, string>,
): MaterializedMemoryPiece[] {
  return [
    ...state.pieces,
    ...state.archivedTasks.flatMap((task) => task.pieces),
  ].flatMap((piece) => {
    const renderText = renderTextByPieceId.get(piece.id) ?? piece.previewText;
    return [{ ...piece, renderText }];
  });
}

function assertSameIds(actual: string[] | undefined, expected: string[]): void {
  assertEquals([...(actual ?? [])].sort(), [...expected].sort());
}
