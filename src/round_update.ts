import {
  MemoryState,
  PieceDraft,
  PieceRecord,
  pruneMemoryToLiveTasks,
  Task,
  unique,
} from "./memory_state.ts";

export type PieceSelection =
  | { mode: "drop_all" }
  | { mode: "keep_all" }
  | { mode: "keep_only"; ids: string[] }
  | { mode: "drop_only"; ids: string[] };

export type RoundUpdateRequest = {
  tasks: Task[];
  newPieces: Array<{
    id: string;
    sourceKind: "user" | "assistant" | "tool";
    toolName?: string;
    content: unknown;
    pointer?: Record<string, unknown>;
  }>;
};

export type RoundUpdateResponse = {
  tasksAfter: Task[];
  pieceSelection: PieceSelection;
  keptPieceTaskLinks: Array<{
    id: string;
    taskIds: string[];
  }>;
};

export type RoundUpdateClient = (request: RoundUpdateRequest) => Promise<unknown>;
export type AppliedRoundUpdate = {
  memory: MemoryState;
  response: RoundUpdateResponse;
  keptNewPieceIds: string[];
  droppedNewPieceIds: string[];
};


export async function applyRoundUpdate(
  state: MemoryState,
  newPieces: PieceDraft[],
  client: RoundUpdateClient,
): Promise<AppliedRoundUpdate> {
  if (newPieces.length === 0) {
    return {
      memory: state,
      response: {
        tasksAfter: state.tasks,
        pieceSelection: { mode: "drop_all" },
        keptPieceTaskLinks: [],
      },
      keptNewPieceIds: [],
      droppedNewPieceIds: [],
    };
  }

  const request = {
    tasks: state.tasks,
    newPieces: newPieces.map((piece) => ({
      id: piece.id,
      sourceKind: piece.sourceKind,
      ...(piece.toolName ? { toolName: piece.toolName } : {}),
      content: piece.payloadInline,
      ...(piece.pointer ? { pointer: piece.pointer } : {}),
    })),
  };
  const value = await client(request);
  const parsed = parseAndValidateRoundUpdate(value, state, newPieces);
  if (!parsed.ok) {
    throw new Error(`round_update validation failed: ${parsed.errors.join("; ")}`);
  }

  const newPieceIds = newPieces.map((piece) => piece.id);
  const keptNewPieceIds = [...resolveKeptPieceIds(parsed.response.pieceSelection, newPieceIds)];
  const droppedNewPieceIds = newPieceIds.filter((pieceId) => !keptNewPieceIds.includes(pieceId));
  const nextSeq = state.roundSeq + 1;
  const linkMap = new Map(parsed.response.keptPieceTaskLinks.map((item) => [item.id, unique(item.taskIds)]));
  const nextPieces: PieceRecord[] = [
    ...state.pieces,
    ...newPieces.flatMap((piece) => {
      const taskIds = linkMap.get(piece.id);
      if (!taskIds) {
        return [];
      }
      return [{
        ...piece,
        taskIds,
        createdSeq: nextSeq,
      }];
    }),
  ];

  const memory = pruneMemoryToLiveTasks({
    roundSeq: nextSeq,
    tasks: parsed.response.tasksAfter,
    pieces: dedupeById(nextPieces),
    processedSourceIds: unique([
      ...state.processedSourceIds,
      ...newPieces.map((piece) => piece.sourceId),
    ]),
  });

  return {
    memory,
    response: parsed.response,
    keptNewPieceIds,
    droppedNewPieceIds,
  };
}

export function parseAndValidateRoundUpdate(
  value: unknown,
  previous: MemoryState,
  newPieces: PieceDraft[],
): { ok: true; response: RoundUpdateResponse } | { ok: false; errors: string[] } {
  const response = coerceRoundUpdate(value);
  if (!response) {
    return { ok: false, errors: ["round_update response must be an object"] };
  }
  const errors = validateRoundUpdate(response, previous, newPieces);
  return errors.length === 0 ? { ok: true, response } : { ok: false, errors };
}

export function validateRoundUpdate(
  response: RoundUpdateResponse,
  previous: MemoryState,
  newPieces: PieceDraft[],
): string[] {
  const errors: string[] = [];
  const pieceIds = newPieces.map((piece) => piece.id);
  const pieceIdSet = new Set(pieceIds);
  const keptIds = resolveKeptPieceIds(response.pieceSelection, pieceIds, errors);

  const taskIds = new Set<string>();
  for (const task of response.tasksAfter) {
    if (!task.id || !task.text) {
      errors.push("Every task in tasksAfter must have id and text");
    }
    if (taskIds.has(task.id)) {
      errors.push(`Duplicate task id in tasksAfter: ${task.id}`);
    }
    taskIds.add(task.id);
    if (task.status !== "open" && task.status !== "in_progress") {
      errors.push(`Task ${task.id} has invalid status ${task.status}`);
    }
    if (task.kind !== "say" && task.kind !== "do") {
      errors.push(`Task ${task.id} has invalid kind ${task.kind}`);
    }
  }

  const linkIds = response.keptPieceTaskLinks.map((item) => item.id);
  const duplicateLinkIds = linkIds.filter((id, index) => linkIds.indexOf(id) !== index);
  for (const id of duplicateLinkIds) {
    errors.push(`Duplicate keptPieceTaskLinks entry for ${id}`);
  }

  for (const item of response.keptPieceTaskLinks) {
    if (!pieceIdSet.has(item.id)) {
      errors.push(`keptPieceTaskLinks references unknown piece ${item.id}`);
      continue;
    }
    if (!keptIds.has(item.id)) {
      errors.push(`Dropped piece ${item.id} appears in keptPieceTaskLinks`);
    }
    if (item.taskIds.length === 0) {
      errors.push(`Kept piece ${item.id} must have at least one taskId`);
    }
    for (const taskId of item.taskIds) {
      if (!taskIds.has(taskId)) {
        errors.push(`Kept piece ${item.id} references missing task ${taskId}`);
      }
    }
  }

  for (const pieceId of keptIds) {
    if (!linkIds.includes(pieceId)) {
      errors.push(`Kept piece ${pieceId} is missing from keptPieceTaskLinks`);
    }
  }
  for (const pieceId of pieceIds) {
    if (!keptIds.has(pieceId) && linkIds.includes(pieceId)) {
      errors.push(`Dropped piece ${pieceId} appears in keptPieceTaskLinks`);
    }
  }

  for (const piece of newPieces) {
    if (previous.processedSourceIds.includes(piece.sourceId)) {
      errors.push(`Source ${piece.sourceId} was already processed`);
    }
  }

  return errors;
}

export function resolveKeptPieceIds(
  selection: PieceSelection,
  pieceIds: string[],
  errors: string[] = [],
): Set<string> {
  const pieceIdSet = new Set(pieceIds);
  const validateIds = (ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (!pieceIdSet.has(id)) {
        errors.push(`pieceSelection references unknown piece ${id}`);
      }
      if (seen.has(id)) {
        errors.push(`pieceSelection references duplicate piece ${id}`);
      }
      seen.add(id);
    }
  };

  if (selection.mode === "drop_all") {
    return new Set<string>();
  }
  if (selection.mode === "keep_all") {
    return new Set(pieceIds);
  }
  if (selection.mode === "keep_only") {
    validateIds(selection.ids);
    return new Set(selection.ids);
  }
  validateIds(selection.ids);
  return new Set(pieceIds.filter((id) => !selection.ids.includes(id)));
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return [...map.values()];
}

function coerceRoundUpdate(value: unknown): RoundUpdateResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const selection = coercePieceSelection(record.pieceSelection);
  if (!selection) {
    return null;
  }
  return {
    tasksAfter: Array.isArray(record.tasksAfter)
      ? record.tasksAfter
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
          const task = item as Record<string, unknown>;
          return {
            id: String(task.id ?? ""),
            text: String(task.text ?? ""),
            status: task.status === "open" ? "open" : "in_progress",
            kind: task.kind === "say" ? "say" : "do",
          } as Task;
        })
      : [],
    pieceSelection: selection,
    keptPieceTaskLinks: Array.isArray(record.keptPieceTaskLinks)
      ? record.keptPieceTaskLinks
        .filter((item) => item && typeof item === "object" && !Array.isArray(item))
        .map((item) => {
          const entry = item as Record<string, unknown>;
          return {
            id: String(entry.id ?? ""),
            taskIds: Array.isArray(entry.taskIds) ? entry.taskIds.map(String) : [],
          };
        })
      : [],
  };
}

function coercePieceSelection(value: unknown): PieceSelection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode === "drop_all" || mode === "keep_all") {
    return { mode };
  }
  if (mode === "keep_only" || mode === "drop_only") {
    return {
      mode,
      ids: Array.isArray(record.ids) ? record.ids.map(String) : [],
    };
  }
  return null;
}
