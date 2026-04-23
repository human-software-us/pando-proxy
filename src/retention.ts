import {
  isRecord,
  MemoryChunk,
  MemoryState,
  pruneMemoryToLiveTasks,
  unique,
} from "./memory_state.ts";

export type RetentionDecision = {
  keep: Array<{ id: string; taskIds: string[] }>;
  drop: string[];
};

export type RetentionClient = (request: RetentionModelRequest) => Promise<unknown>;

export type RetentionModelRequest = {
  tasks: MemoryState["tasks"];
  activeTaskId: string | null;
  candidates: MemoryChunk[];
  validationErrors?: string[];
};

export async function retainMemory(
  state: MemoryState,
  inbox: MemoryChunk[],
  client: RetentionClient,
): Promise<MemoryState> {
  const candidates = dedupeCandidates([...state.memoryLibrary, ...inbox]);
  if (state.tasks.length === 0 || candidates.length === 0) {
    return pruneMemoryToLiveTasks({ ...state, memoryLibrary: [] });
  }

  const first = await safeRetentionCall(client, {
    tasks: state.tasks,
    activeTaskId: state.activeTaskId,
    candidates,
  });
  const parsed = parseAndValidateRetentionDecision(first, candidates, state);
  if (parsed.ok) {
    return applyRetention(state, candidates, parsed.decision);
  }

  const second = await safeRetentionCall(client, {
    tasks: state.tasks,
    activeTaskId: state.activeTaskId,
    candidates,
    validationErrors: parsed.errors,
  });
  const reparsed = parseAndValidateRetentionDecision(second, candidates, state);
  if (reparsed.ok) {
    return applyRetention(state, candidates, reparsed.decision);
  }

  throw new Error(`Retention validation failed: ${reparsed.errors.join("; ")}`);
}

export function parseAndValidateRetentionDecision(
  value: unknown,
  candidates: MemoryChunk[],
  state: MemoryState,
): { ok: true; decision: RetentionDecision } | { ok: false; errors: string[] } {
  const decision = coerceRetentionDecision(value);
  if (!decision) {
    return { ok: false, errors: ["Retention decision was not a valid object"] };
  }
  const errors = validateRetention(decision, candidates, state);
  return errors.length === 0 ? { ok: true, decision } : { ok: false, errors };
}

export function validateRetention(
  decision: RetentionDecision,
  candidates: MemoryChunk[],
  state: MemoryState,
): string[] {
  const errors: string[] = [];
  const candidateIds = candidates.map((chunk) => chunk.id);
  const candidateIdSet = new Set(candidateIds);
  const liveTaskIds = new Set(state.tasks.map((task) => task.id));

  const seen = new Map<string, number>();
  for (const item of decision.keep) {
    seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
  }
  for (const id of decision.drop) {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }

  for (const id of candidateIds) {
    if (!seen.has(id)) {
      errors.push(`Candidate ${id} missing from retention decision`);
    } else if (seen.get(id) !== 1) {
      errors.push(`Candidate ${id} appears ${seen.get(id)} times in retention decision`);
    }
  }
  for (const id of seen.keys()) {
    if (!candidateIdSet.has(id)) {
      errors.push(`Retention decision references unknown chunk ${id}`);
    }
  }

  for (const item of decision.keep) {
    if (item.taskIds.length === 0) {
      errors.push(`Kept chunk ${item.id} must have at least one live taskId`);
    }
    for (const taskId of item.taskIds) {
      if (!liveTaskIds.has(taskId)) {
        errors.push(`Kept chunk ${item.id} references missing task ${taskId}`);
      }
    }
  }

  return errors;
}

export function applyRetention(
  state: MemoryState,
  candidates: MemoryChunk[],
  decision: RetentionDecision,
): MemoryState {
  const candidateMap = new Map(candidates.map((chunk) => [chunk.id, chunk]));
  const memoryLibrary = decision.keep.flatMap((item) => {
    const chunk = candidateMap.get(item.id);
    return chunk ? [{ ...chunk, taskIds: unique(item.taskIds) }] : [];
  });
  return pruneMemoryToLiveTasks({ ...state, memoryLibrary });
}

function dedupeCandidates(candidates: MemoryChunk[]): MemoryChunk[] {
  const map = new Map<string, MemoryChunk>();
  for (const chunk of candidates) {
    map.set(chunk.id, chunk);
  }
  return [...map.values()];
}

function coerceRetentionDecision(value: unknown): RetentionDecision | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    keep: Array.isArray(value.keep)
      ? value.keep.filter(isRecord).map((item) => ({
        id: String(item.id ?? ""),
        taskIds: Array.isArray(item.taskIds) ? item.taskIds.map(String) : [],
      }))
      : [],
    drop: Array.isArray(value.drop) ? value.drop.map(String) : [],
  };
}

async function safeRetentionCall(
  client: RetentionClient,
  request: RetentionModelRequest,
): Promise<unknown> {
  return await client(request);
}
