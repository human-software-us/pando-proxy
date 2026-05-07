import { assert, assertEquals } from "@std/assert";
import {
  applyWorkingSetUpdate,
  type MemoryManagerClients,
  type PieceDropBatchRequest,
  type PieceDropBatchResponse,
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
    createdSeq: 1,
    pointer: { selector: { kind: "whole" } },
  }]);
  const prompt = buildPromptMemoryText(
    { ...result.memory, pieces: [materialized(result.memory.pieces[0], "same exact content")] },
    [materialized(result.memory.pieces[0], "same exact content")],
  );
  assert(prompt.includes("same exact content"));
  assert(prompt.includes("<duplicate_marker"));
  assert(prompt.includes(`duplicatePieceId=${duplicate.id}`));
  assert(prompt.includes("duplicateSourceId=source_b"));
  assert(prompt.includes(`canonicalPieceId=${first.id}`));
});

Deno.test("applyWorkingSetUpdate converts model exact_duplicate drops into verified duplicate markers", async () => {
  const oldPiece: MemoryPiece = {
    ...memoryPiece("old:0", "old", "same exact content"),
    sourceKind: "user",
    contentHash: "old_nonmatching_hash",
  };
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      title: "Task 1",
      pieceIds: [oldPiece.id],
      startedRound: 1,
      lastRound: 1,
    },
    archivedTasks: [],
    pieces: [oldPiece],
    processedSourceIds: [oldPiece.sourceId],
  };
  const duplicate = textSpanDraft(
    "new:0",
    "new",
    "wrapper before same exact content wrapper after",
    15,
    33,
  );
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === duplicate.id,
          reason: piece.id === duplicate.id ? "exact_duplicate" as const : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    state,
    [duplicate],
    { kind: "same_task" },
    clients,
    [materialized(oldPiece, "<segment start=0 end=18>\nsame exact content\n</segment>")],
  );

  assertEquals(result.acceptedPruneDropPieceIds, []);
  assertEquals(result.duplicateDroppedPieceIds, [duplicate.id]);
  assertEquals(result.droppedNewPieceIds, [duplicate.id]);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [oldPiece.id]);
  assertEquals(result.memory.pieces[0].duplicateSources, [{
    pieceId: duplicate.id,
    sourceId: duplicate.sourceId,
    sourceKind: duplicate.sourceKind,
    createdSeq: 2,
    pointer: { selector: duplicate.selector },
  }]);
});

Deno.test("applyWorkingSetUpdate keeps model exact_duplicate drops when local rendered text does not match", async () => {
  const oldPiece: MemoryPiece = {
    ...memoryPiece("old:0", "old", "different retained content"),
    sourceKind: "user",
    contentHash: "old_nonmatching_hash",
  };
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      title: "Task 1",
      pieceIds: [oldPiece.id],
      startedRound: 1,
      lastRound: 1,
    },
    archivedTasks: [],
    pieces: [oldPiece],
    processedSourceIds: [oldPiece.sourceId],
  };
  const allegedDuplicate = textSpanDraft(
    "new:0",
    "new",
    "wrapper before same exact content wrapper after",
    15,
    33,
  );
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === allegedDuplicate.id,
          reason: piece.id === allegedDuplicate.id ? "exact_duplicate" as const : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    state,
    [allegedDuplicate],
    { kind: "same_task" },
    clients,
    [materialized(oldPiece, "different retained content")],
  );

  assertEquals(result.acceptedPruneDropPieceIds, []);
  assertEquals(result.duplicateDroppedPieceIds, []);
  assertEquals(result.droppedNewPieceIds, []);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [oldPiece.id, allegedDuplicate.id]);
  assertEquals(result.memory.pieces[0].duplicateSources, undefined);
});

Deno.test("applyWorkingSetUpdate rejects old-task switch reason unless it applies to an old piece during new_task", async () => {
  const currentPiece = memoryPiece("source_current:0", "source_current", "current task fact");
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      title: "Task 1",
      pieceIds: [currentPiece.id],
      startedRound: 1,
      lastRound: 1,
    },
    archivedTasks: [],
    pieces: [currentPiece],
    processedSourceIds: ["source_current"],
  };
  const newPiece = draft("source_new:0", "source_new", "MUST_KEEP_CURRENT");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === newPiece.id,
          reason: piece.id === newPiece.id ? "old_task_after_confirmed_task_switch" : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "same_task" },
    clients,
    [materialized(currentPiece, "current task fact")],
  );

  assertEquals(result.acceptedPruneDropPieceIds, []);
  assertEquals(result.keptNewPieceIds, [newPiece.id]);
  assertEquals(result.droppedNewPieceIds, []);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [currentPiece.id, newPiece.id]);
});

Deno.test("applyWorkingSetUpdate rejects old-task switch reason for pieces from the new task round", async () => {
  const oldPiece = {
    ...memoryPiece("source_old:0", "source_old", "not actually older than the new task"),
    createdSeq: 2,
  };
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      title: "Task 1",
      pieceIds: [oldPiece.id],
      startedRound: 1,
      lastRound: 1,
    },
    archivedTasks: [],
    pieces: [oldPiece],
    processedSourceIds: ["source_old"],
  };
  const newPiece = draft("source_new:0", "source_new", "new task fact");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === oldPiece.id,
          reason: piece.id === oldPiece.id ? "old_task_after_confirmed_task_switch" : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "new_task" },
    clients,
    [materialized(oldPiece, "not actually older than the new task")],
  );

  assertEquals(result.acceptedPruneDropPieceIds, []);
  assertEquals(result.sanityRejectedDropPieceIds, []);
  assertEquals(result.memory.pieces.map((piece) => piece.id).sort(), [newPiece.id, oldPiece.id]);
});

Deno.test("applyWorkingSetUpdate allows old-task switch reason for old pieces during new_task", async () => {
  const oldPiece = memoryPiece("source_old:0", "source_old", "old task only");
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      title: "Task 1",
      pieceIds: [oldPiece.id],
      startedRound: 1,
      lastRound: 1,
    },
    archivedTasks: [],
    pieces: [oldPiece],
    processedSourceIds: ["source_old"],
  };
  const newPiece = draft("source_new:0", "source_new", "new task fact");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === oldPiece.id,
          reason: piece.id === oldPiece.id ? "old_task_after_confirmed_task_switch" : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "new_task" },
    clients,
    [materialized(oldPiece, "old task only")],
  );

  assertEquals(result.acceptedPruneDropPieceIds, [oldPiece.id]);
  assertEquals(result.droppedOldPieceIds, [oldPiece.id]);
  assertEquals(result.keptNewPieceIds, [newPiece.id]);
  assertEquals(result.memory.archivedTasks.map((task) => task.id), ["task_1"]);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [newPiece.id]);
});

Deno.test("applyWorkingSetUpdate collapses new-task old/new duplicates after prune and prefers the new piece", async () => {
  const first = draft("source_a:0", "source_a", "same exact content");
  const firstResult = await applyWorkingSetUpdate(
    emptyState(),
    [first],
    { kind: "new_task" },
    keepAllClients,
  );
  const second = draft("source_b:0", "source_b", "same exact content");

  const result = await applyWorkingSetUpdate(
    firstResult.memory,
    [second],
    { kind: "new_task" },
    keepAllClients,
    [materialized(firstResult.memory.pieces[0], "same exact content")],
  );

  assertEquals(result.memory.archivedTasks.map((task) => task.id), [
    firstResult.memory.activeTask!.id,
  ]);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [second.id]);
  assertEquals(result.droppedOldPieceIds, [first.id]);
  assertEquals(result.keptNewPieceIds, [second.id]);
  assertEquals(result.duplicateDroppedPieceIds, [first.id]);
  assertEquals(result.memory.pieces[0].duplicateSources, [{
    pieceId: first.id,
    sourceId: first.sourceId,
    sourceKind: first.sourceKind,
    createdSeq: 1,
    pointer: { selector: { kind: "whole" } },
  }]);
  const prompt = buildPromptMemoryText(
    { ...result.memory, pieces: [materialized(result.memory.pieces[0], "same exact content")] },
    [materialized(result.memory.pieces[0], "same exact content")],
  );
  assert(
    prompt.indexOf(`<duplicate_marker duplicatePieceId=${first.id}`) <
      prompt.indexOf(`<piece pieceId=${second.id}`),
  );
  assert(prompt.includes(`canonicalPieceId=${second.id}`));
});

Deno.test("applyWorkingSetUpdate keeps new duplicate when old canonical is pruned during new_task", async () => {
  const first = draft("source_a:0", "source_a", "same exact content");
  const firstResult = await applyWorkingSetUpdate(
    emptyState(),
    [first],
    { kind: "new_task" },
    keepAllClients,
  );
  const second = draft("source_b:0", "source_b", "same exact content");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === first.id,
          reason: piece.id === first.id ? "old_task_after_confirmed_task_switch" : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    firstResult.memory,
    [second],
    { kind: "new_task" },
    clients,
    [materialized(firstResult.memory.pieces[0], "same exact content")],
  );

  assertEquals(result.memory.pieces.map((piece) => piece.id), [second.id]);
  assertEquals(result.keptNewPieceIds, [second.id]);
  assertEquals(result.droppedOldPieceIds, [first.id]);
  assertEquals(result.duplicateDroppedPieceIds, []);
});

Deno.test("applyWorkingSetUpdate does not send supersession hints or primary keys to prune", async () => {
  const piece: PieceDraft = {
    ...draft("source_1:0", "source_1", "remember exact token ALPHA-123"),
    pointer: {
      primaryKey: "explicit-primary-key",
      path: "src/example.ts",
    },
  };
  let captured: PieceDropBatchRequest | null = null;
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) => {
      captured = request;
      return Promise.resolve({
        decisions: request.evaluatedPieces.map((candidate) => ({
          pieceId: candidate.id,
          drop: false,
          reason: null,
        })),
      });
    },
  };

  await applyWorkingSetUpdate(
    emptyState(),
    [piece],
    { kind: "new_task" },
    clients,
  );

  const capturedRequest = captured as PieceDropBatchRequest | null;
  assert(capturedRequest);
  assert(!("supersessionHints" in capturedRequest));
  assert(!("primaryKey" in capturedRequest.candidateManifest[0]));
  assert(!("primaryKey" in capturedRequest.evaluatedPieces[0]));
});

Deno.test("applyWorkingSetUpdate ignores removed supersession drop reason", async () => {
  const piece = draft("source_1:0", "source_1", "remember exact token ALPHA-123");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((candidate) => ({
          pieceId: candidate.id,
          drop: true,
          reason: "superseded_by_newer_exact_source",
        })),
      } as unknown as PieceDropBatchResponse),
  };

  const result = await applyWorkingSetUpdate(
    emptyState(),
    [piece],
    { kind: "new_task" },
    clients,
  );

  assertEquals(result.acceptedPruneDropPieceIds, []);
  assertEquals(result.keptNewPieceIds, [piece.id]);
  assertEquals(result.droppedNewPieceIds, []);
  assertEquals(result.memory.pieces.map((memoryPiece) => memoryPiece.id), [piece.id]);
});

Deno.test("applyWorkingSetUpdate drops old active pieces with accepted full-payload prune decisions", async () => {
  const oldPiece = memoryPiece("source_old:0", "source_old", "old assistant restatement");
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      title: "Task 1",
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

Deno.test("applyWorkingSetUpdate accepts normalized prune decisions", async () => {
  const piece = draft("source_1:0", "source_1", "transient reply OK only");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: () =>
      Promise.resolve({
        decisions: [{
          pieceId: piece.id,
          drop: true,
          reason: "transient_format_request_only",
        }],
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

Deno.test("applyWorkingSetUpdate evaluates a single large piece above the normal prune batch limit", async () => {
  const text = "large assistant chatter ".repeat(400);
  const piece = draftKind("source_large:0", "source_large", "assistant", text);
  const pruneRequests: PieceDropBatchRequest[] = [];
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pruneBatchTokenLimit: 1,
    pruneSingleBatchTokenLimit: 50_000,
    pieceDropBatch: (request: PieceDropBatchRequest) => {
      pruneRequests.push(request);
      return Promise.resolve({
        decisions: request.evaluatedPieces.map((candidate) => ({
          pieceId: candidate.id,
          drop: candidate.id === piece.id,
          reason: candidate.id === piece.id ? "pure_ack_or_chatter" : null,
        })),
      });
    },
  };

  const result = await applyWorkingSetUpdate(
    emptyState(),
    [piece],
    { kind: "new_task" },
    clients,
  );

  assertEquals(pruneRequests.length, 1);
  assertEquals(pruneRequests[0].evaluatedPieces.map((candidate) => candidate.id), [piece.id]);
  assertEquals(result.droppedNewPieceIds, [piece.id]);
  assertEquals(result.memory.pieces, []);
});

Deno.test("applyWorkingSetUpdate keeps a single large piece that exceeds the single batch limit", async () => {
  const text = "large assistant chatter ".repeat(400);
  const piece = draftKind("source_too_large:0", "source_too_large", "assistant", text);
  const pruneRequests: PieceDropBatchRequest[] = [];
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pruneBatchTokenLimit: 1,
    pruneSingleBatchTokenLimit: 1,
    pieceDropBatch: (request: PieceDropBatchRequest) => {
      pruneRequests.push(request);
      return Promise.resolve({
        decisions: request.evaluatedPieces.map((candidate) => ({
          pieceId: candidate.id,
          drop: true,
          reason: "pure_ack_or_chatter",
        })),
      });
    },
  };

  const result = await applyWorkingSetUpdate(
    emptyState(),
    [piece],
    { kind: "new_task" },
    clients,
  );

  assertEquals(pruneRequests.length, 0);
  assertEquals(result.keptNewPieceIds, [piece.id]);
  assertEquals(result.droppedNewPieceIds, []);
  assertEquals(result.memory.pieces.map((memoryPiece) => memoryPiece.id), [piece.id]);
});

Deno.test("applyWorkingSetUpdate archives old task identity and can rescue old pieces on a new task", async () => {
  const oldPiece = memoryPiece("source_old:0", "source_old", "old task fact");
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      title: "Task 1",
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

  assertEquals(result.keptOldPieceIds, [oldPiece.id]);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [oldPiece.id, newPiece.id]);
  assertEquals(result.memory.activeTask?.id !== "task_1", true);
  assertEquals(result.memory.activeTask?.pieceIds, [oldPiece.id, newPiece.id]);
  assertEquals(result.memory.archivedTasks.map((task) => task.id), ["task_1"]);
  assertEquals(result.memory.archivedTasks[0].pieces.map((piece) => piece.id), [oldPiece.id]);
});

Deno.test("applyWorkingSetUpdate archives old task identity and drops old pieces when prune rejects them", async () => {
  const oldPiece = memoryPiece("source_old:0", "source_old", "old task fact");
  const state: MemoryState = {
    roundSeq: 1,
    activeTask: {
      id: "task_1",
      title: "Task 1",
      pieceIds: [oldPiece.id],
      startedRound: 1,
      lastRound: 1,
    },
    archivedTasks: [],
    pieces: [oldPiece],
    processedSourceIds: ["source_old"],
  };
  const newPiece = draft("source_new:0", "source_new", "start unrelated task");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.createdSeq !== undefined &&
            request.activeTask !== null &&
            piece.createdSeq < request.activeTask.startedRound,
          reason: piece.createdSeq !== undefined &&
              request.activeTask !== null &&
              piece.createdSeq < request.activeTask.startedRound
            ? "old_task_after_confirmed_task_switch"
            : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "new_task" },
    clients,
    [materialized(oldPiece, "old task fact")],
  );

  assertEquals(result.droppedOldPieceIds, [oldPiece.id]);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [newPiece.id]);
  assertEquals(result.memory.activeTask?.id !== "task_1", true);
  assertEquals(result.memory.activeTask?.pieceIds, [newPiece.id]);
  assertEquals(result.memory.archivedTasks.map((task) => task.id), ["task_1"]);
  assertEquals(result.memory.archivedTasks[0].pieces.map((piece) => piece.id), [oldPiece.id]);
});

Deno.test("applyWorkingSetUpdate rejects non-structural prune collapse to assistant-only memory", async () => {
  const userPiece = draft("source_user:0", "source_user", "current task requirement");
  const assistantPiece = draftKind(
    "source_assistant:0",
    "source_assistant",
    "assistant",
    "final answer chatter",
  );
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === userPiece.id,
          reason: piece.id === userPiece.id ? "clearly_unrelated_to_current_work" : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    emptyState(),
    [userPiece, assistantPiece],
    { kind: "new_task" },
    clients,
  );

  assertEquals(result.droppedNewPieceIds, []);
  assertEquals(result.acceptedPruneDropPieceIds, []);
  assertEquals(result.sanityRejectedDropPieceIds, [userPiece.id]);
  assertSameIds(result.memory.pieces.map((piece) => piece.id), [
    userPiece.id,
    assistantPiece.id,
  ]);
});

Deno.test("applyWorkingSetUpdate allows structural drops even when only assistant memory remains", async () => {
  const userPiece = draft("source_user:0", "source_user", "current task requirement");
  const assistantPiece = draftKind(
    "source_assistant:0",
    "source_assistant",
    "assistant",
    "final answer chatter",
  );
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === userPiece.id,
          reason: piece.id === userPiece.id ? "explicitly_invalidated_by_user" : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    emptyState(),
    [userPiece, assistantPiece],
    { kind: "new_task" },
    clients,
  );

  assertEquals(result.droppedNewPieceIds, [userPiece.id]);
  assertEquals(result.memory.pieces.map((piece) => piece.id), [assistantPiece.id]);
});

Deno.test("applyWorkingSetUpdate revives previous task by relative index", async () => {
  const currentPiece = memoryPiece("source_current:0", "source_current", "current task fact");
  const archivedPiece = memoryPiece("source_archived:0", "source_archived", "archived task fact");
  const state: MemoryState = {
    roundSeq: 3,
    activeTask: {
      id: "task_current",
      title: "Current task",
      pieceIds: [currentPiece.id],
      startedRound: 3,
      lastRound: 3,
    },
    archivedTasks: [{
      id: "task_archived",
      title: "Archived task",
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
  assertEquals(result.memory.pieces.map((piece) => piece.id), [
    archivedPiece.id,
    currentPiece.id,
    newPiece.id,
  ]);
  assertEquals(result.memory.archivedTasks.map((task) => task.id), ["task_current"]);
  assertEquals(result.memory.archivedTasks[0].pieces.map((piece) => piece.id), [
    currentPiece.id,
  ]);
});

Deno.test("applyWorkingSetUpdate can drop current-task pieces during revive pruning", async () => {
  const currentPiece = memoryPiece("source_current:0", "source_current", "current task fact");
  const archivedPiece = memoryPiece("source_archived:0", "source_archived", "archived task fact");
  const state: MemoryState = {
    roundSeq: 3,
    activeTask: {
      id: "task_current",
      title: "Current task",
      pieceIds: [currentPiece.id],
      startedRound: 3,
      lastRound: 3,
    },
    archivedTasks: [{
      id: "task_archived",
      title: "Archived task",
      pieces: [archivedPiece],
      startedRound: 1,
      archivedRound: 2,
    }],
    pieces: [currentPiece],
    processedSourceIds: ["source_current", "source_archived"],
  };
  const newPiece = draft("source_new:0", "source_new", "continue previous task");
  const clients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === currentPiece.id,
          reason: piece.id === currentPiece.id ? "clearly_unrelated_to_current_work" : null,
        })),
      }),
  };

  const result = await applyWorkingSetUpdate(
    state,
    [newPiece],
    { kind: "revive_task", relativeIndex: -1 },
    clients,
    [
      materialized(currentPiece, "current task fact"),
      materialized(archivedPiece, "archived task fact"),
    ],
  );

  assertEquals(result.memory.activeTask?.id, "task_archived");
  assertEquals(result.memory.pieces.map((piece) => piece.id), [archivedPiece.id, newPiece.id]);
  assertEquals(result.memory.archivedTasks.map((task) => task.id), ["task_current"]);
  assertEquals(result.memory.archivedTasks[0].pieces.map((piece) => piece.id), [
    currentPiece.id,
  ]);
});

Deno.test("applyWorkingSetUpdate dedupes revive base before prune and prefers revived pieces", async () => {
  const currentPiece: MemoryPiece = {
    ...memoryPiece("source_current:0", "source_current", "same task fact"),
    contentHash: "shared_hash",
  };
  const archivedPiece: MemoryPiece = {
    ...memoryPiece("source_archived:0", "source_archived", "same task fact"),
    contentHash: "shared_hash",
  };
  const state: MemoryState = {
    roundSeq: 3,
    activeTask: {
      id: "task_current",
      title: "Current task",
      pieceIds: [currentPiece.id],
      startedRound: 3,
      lastRound: 3,
    },
    archivedTasks: [{
      id: "task_archived",
      title: "Archived task",
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
      materialized(currentPiece, "same task fact"),
      materialized(archivedPiece, "same task fact"),
    ],
  );

  assertEquals(result.memory.activeTask?.id, "task_archived");
  assertEquals(result.memory.pieces.map((piece) => piece.id), [archivedPiece.id, newPiece.id]);
  assertEquals(result.duplicateDroppedPieceIds, [currentPiece.id]);
  assertEquals(result.memory.pieces[0].duplicateSources, [{
    pieceId: currentPiece.id,
    sourceId: currentPiece.sourceId,
    sourceKind: currentPiece.sourceKind,
    createdSeq: currentPiece.createdSeq,
    pointer: { selector: currentPiece.selector },
  }]);
  assertEquals(result.memory.archivedTasks.map((task) => task.id), ["task_current"]);
  assertEquals(result.memory.archivedTasks[0].pieces.map((piece) => piece.id), [
    currentPiece.id,
  ]);
});

Deno.test("applyWorkingSetUpdate keeps current task when revive index is unavailable", async () => {
  const currentPiece = memoryPiece("source_current:0", "source_current", "current task fact");
  const state: MemoryState = {
    roundSeq: 3,
    activeTask: {
      id: "task_current",
      title: "Current task",
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
        decisions: request.evaluatedPieces.map((piece) => {
          const shouldDrop = piece.contentText.includes("DROP_ME") ||
            (request.taskRoute.kind === "new_task" &&
              request.activeTask !== null &&
              piece.createdSeq !== undefined &&
              piece.createdSeq < request.activeTask.startedRound);
          return {
            pieceId: piece.id,
            drop: shouldDrop,
            reason: shouldDrop
              ? piece.contentText.includes("DROP_ME")
                ? "pure_ack_or_chatter"
                : "old_task_after_confirmed_task_switch"
              : null,
          };
        }),
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
  assertEquals(state.pieces.map((piece) => piece.id), [
    "a_root:0",
    "a_keep:0",
    "d_root:0",
    "a_revival:0",
  ]);
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
  assertEquals(state.pieces.map((piece) => piece.id), [
    "a_root:0",
    "a_keep:0",
    "d_root:0",
    "a_revival:0",
    "d_revival:0",
  ]);
  assertEquals(state.archivedTasks.map((task) => task.id), [taskBId, taskCId, taskAId]);
  assertEquals(
    state.archivedTasks.find((task) => task.id === taskAId)?.pieces.map((piece) => piece.id),
    ["a_root:0", "a_keep:0", "d_root:0", "a_revival:0"],
  );

  await step({ kind: "same_task" }, "d_noise:0", "Task D final transient DROP_ME");
  await step({ kind: "same_task" }, "d_keep:0", "Task D final useful KEEP src/d.ts");
  assertEquals(state.activeTask?.id, taskDId);
  assertEquals(state.pieces.map((piece) => piece.id), [
    "a_root:0",
    "a_keep:0",
    "d_root:0",
    "a_revival:0",
    "d_revival:0",
    "d_keep:0",
  ]);
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
        decisions: request.evaluatedPieces.map((piece) => {
          const shouldDrop = piece.contentText.includes("DROP_LARGE") ||
            (request.taskRoute.kind === "new_task" &&
              request.activeTask !== null &&
              piece.createdSeq !== undefined &&
              piece.createdSeq < request.activeTask.startedRound);
          return {
            pieceId: piece.id,
            drop: shouldDrop,
            reason: shouldDrop
              ? piece.contentText.includes("DROP_LARGE")
                ? "clearly_unrelated_to_current_work"
                : "old_task_after_confirmed_task_switch"
              : null,
          };
        }),
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
    "ld_user:0",
    "ld_keep_1:0",
    "la_recall:0",
  ]);

  await step({ kind: "revive_task", relativeIndex: -1 }, [
    draft("ld_recall:0", "ld_recall", "Recall displaced large Task D KEEP_LARGE"),
  ]);
  assertEquals(state.activeTask?.id, taskDId);
  assertEquals(state.archivedTasks.map((task) => task.id), [taskBId, taskCId, taskAId]);
  assertSameIds(
    state.archivedTasks.find((task) => task.id === taskAId)?.pieces.map((piece) => piece.id),
    [
      "la_user:0",
      "la_keep_1:0",
      "la_keep_2:0",
      "la_keep_3:0",
      "ld_user:0",
      "ld_keep_1:0",
      "la_recall:0",
    ],
  );
  assertSameIds(state.pieces.map((piece) => piece.id), [
    "la_user:0",
    "la_keep_1:0",
    "la_keep_2:0",
    "la_keep_3:0",
    "la_recall:0",
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
    "la_user:0",
    "la_keep_1:0",
    "la_keep_2:0",
    "la_keep_3:0",
    "la_recall:0",
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

function textSpanDraft(
  id: string,
  sourceId: string,
  sourceText: string,
  start: number,
  end: number,
): PieceDraft {
  return {
    id,
    sourceKind: "user",
    sourceId,
    content: {
      kind: "chunks",
      sourceTextLength: sourceText.length,
      segments: [{ start, end, text: sourceText.slice(start, end) }],
    },
    previewText: sourceText.slice(start, end),
    byteSize: end - start,
    selector: { kind: "chunks", chunks: [{ start, end }] },
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
