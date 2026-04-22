export type MemoryState = {
  taskUpdateSeq: number;
  tasks: Task[];
  activeTaskId: string | null;
  keptUserMessages: UserMessageMemory[];
  memoryLibrary: MemoryChunk[];
};

export type Task = {
  id: string;
  text: string;
  status: "open" | "in_progress";
  kind: "say" | "do";
};

export type UserMessageMemory = {
  messageId: string;
  summary: string;
  taskIds: string[];
};

export type MemoryChunk = {
  id: string;
  title: string;
  summary: string;
  kind: string;
  taskIds: string[];
  pointer?: Record<string, unknown>;
  source?: "tool" | "user";
};

export type SessionRecord = {
  memory: MemoryState;
  handledInputIds: string[];
};

export function emptyMemoryState(): MemoryState {
  return {
    taskUpdateSeq: 0,
    tasks: [],
    activeTaskId: null,
    keptUserMessages: [],
    memoryLibrary: [],
  };
}

export function emptySessionRecord(): SessionRecord {
  return {
    memory: emptyMemoryState(),
    handledInputIds: [],
  };
}

export function liveTaskIdSet(state: Pick<MemoryState, "tasks">): Set<string> {
  return new Set(state.tasks.map((task) => task.id));
}

export function pruneMemoryToLiveTasks(state: MemoryState): MemoryState {
  const live = liveTaskIdSet(state);
  return {
    ...state,
    activeTaskId: state.activeTaskId && live.has(state.activeTaskId) ? state.activeTaskId : null,
    keptUserMessages: state.keptUserMessages
      .map((message) => ({
        ...message,
        taskIds: unique(message.taskIds.filter((id) => live.has(id))),
      }))
      .filter((message) => message.taskIds.length > 0),
    memoryLibrary: state.memoryLibrary
      .map((chunk) => ({ ...chunk, taskIds: unique(chunk.taskIds.filter((id) => live.has(id))) }))
      .filter((chunk) => chunk.taskIds.length > 0),
  };
}

export function assertMemoryInvariant(state: MemoryState): void {
  const live = liveTaskIdSet(state);
  const errors: string[] = [];

  for (const task of state.tasks) {
    if (!task.id || !task.text) {
      errors.push("Every task must have id and text");
    }
    if (task.status !== "open" && task.status !== "in_progress") {
      errors.push(`Task ${task.id} has invalid status`);
    }
    if (task.kind !== "say" && task.kind !== "do") {
      errors.push(`Task ${task.id} has invalid kind`);
    }
  }

  if (state.activeTaskId !== null && !live.has(state.activeTaskId)) {
    errors.push(`activeTaskId references missing task: ${state.activeTaskId}`);
  }

  for (const message of state.keptUserMessages) {
    if (message.taskIds.length === 0) {
      errors.push(`Kept user message ${message.messageId} has no taskIds`);
    }
    for (const taskId of message.taskIds) {
      if (!live.has(taskId)) {
        errors.push(`Kept user message ${message.messageId} references missing task ${taskId}`);
      }
    }
  }

  for (const chunk of state.memoryLibrary) {
    if (chunk.taskIds.length === 0) {
      errors.push(`Memory chunk ${chunk.id} has no taskIds`);
    }
    for (const taskId of chunk.taskIds) {
      if (!live.has(taskId)) {
        errors.push(`Memory chunk ${chunk.id} references missing task ${taskId}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
