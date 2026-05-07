import { assert, assertEquals } from "@std/assert";

import { chunkRoundSources } from "../src/chunking.ts";
import type { ProxyConfig } from "../src/config.ts";
import { updateMemoryForCompletedRound } from "../src/memory_pipeline.ts";
import {
  applyWorkingSetUpdate,
  type MemoryManagerClients,
  type PieceDropBatchRequest,
  requestTaskRoute,
} from "../src/working_set_manager.ts";
import type {
  MaterializedMemoryPiece,
  MemoryState,
  PieceDraft,
  SourceKind,
} from "../src/memory_state.ts";
import { buildPromptMemoryText } from "../src/prompt_view.ts";
import type { StructuredClients } from "../src/structured_model.ts";
import { runResponsesLoop } from "../src/upstream.ts";

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

Deno.test("multi-round 01 same-task retention keeps visible exact context without recall", async () => {
  const session = new ManualMemorySession();

  const first = await session.round(
    draft("r1_user:0", "r1_user", "user", "EXACT_ALPHA=alpha-001"),
    { kind: "new_task" },
  );
  const taskId = first.memory.activeTask?.id;

  await session.round(
    draft("r2_tool:0", "r2_tool", "tool", "tool confirmed EXACT_ALPHA", "exec_command"),
    { kind: "same_task" },
  );
  await session.round(
    draft("r3_assistant:0", "r3_assistant", "assistant", "I can use EXACT_ALPHA."),
    { kind: "same_task" },
  );
  await session.round(
    draft("r4_user:0", "r4_user", "user", "What is EXACT_ALPHA?"),
    { kind: "same_task" },
  );

  assertEquals(session.state.archivedTasks.length, 0);
  assertEquals(session.state.activeTask?.id, taskId);
  assertEquals(session.pieceIds(), ["r1_user:0", "r2_tool:0", "r3_assistant:0", "r4_user:0"]);
  const prompt = session.prompt();
  assert(prompt.includes("EXACT_ALPHA=alpha-001"));
  assert(!prompt.includes("<archive>"));
});

Deno.test("multi-round 02 route failure falls back to same task without losing pieces", async () => {
  const session = new ManualMemorySession();
  const routingFailsClients: MemoryManagerClients = {
    ...keepAllClients,
    taskRoute: () => Promise.reject(new Error("route unavailable")),
  };

  await session.round(
    draft("a1:0", "a1", "user", "TASK_A_TOKEN=route-fallback"),
    { kind: "new_task" },
  );
  const taskId = session.state.activeTask?.id;

  const fallbackRoute = await requestTaskRoute(
    session.state,
    [{ id: "a2", sourceId: "a2", content: "continue A", previewText: "continue A" }],
    routingFailsClients,
  );
  assertEquals(fallbackRoute, { kind: "same_task" });

  const second = await session.round(
    draft("a2:0", "a2", "user", "continue A after route failure"),
    fallbackRoute,
    routingFailsClients,
  );
  await session.round(
    draft("a3:0", "a3", "assistant", "still task A"),
    { kind: "same_task" },
  );
  await session.round(
    draft("a4:0", "a4", "user", "repeat TASK_A_TOKEN"),
    { kind: "same_task" },
  );

  assertEquals(second.taskRoute, { kind: "same_task" });
  assertEquals(session.state.activeTask?.id, taskId);
  assertEquals(session.state.archivedTasks.length, 0);
  assertEquals(session.pieceIds(), ["a1:0", "a2:0", "a3:0", "a4:0"]);
  assert(session.state.pieces.some((piece) => piece.previewText.includes("TASK_A_TOKEN")));
});

Deno.test("multi-round 03 new task archives old identity and rescues shared old pieces", async () => {
  const session = new ManualMemorySession();

  await session.roundMany([
    draft("a_shared:0", "a_shared", "user", "SHARED_CONFIG=enabled"),
    draft("a_only:0", "a_only", "user", "A_ONLY_SECRET=remove_me"),
  ], { kind: "new_task" });
  const oldTaskId = session.state.activeTask?.id;

  const pruneOldAOnly: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === "a_only:0",
          reason: piece.id === "a_only:0" ? "old_task_after_confirmed_task_switch" : null,
        })),
      }),
  };
  const second = await session.round(
    draft("b1:0", "b1", "user", "Task B uses SHARED_CONFIG"),
    { kind: "new_task" },
    pruneOldAOnly,
  );
  await session.round(
    draft("b2:0", "b2", "tool", "B tool result with SHARED_CONFIG", "exec_command"),
    { kind: "same_task" },
  );
  await session.round(
    draft("b3:0", "b3", "user", "What is SHARED_CONFIG?"),
    { kind: "same_task" },
  );

  assertEquals(session.state.archivedTasks.map((task) => task.id), [oldTaskId]);
  assertEquals(second.droppedOldPieceIds, ["a_only:0"]);
  assert(session.state.pieces.some((piece) => piece.id === "a_shared:0"));
  assert(!session.state.pieces.some((piece) => piece.id === "a_only:0"));
  assertEquals(session.state.activeTask?.pieceIds.includes("a_shared:0"), true);
  assertEquals(session.pieceIds(), ["a_shared:0", "b1:0", "b2:0", "b3:0"]);
});

Deno.test("multi-round 04 new-task prune failure archives old identity but keeps old pieces active", async () => {
  const session = new ManualMemorySession();
  const pruneFailsClients: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: () => Promise.reject(new Error("prune failed")),
  };

  await session.roundMany([
    draft("a1:0", "a1", "user", "OLD_ONE=kept_on_failure"),
    draft("a2:0", "a2", "tool", "OLD_TWO=also_kept", "exec_command"),
  ], { kind: "new_task" });
  const oldTaskId = session.state.activeTask?.id;

  const second = await session.round(
    draft("b1:0", "b1", "user", "new task starts"),
    { kind: "new_task" },
    pruneFailsClients,
  );
  await session.round(
    draft("b2:0", "b2", "assistant", "continuing B"),
    { kind: "same_task" },
  );
  await session.round(
    draft("b3:0", "b3", "user", "inspect active"),
    { kind: "same_task" },
  );

  assertEquals(session.state.archivedTasks.map((task) => task.id), [oldTaskId]);
  assert(session.state.activeTask?.id !== oldTaskId);
  assertEquals(second.acceptedPruneDropPieceIds, []);
  assertEquals(second.keptOldPieceIds, ["a1:0", "a2:0"]);
  assert(session.pieceIds().includes("a1:0"));
  assert(session.pieceIds().includes("a2:0"));
  assert(session.pieceIds().includes("b1:0"));
  assert(session.prompt().includes("OLD_ONE=kept_on_failure"));
});

Deno.test("multi-round 05 revive selects the previous archived task and archives current", async () => {
  const session = new ManualMemorySession();

  await session.round(draft("a_piece:0", "a_piece", "user", "TASK_A_VALUE"), {
    kind: "new_task",
  });
  const taskA = session.state.activeTask?.id;

  await session.round(
    draft("b_piece:0", "b_piece", "user", "TASK_B_VALUE"),
    { kind: "new_task" },
    dropPieceIdsClient(["a_piece:0"]),
  );
  const taskB = session.state.activeTask?.id;

  await session.round(
    draft("c_piece:0", "c_piece", "user", "TASK_C_VALUE"),
    { kind: "new_task" },
    dropPieceIdsClient(["b_piece:0"]),
  );
  const taskC = session.state.activeTask?.id;

  const fourth = await session.round(
    draft("revive_b:0", "revive_b", "user", "continue revived B"),
    { kind: "revive_task", relativeIndex: -1 },
  );

  assertEquals(fourth.taskRoute, { kind: "revive_task", relativeIndex: -1 });
  assertEquals(session.state.activeTask?.id, taskB);
  assert(session.state.archivedTasks.some((task) => task.id === taskA));
  assert(session.state.archivedTasks.some((task) => task.id === taskC));
  assertEquals(session.pieceIds(), ["b_piece:0", "revive_b:0"]);
  assert(session.state.pieces.some((piece) => piece.previewText.includes("TASK_B_VALUE")));
});

Deno.test("multi-round 06 invalid revive falls back to same task without creating a new task", async () => {
  const session = new ManualMemorySession();

  await session.round(draft("a_piece:0", "a_piece", "user", "TASK_A"), {
    kind: "new_task",
  });
  const taskA = session.state.activeTask?.id;

  await session.round(
    draft("b_piece:0", "b_piece", "user", "TASK_B"),
    { kind: "new_task" },
    dropPieceIdsClient(["a_piece:0"]),
  );
  const taskB = session.state.activeTask?.id;

  await session.round(draft("b_more:0", "b_more", "user", "still B"), {
    kind: "same_task",
  });
  const fourth = await session.round(
    draft("invalid_recall:0", "invalid_recall", "user", "try impossible revive"),
    { kind: "revive_task", relativeIndex: -99 },
  );

  assertEquals(fourth.taskRoute, { kind: "same_task" });
  assertEquals(session.state.activeTask?.id, taskB);
  assertEquals(session.state.archivedTasks.map((task) => task.id), [taskA]);
  assertEquals(session.pieceIds(), ["b_piece:0", "b_more:0", "invalid_recall:0"]);
  assert(!session.state.activeTask?.id.includes("task_4_"));
});

Deno.test("multi-round 07 old-task switch reason only drops when route and piece applicability match", async () => {
  const session = new ManualMemorySession();

  await session.round(draft("old:0", "old", "user", "old task fact"), { kind: "new_task" });
  const second = await session.round(
    draft("same_bad:0", "same_bad", "user", "same task tries bad old-task reason"),
    { kind: "same_task" },
    oldTaskReasonForIdsClient(["old:0"]),
  );
  const third = await session.round(
    draft("new_bad:0", "new_bad", "user", "new piece wrongly gets old-task reason"),
    { kind: "new_task" },
    oldTaskReasonForIdsClient(["new_bad:0"]),
  );

  assertEquals(second.acceptedPruneDropPieceIds, []);
  assertEquals(third.acceptedPruneDropPieceIds, []);
  assertEquals(session.pieceIds(), ["old:0", "same_bad:0", "new_bad:0"]);

  const fourth = await session.round(
    draft("new_good:0", "new_good", "user", "valid switch drops old facts"),
    { kind: "new_task" },
    oldTaskReasonForIdsClient(["old:0", "same_bad:0", "new_bad:0"]),
  );

  assertEquals(fourth.acceptedPruneDropPieceIds.sort(), [
    "new_bad:0",
    "old:0",
    "same_bad:0",
  ]);
  assertEquals(session.pieceIds(), ["new_good:0"]);
});

Deno.test("multi-round 08 missing and removed drop reasons keep pieces across rounds", async () => {
  const session = new ManualMemorySession();

  await session.round(
    draft("value:0", "value", "user", "UNKNOWN_REASON_VALUE=keep"),
    { kind: "new_task" },
  );
  const second = await session.round(
    draft("ask1:0", "ask1", "user", "continue"),
    { kind: "same_task" },
    dropTargetWithReasonClient("value:0", null),
  );
  const third = await session.round(
    draft("ask2:0", "ask2", "user", "continue again"),
    { kind: "same_task" },
    dropTargetWithReasonClient("value:0", "superseded_by_newer_exact_source"),
  );
  await session.round(draft("ask3:0", "ask3", "user", "what is value"), {
    kind: "same_task",
  });

  assertEquals(second.acceptedPruneDropPieceIds, []);
  assertEquals(third.acceptedPruneDropPieceIds, []);
  assertEquals(session.pieceIds(), ["value:0", "ask1:0", "ask2:0", "ask3:0"]);
});

Deno.test("multi-round 09 assistant-only collapse guard keeps non-assistant evidence", async () => {
  const session = new ManualMemorySession();

  await session.round(
    draft("req:0", "req", "user", "USER_REQUIREMENT=must_keep"),
    { kind: "new_task" },
  );
  await session.round(
    draft("tool:0", "tool", "tool", "TOOL_EVIDENCE=must_keep", "exec_command"),
    { kind: "same_task" },
  );
  await session.round(
    draft("summary:0", "summary", "assistant", "assistant summary only"),
    { kind: "same_task" },
  );
  const fourth = await session.round(
    draft("ask:0", "ask", "user", "check evidence"),
    { kind: "same_task" },
    dropNonAssistantAsUnrelatedClient,
  );

  assertEquals(fourth.acceptedPruneDropPieceIds, []);
  assertEquals(fourth.sanityRejectedDropPieceIds.sort(), ["ask:0", "req:0", "tool:0"]);
  assert(session.state.pieces.some((piece) => piece.id === "req:0"));
  assert(session.state.pieces.some((piece) => piece.id === "tool:0"));
  const prompt = session.prompt();
  assert(prompt.includes("USER_REQUIREMENT=must_keep"));
  assert(prompt.includes("TOOL_EVIDENCE=must_keep"));
});

Deno.test("multi-round 10 structural drops are allowed even when only assistant memory remains", async () => {
  const session = new ManualMemorySession();

  await session.roundMany([
    draft("empty:0", "empty", "user", "   "),
    draft("chatter:0", "chatter", "assistant", "thanks"),
    draft("answer:0", "answer", "assistant", "assistant useful result"),
  ], { kind: "new_task" });

  const second = await session.round(
    draft("noop:0", "noop", "assistant", "ok"),
    { kind: "same_task" },
    structuralDropClient,
  );
  await session.round(draft("more:0", "more", "assistant", "more assistant"), {
    kind: "same_task",
  });
  await session.round(draft("inspect:0", "inspect", "assistant", "inspect"), {
    kind: "same_task",
  });

  assertEquals(second.acceptedPruneDropPieceIds.sort(), ["chatter:0", "empty:0"]);
  assertEquals(second.sanityRejectedDropPieceIds, []);
  assertEquals(session.pieceIds(), ["answer:0", "noop:0", "more:0", "inspect:0"]);
});

Deno.test("multi-round 11 same-task duplicate marker points to canonical full piece", async () => {
  const session = new ManualMemorySession();

  await session.round(draft("x1:0", "x1", "user", "DUPLICATE_X_PAYLOAD"), {
    kind: "new_task",
  });
  const second = await session.round(
    draft("x2:0", "x2", "user", "DUPLICATE_X_PAYLOAD"),
    { kind: "same_task" },
  );
  await session.round(draft("other:0", "other", "user", "unrelated current work"), {
    kind: "same_task",
  });
  await session.round(draft("ask:0", "ask", "user", "show duplicate provenance"), {
    kind: "same_task",
  });

  const prompt = session.prompt();
  assertEquals(second.duplicateDroppedPieceIds, ["x2:0"]);
  assertEquals(
    session.state.pieces.filter((piece) => piece.previewText === "DUPLICATE_X_PAYLOAD").map((
      piece,
    ) => piece.id),
    ["x1:0"],
  );
  assertEquals(session.state.pieces[0].duplicateSources?.map((duplicate) => duplicate.pieceId), [
    "x2:0",
  ]);
  assert(prompt.includes("<duplicate_marker duplicatePieceId=x2:0"));
  assert(prompt.includes("canonicalPieceId=x1:0"));
  assertEquals(prompt.match(/DUPLICATE_X_PAYLOAD/g)?.length ?? 0, 1);
});

Deno.test("multi-round 12 new-task duplicate collapse prefers the new piece as canonical", async () => {
  const session = new ManualMemorySession();

  await session.round(draft("old_x:0", "old_x", "user", "NEW_TASK_DUPLICATE"), {
    kind: "new_task",
  });
  const second = await session.round(
    draft("new_x:0", "new_x", "user", "NEW_TASK_DUPLICATE"),
    { kind: "new_task" },
  );
  await session.round(draft("b_more:0", "b_more", "user", "B continues"), {
    kind: "same_task",
  });
  await session.round(draft("b_ask:0", "b_ask", "user", "check duplicate"), {
    kind: "same_task",
  });

  const prompt = session.prompt();
  assertEquals(second.duplicateDroppedPieceIds, ["old_x:0"]);
  assertEquals(
    session.state.pieces.filter((piece) => piece.previewText === "NEW_TASK_DUPLICATE").map((
      piece,
    ) => piece.id),
    ["new_x:0"],
  );
  assertEquals(session.state.pieces[0].duplicateSources?.map((duplicate) => duplicate.pieceId), [
    "old_x:0",
  ]);
  assert(prompt.includes("<duplicate_marker duplicatePieceId=old_x:0"));
  assert(prompt.includes("canonicalPieceId=new_x:0"));
});

Deno.test("multi-round 13 pruned old duplicate leaves new piece without duplicate marker", async () => {
  const session = new ManualMemorySession();

  await session.round(draft("old_x:0", "old_x", "user", "PRUNE_BEFORE_DUP"), {
    kind: "new_task",
  });
  const second = await session.round(
    draft("new_x:0", "new_x", "user", "PRUNE_BEFORE_DUP"),
    { kind: "new_task" },
    dropPieceIdsClient(["old_x:0"]),
  );
  await session.round(draft("b_more:0", "b_more", "user", "B continuation"), {
    kind: "same_task",
  });
  await session.round(draft("b_ask:0", "b_ask", "user", "check normal piece"), {
    kind: "same_task",
  });

  assertEquals(second.acceptedPruneDropPieceIds, ["old_x:0"]);
  assertEquals(second.duplicateDroppedPieceIds, []);
  assertEquals(session.state.pieces[0].id, "new_x:0");
  assertEquals(session.state.pieces[0].duplicateSources, undefined);
  assertEquals(session.pieceIds(), ["new_x:0", "b_more:0", "b_ask:0"]);
});

Deno.test("multi-round 14 duplicate chain aggregation carries prior duplicate markers forward", async () => {
  const session = new ManualMemorySession();

  await session.round(draft("x_a:0", "x_a", "user", "CHAIN_DUP"), { kind: "new_task" });
  await session.round(draft("x_b:0", "x_b", "user", "CHAIN_DUP"), { kind: "same_task" });
  const third = await session.round(draft("x_c:0", "x_c", "user", "CHAIN_DUP"), {
    kind: "new_task",
  });
  await session.round(draft("ask:0", "ask", "user", "check chain"), { kind: "same_task" });

  const canonical = session.state.pieces.find((piece) => piece.id === "x_c:0");
  const prompt = session.prompt();
  assertEquals(third.duplicateDroppedPieceIds, ["x_a:0"]);
  assertEquals(canonical?.duplicateSources?.map((duplicate) => duplicate.pieceId).sort(), [
    "x_a:0",
    "x_b:0",
  ]);
  assert(prompt.includes("duplicatePieceId=x_a:0"));
  assert(prompt.includes("duplicatePieceId=x_b:0"));
  assert(prompt.includes("canonicalPieceId=x_c:0"));
});

Deno.test("multi-round 15 manifest-only candidates cannot be dropped by a prune batch", async () => {
  const session = new ManualMemorySession();
  const captured: PieceDropBatchRequest[] = [];
  const dropAllManifestClient: MemoryManagerClients = {
    ...keepAllClients,
    pruneBatchTokenLimit: 800,
    pieceDropBatch: (request: PieceDropBatchRequest) => {
      captured.push(request);
      return Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: true,
          reason: "explicitly_invalidated_by_user",
        })),
      });
    },
  };

  await session.roundMany([
    draft("huge:0", "huge", "user", `HUGE_KEEP${"x".repeat(5_000)}`),
    draft("small1:0", "small1", "user", "small drop 1"),
  ], { kind: "new_task" });

  const second = await session.round(
    draft("small2:0", "small2", "user", "small drop 2"),
    { kind: "same_task" },
    dropAllManifestClient,
  );
  await session.round(draft("r3:0", "r3", "user", "continue"), { kind: "same_task" });
  await session.round(draft("r4:0", "r4", "user", "inspect"), { kind: "same_task" });

  assert(
    captured.some((request) =>
      request.candidateManifest.some((piece) => piece.id === "huge:0") &&
      !request.evaluatedPieces.some((piece) => piece.id === "huge:0")
    ),
  );
  assert(second.acceptedPruneDropPieceIds.includes("small1:0"));
  assert(second.acceptedPruneDropPieceIds.includes("small2:0"));
  assert(!second.acceptedPruneDropPieceIds.includes("huge:0"));
  assert(session.state.pieces.some((piece) => piece.id === "huge:0"));
});
Deno.test("multi-round 16 incomplete shared user context keeps non-user pieces unevaluated", async () => {
  const session = new ManualMemorySession();
  const captured: PieceDropBatchRequest[] = [];
  const dropEvaluatedWithSmallSharedContext: MemoryManagerClients = {
    ...keepAllClients,
    pruneBatchTokenLimit: 3_000,
    pieceDropBatch: (request: PieceDropBatchRequest) => {
      captured.push(request);
      return Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: true,
          reason: "explicitly_invalidated_by_user",
        })),
      });
    },
  };

  await session.roundMany([
    draft("u1:0", "u1", "user", `USER_ONE${"a".repeat(8_000)}`),
    draft("u2:0", "u2", "user", `USER_TWO${"b".repeat(8_000)}`),
    draft("tool:0", "tool", "tool", "TOOL_DEPENDS_ON_USERS", "exec_command"),
  ], { kind: "new_task" });

  const second = await session.round(
    draft("u3:0", "u3", "user", "USER_THREE"),
    { kind: "same_task" },
    dropEvaluatedWithSmallSharedContext,
  );
  const secondBatches = [...captured];
  await session.round(draft("r3:0", "r3", "assistant", "assistant later"), {
    kind: "same_task",
  });
  await session.round(draft("r4:0", "r4", "user", "inspect tool"), { kind: "same_task" });

  assert(secondBatches.length > 0);
  assert(
    secondBatches.every((request) =>
      request.evaluatedPieces.every((piece) => piece.sourceKind === "user")
    ),
  );
  assert(!second.acceptedPruneDropPieceIds.includes("tool:0"));
  assert(session.state.pieces.some((piece) => piece.id === "tool:0"));
});

Deno.test("multi-round 17 oversized single candidate is unevaluated and kept", async () => {
  const session = new ManualMemorySession();
  const captured: PieceDropBatchRequest[] = [];
  const dropEvaluatedSmallBudget: MemoryManagerClients = {
    ...keepAllClients,
    pruneBatchTokenLimit: 700,
    pieceDropBatch: (request: PieceDropBatchRequest) => {
      captured.push(request);
      return Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: true,
          reason: "explicitly_invalidated_by_user",
        })),
      });
    },
  };

  await session.round(
    draft("huge_tool:0", "huge_tool", "tool", `TOOL_HUGE${"z".repeat(5_000)}`, "exec_command"),
    { kind: "new_task" },
  );
  const second = await session.round(
    draft("small:0", "small", "user", "small prompt"),
    { kind: "same_task" },
    dropEvaluatedSmallBudget,
  );
  const secondBatches = [...captured];
  await session.round(draft("r3:0", "r3", "user", "continue"), { kind: "same_task" });
  await session.round(draft("r4:0", "r4", "user", "inspect huge"), { kind: "same_task" });

  assert(
    secondBatches.every((request) =>
      !request.evaluatedPieces.some((piece) => piece.id === "huge_tool:0")
    ),
  );
  assert(!second.acceptedPruneDropPieceIds.includes("huge_tool:0"));
  assert(session.state.pieces.some((piece) => piece.id === "huge_tool:0"));
});

Deno.test("multi-round 18 omitted chunk result falls back to whole selector", async () => {
  const session = new ManualMemorySession();
  const chunkClients: StructuredClients = {
    taskRoute: () => Promise.resolve({ kind: "same_task" }),
    sourceChunkBatch: (request) =>
      Promise.resolve({
        results: [{
          sourceId: request.sources[0].sourceId,
          selectors: [{ kind: "whole" }],
        }],
      }),
    pieceDropBatch: (request) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: false,
          reason: null,
        })),
      }),
  };

  const chunked = await chunkRoundSources([
    { sourceId: "included", sourceKind: "user", payload: "INCLUDED_TEXT" },
    { sourceId: "omitted", sourceKind: "user", payload: "OMITTED_WHOLE_TEXT" },
  ], chunkClients);
  await session.roundMany(chunked.pieces, { kind: "new_task" });
  await session.round(draft("r2:0", "r2", "user", "continue"), { kind: "same_task" });
  await session.round(draft("r3:0", "r3", "user", "continue again"), { kind: "same_task" });
  await session.round(draft("r4:0", "r4", "user", "ask omitted"), { kind: "same_task" });

  const omitted = chunked.pieces.find((piece) => piece.sourceId === "omitted");
  assertEquals(omitted?.selector, { kind: "whole" });
  assertEquals(omitted?.content, "OMITTED_WHOLE_TEXT");
  assert(session.state.pieces.some((piece) => piece.sourceId === "omitted"));
});

Deno.test("multi-round 19 malformed chunk failure keeps the source whole", async () => {
  let state = emptyState();
  const validClients: StructuredClients = {
    taskRoute: () => Promise.resolve({ kind: "same_task" }),
    sourceChunkBatch: (request) =>
      Promise.resolve({
        results: request.sources.map((source) => ({
          sourceId: source.sourceId,
          selectors: [{ kind: "whole" }],
        })),
      }),
    pieceDropBatch: (request) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: false,
          reason: null,
        })),
      }),
  };
  const badClients: StructuredClients = {
    ...validClients,
    sourceChunkBatch: () => Promise.reject(new Error("malformed chunk response after retry")),
  };

  const first = await updateMemoryForCompletedRound(
    requestBody("stable task before bad chunk"),
    state,
    {},
    [],
    validClients,
  );
  state = first.memory;
  const badRound = await updateMemoryForCompletedRound(
    requestBody("this round has malformed chunk output"),
    state,
    {},
    [],
    badClients,
  );
  state = badRound.memory;
  const badPiece = state.pieces.find((piece) =>
    piece.previewText.includes("this round has malformed chunk output")
  );
  assertEquals(badPiece?.selector, { kind: "whole" });

  state = (await updateMemoryForCompletedRound(
    requestBody("valid round after failure"),
    state,
    {},
    [],
    validClients,
  )).memory;
  state = (await updateMemoryForCompletedRound(
    requestBody("inspect stable task"),
    state,
    {},
    [],
    validClients,
  )).memory;

  assertEquals(state.roundSeq, 4);
  assertEquals(state.pieces.length, 4);
  assert(state.pieces.some((piece) => piece.previewText.includes("stable task before bad chunk")));
  assert(
    state.pieces.some((piece) =>
      piece.previewText.includes("this round has malformed chunk output")
    ),
  );
  assert(state.pieces.some((piece) => piece.previewText.includes("valid round after failure")));
});

Deno.test("multi-round 20 recall returns archive-only payloads and rejects a fourth call", async () => {
  const session = new ManualMemorySession();
  await session.round(
    draft("old_archive:0", "old_archive", "user", "OLD_EXACT_BLOCK=alpha"),
    { kind: "new_task" },
  );
  await session.round(
    draft("active_now:0", "active_now", "user", "ACTIVE_CURRENT=beta"),
    { kind: "new_task" },
    dropPieceIdsClient(["old_archive:0"]),
  );
  await session.round(draft("active_more:0", "active_more", "user", "more active"), {
    kind: "same_task",
  });
  await session.round(draft("active_ask:0", "active_ask", "user", "ask old"), {
    kind: "same_task",
  });

  let phase: "normal" | "too_many" = "normal";
  let upstreamCalls = 0;
  const capturedBodies: Record<string, unknown>[] = [];
  const upstream = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (request) => {
    const body = await request.json() as Record<string, unknown>;
    capturedBodies.push(body);
    upstreamCalls += 1;
    if (phase === "too_many") {
      return Response.json({
        id: "too_many",
        output: [0, 1, 2, 3].map((index) => ({
          type: "function_call",
          name: "recall",
          call_id: `recall_${index}`,
          arguments: JSON.stringify({ offset: index, limit: 1 }),
        })),
      });
    }
    if (upstreamCalls === 1) {
      return Response.json({
        id: "needs_recall",
        output: [{
          type: "function_call",
          name: "recall",
          call_id: "recall_1",
          arguments: JSON.stringify({ offset: 0, limit: 10 }),
        }],
      });
    }
    return Response.json({
      id: "done",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "recovered" }],
      }],
    });
  });

  try {
    const config = testProxyConfig(`http://127.0.0.1:${upstream.addr.port}`);
    const options = {
      authHeader: null,
      body: requestBody("recall old"),
    };
    const memory = {
      ...session.state,
      pieces: session.materializedActivePieces(),
    };
    const resolveArchived = (sourceIds: string[]) =>
      Promise.resolve(sourceIds.map((sourceId) => ({
        sourceId,
        sourceKind: "user" as const,
        payload: sourceId === "old_archive" ? "OLD_EXACT_BLOCK=alpha" : "UNEXPECTED_ACTIVE",
      })));

    const result = await runResponsesLoop(config, options, memory, resolveArchived, "session");
    assert(result.ok);
    assertEquals(result.recalls[0].returnedSourceIds, ["old_archive"]);

    const secondInput = (capturedBodies[1] as { input: Array<Record<string, unknown>> }).input;
    const recallOutput = secondInput.find((item) => item.type === "function_call_output");
    const recallOutputText = String(recallOutput?.output ?? "");
    assert(recallOutputText.includes("OLD_EXACT_BLOCK=alpha"));
    assert(!recallOutputText.includes("ACTIVE_CURRENT=beta"));

    phase = "too_many";
    upstreamCalls = 0;
    capturedBodies.length = 0;
    let rejected = false;
    try {
      await runResponsesLoop(config, options, memory, resolveArchived, "session");
    } catch (error) {
      rejected = String(error).includes("Exceeded max local recall calls");
    }
    assert(rejected);
  } finally {
    await upstream.shutdown();
  }
});

Deno.test("multi-round 21 many chunked task switches do not lose or leak pieces", async () => {
  const session = new ManualMemorySession();
  const chunksPerTask = 4;
  const taskCount = 8;
  const expectedByTask = new Map<string, string[]>();
  const taskIdBySource = new Map<string, string>();
  const allExpectedPieceIds: string[] = [];
  const chunkClients: StructuredClients = {
    taskRoute: () => Promise.resolve({ kind: "same_task" }),
    sourceChunkBatch: (request) =>
      Promise.resolve({
        results: request.sources.map((source) => {
          const taskMatch = /^task_(\d+)_source$/.exec(source.sourceId);
          assert(taskMatch, `unexpected source id ${source.sourceId}`);
          const taskIndex = Number(taskMatch[1]);
          return {
            sourceId: source.sourceId,
            selectors: [{
              kind: "chunks",
              chunks: Array.from({ length: chunksPerTask }, (_, chunkIndex) => ({
                startText: `BEGIN TASK ${taskIndex} CHUNK ${chunkIndex}`,
                endText: `END TASK ${taskIndex} CHUNK ${chunkIndex}`,
              })),
            }],
          };
        }),
      }),
    pieceDropBatch: (request) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: false,
          reason: null,
        })),
      }),
  };
  const dropOldOnNewTask: MemoryManagerClients = {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: request.taskRoute.kind === "new_task" &&
            (piece.createdSeq ?? 0) < (request.activeTask?.startedRound ?? 0),
          reason: request.taskRoute.kind === "new_task" &&
              (piece.createdSeq ?? 0) < (request.activeTask?.startedRound ?? 0)
            ? "old_task_after_confirmed_task_switch"
            : null,
        })),
      }),
  };

  for (let taskIndex = 0; taskIndex < taskCount; taskIndex += 1) {
    const taskNumber = taskIndex + 1;
    const sourceId = `task_${taskNumber}_source`;
    const expectedTokens = Array.from(
      { length: chunksPerTask },
      (_, chunkIndex) => `TASK_${taskNumber}_CHUNK_${chunkIndex}_VALUE`,
    );
    const expectedPieceIds = Array.from(
      { length: chunksPerTask },
      (_, chunkIndex) => `${sourceId}:${chunkIndex}`,
    );
    allExpectedPieceIds.push(...expectedPieceIds);
    expectedByTask.set(sourceId, expectedTokens);
    const chunked = await chunkRoundSources([{
      sourceId,
      sourceKind: "tool",
      toolName: "exec_command",
      payload: chunkedTaskPayload(taskNumber, chunksPerTask),
    }], chunkClients);

    assertEquals(chunked.pieces.length, chunksPerTask);
    assertEquals(chunked.pieces.map((piece) => piece.id), expectedPieceIds);
    for (const token of expectedTokens) {
      assert(
        chunked.pieces.some((piece) => piece.previewText.includes(token)),
        `chunking omitted ${token}`,
      );
    }

    const update = await session.roundMany(
      chunked.pieces,
      { kind: "new_task" },
      taskIndex === 0 ? keepAllClients : dropOldOnNewTask,
    );
    taskIdBySource.set(sourceId, session.state.activeTask?.id ?? "");

    const activeIds = session.pieceIds();
    assertEquals(activeIds, expectedPieceIds);
    assertEquals(session.state.activeTask?.pieceIds, expectedPieceIds);
    assertEquals(
      session.state.pieces.map((piece) => piece.sourceId),
      expectedPieceIds.map(() => sourceId),
    );
    if (taskIndex === 0) {
      assertEquals(update.acceptedPruneDropPieceIds, []);
      assertEquals(session.state.archivedTasks.length, 0);
    } else {
      const previousSourceId = `task_${taskIndex}_source`;
      const previousPieceIds = Array.from(
        { length: chunksPerTask },
        (_, chunkIndex) => `${previousSourceId}:${chunkIndex}`,
      );
      assertEquals(update.acceptedPruneDropPieceIds.sort(), previousPieceIds);
      assertEquals(update.droppedOldPieceIds.sort(), previousPieceIds);
      assertEquals(session.state.archivedTasks.length, taskIndex);
      const archivedPrevious = session.state.archivedTasks.find((task) =>
        task.id === taskIdBySource.get(previousSourceId)
      );
      assert(archivedPrevious, `missing archived task for ${previousSourceId}`);
      assertEquals(archivedPrevious.pieces.map((piece) => piece.id), previousPieceIds);
    }

    for (let priorTaskNumber = 1; priorTaskNumber < taskNumber; priorTaskNumber += 1) {
      const priorSourceId = `task_${priorTaskNumber}_source`;
      const archived = session.state.archivedTasks.find((task) =>
        task.id === taskIdBySource.get(priorSourceId)
      );
      assert(archived, `missing archived task for ${priorSourceId} after task ${taskNumber}`);
      assertEquals(archived.pieces.length, chunksPerTask);
      assertEquals(
        archived.pieces.every((piece) => piece.sourceId === priorSourceId),
        true,
      );
    }

    const prompt = session.prompt();
    for (const token of expectedTokens) {
      assert(prompt.includes(token), `active prompt missing ${token}`);
    }
    for (const [priorSourceId, priorTokens] of expectedByTask) {
      if (priorSourceId === sourceId) {
        continue;
      }
      for (const token of priorTokens) {
        assert(!prompt.includes(token), `prior task token leaked into prompt: ${token}`);
      }
    }

    const allMemoryPiecesNow = [
      ...session.state.pieces,
      ...session.state.archivedTasks.flatMap((task) => task.pieces),
    ];
    const expectedSeenCount = taskNumber * chunksPerTask;
    assertEquals(allMemoryPiecesNow.length, expectedSeenCount);
    assertEquals(
      new Set(allMemoryPiecesNow.map((piece) => piece.id)).size,
      expectedSeenCount,
    );
    for (const expectedId of allExpectedPieceIds) {
      assert(
        allMemoryPiecesNow.some((piece) => piece.id === expectedId),
        `missing piece after task ${taskNumber}: ${expectedId}`,
      );
    }
  }

  assertEquals(session.state.pieces.length, chunksPerTask);
  assertEquals(session.state.archivedTasks.length, taskCount - 1);
  assertEquals(session.state.activeTask?.pieceIds, [
    "task_8_source:0",
    "task_8_source:1",
    "task_8_source:2",
    "task_8_source:3",
  ]);
  assertEquals(
    session.state.archivedTasks.every((task) => task.pieces.length === chunksPerTask),
    true,
  );

  const allMemoryPieces = [
    ...session.state.pieces,
    ...session.state.archivedTasks.flatMap((task) => task.pieces),
  ];
  assertEquals(allMemoryPieces.length, taskCount * chunksPerTask);
  assertEquals(new Set(allMemoryPieces.map((piece) => piece.id)).size, allMemoryPieces.length);
  for (const [sourceId, expectedTokens] of expectedByTask) {
    const pieces = allMemoryPieces.filter((piece) => piece.sourceId === sourceId);
    assertEquals(pieces.length, chunksPerTask);
    for (const token of expectedTokens) {
      assert(
        pieces.some((piece) => piece.previewText.includes(token)),
        `missing ${token}`,
      );
    }
  }

  const prompt = session.prompt();
  assert(prompt.includes("TASK_8_CHUNK_0_VALUE"));
  assert(prompt.includes("TASK_8_CHUNK_3_VALUE"));
  assert(!prompt.includes("TASK_1_CHUNK_0_VALUE"));
  assert(!prompt.includes("TASK_7_CHUNK_3_VALUE"));

  const task7Id = taskIdBySource.get("task_7_source");
  const task7ArchiveIndex = session.state.archivedTasks.findIndex((task) => task.id === task7Id);
  assert(task7ArchiveIndex >= 0, "task 7 should be archived before revive");
  const relativeIndex = task7ArchiveIndex - session.state.archivedTasks.length;
  const revive = await session.roundMany(
    [draft("revive_task_7:0", "revive_task_7", "user", "pick up task 7 again")],
    { kind: "revive_task", relativeIndex },
  );

  assertEquals(revive.taskRoute, { kind: "revive_task", relativeIndex });
  assertEquals(session.state.activeTask?.id, task7Id);
  assertEquals(session.state.pieces.map((piece) => piece.id), [
    "task_7_source:0",
    "task_7_source:1",
    "task_7_source:2",
    "task_7_source:3",
    "revive_task_7:0",
  ]);
  const revivedPrompt = session.prompt();
  for (let chunkIndex = 0; chunkIndex < chunksPerTask; chunkIndex += 1) {
    assert(
      revivedPrompt.includes(`TASK_7_CHUNK_${chunkIndex}_VALUE`),
      `revived prompt missing task 7 chunk ${chunkIndex}`,
    );
  }
  assert(!revivedPrompt.includes("TASK_8_CHUNK_0_VALUE"));
  assert(
    session.state.archivedTasks.some((task) =>
      task.id === taskIdBySource.get("task_8_source") &&
      task.pieces.map((piece) => piece.id).join(",") ===
        "task_8_source:0,task_8_source:1,task_8_source:2,task_8_source:3"
    ),
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

class ManualMemorySession {
  state: MemoryState = emptyState();

  #renderTextByPieceId = new Map<string, string>();

  async round(
    piece: PieceDraft,
    route: Parameters<typeof applyWorkingSetUpdate>[2],
    clients: MemoryManagerClients = keepAllClients,
  ): Promise<Awaited<ReturnType<typeof applyWorkingSetUpdate>>> {
    return await this.roundMany([piece], route, clients);
  }

  async roundMany(
    pieces: PieceDraft[],
    route: Parameters<typeof applyWorkingSetUpdate>[2],
    clients: MemoryManagerClients = keepAllClients,
  ): Promise<Awaited<ReturnType<typeof applyWorkingSetUpdate>>> {
    const result = await applyWorkingSetUpdate(
      this.state,
      pieces,
      route,
      clients,
      this.materializedPriorPieces(),
    );
    this.state = result.memory;
    for (const piece of pieces) {
      this.#renderTextByPieceId.set(piece.id, renderDraft(piece));
    }
    return result;
  }

  materializedPriorPieces(): MaterializedMemoryPiece[] {
    return [
      ...this.state.pieces,
      ...this.state.archivedTasks.flatMap((task) => task.pieces),
    ].map((piece) => ({
      ...piece,
      renderText: this.#renderTextByPieceId.get(piece.id) ?? piece.previewText,
    }));
  }

  materializedActivePieces(): MaterializedMemoryPiece[] {
    return this.state.pieces.map((piece) => ({
      ...piece,
      renderText: this.#renderTextByPieceId.get(piece.id) ?? piece.previewText,
    }));
  }

  pieceIds(): string[] {
    return this.state.pieces.map((piece) => piece.id);
  }

  prompt(): string {
    const activePieces = this.materializedActivePieces();
    return buildPromptMemoryText({ ...this.state, pieces: activePieces }, activePieces);
  }
}

function draft(
  id: string,
  sourceId: string,
  sourceKind: SourceKind,
  text: string,
  toolName?: string,
): PieceDraft {
  return {
    id,
    sourceId,
    sourceKind,
    ...(toolName ? { toolName } : {}),
    content: text,
    previewText: text,
    byteSize: text.length,
    selector: { kind: "whole" },
  };
}

function chunkedTaskPayload(taskIndex: number, chunksPerTask: number): string {
  return Array.from({ length: chunksPerTask }, (_, chunkIndex) =>
    [
      `BEGIN TASK ${taskIndex} CHUNK ${chunkIndex}`,
      `TASK_${taskIndex}_CHUNK_${chunkIndex}_VALUE`,
      `task ${taskIndex} chunk ${chunkIndex} detail line A`,
      `task ${taskIndex} chunk ${chunkIndex} detail line B`,
      `END TASK ${taskIndex} CHUNK ${chunkIndex}`,
    ].join("\n")).join("\n\n");
}

function requestBody(text: string): Record<string, unknown> {
  return {
    model: "test",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    }],
    stream: false,
    tools: [],
  };
}

function testProxyConfig(upstreamBaseUrl: string): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl,
    apiKey: null,
    smallStructuredModel: "gpt-4.1-mini",
    overflowStructuredModel: "gpt-5-mini",
    smallStructuredContextWindow: 32_000,
    overflowStructuredContextWindow: 128_000,
    modelTimeoutMs: 5_000,
    stateDir: "/tmp",
    memoryEnabled: true,
    logFile: null,
    codexAutoCompactTokenLimit: 280_000,
  };
}

function renderDraft(piece: PieceDraft): string {
  return typeof piece.content === "string" ? piece.content : JSON.stringify(piece.content);
}

function dropPieceIdsClient(pieceIds: string[]): MemoryManagerClients {
  const ids = new Set(pieceIds);
  return {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: ids.has(piece.id),
          reason: ids.has(piece.id) ? "old_task_after_confirmed_task_switch" : null,
        })),
      }),
  };
}

function oldTaskReasonForIdsClient(pieceIds: string[]): MemoryManagerClients {
  return dropPieceIdsClient(pieceIds);
}

function dropTargetWithReasonClient(pieceId: string, reason: unknown): MemoryManagerClients {
  return {
    ...keepAllClients,
    pieceDropBatch: (request: PieceDropBatchRequest) =>
      Promise.resolve({
        decisions: request.evaluatedPieces.map((piece) => ({
          pieceId: piece.id,
          drop: piece.id === pieceId,
          reason: piece.id === pieceId ? reason : null,
        })),
      } as never),
  };
}

const dropNonAssistantAsUnrelatedClient: MemoryManagerClients = {
  ...keepAllClients,
  pieceDropBatch: (request: PieceDropBatchRequest) =>
    Promise.resolve({
      decisions: request.evaluatedPieces.map((piece) => ({
        pieceId: piece.id,
        drop: piece.sourceKind !== "assistant",
        reason: piece.sourceKind !== "assistant" ? "clearly_unrelated_to_current_work" : null,
      })),
    }),
};

const structuralDropClient: MemoryManagerClients = {
  ...keepAllClients,
  pieceDropBatch: (request: PieceDropBatchRequest) =>
    Promise.resolve({
      decisions: request.evaluatedPieces.map((piece) => ({
        pieceId: piece.id,
        drop: piece.id === "empty:0" || piece.id === "chatter:0",
        reason: piece.id === "empty:0"
          ? "empty_or_invalid"
          : piece.id === "chatter:0"
          ? "pure_ack_or_chatter"
          : null,
      })),
    }),
};
