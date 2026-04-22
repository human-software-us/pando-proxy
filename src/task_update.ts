import {
  assertMemoryInvariant,
  isRecord,
  MemoryState,
  pruneMemoryToLiveTasks,
  Task,
  unique,
  UserMessageMemory,
} from "./memory_state.ts";

export type UserMessageInput = {
  messageId: string;
  text: string;
};

export type TaskUpdate = {
  taskUpdateSeq: number;
  latestUserMessageId: string;
  result: "changed" | "same_as_before";
  tasksAfter: Task[];
  activeTaskId: string | null;
  existingTaskActions: Array<{
    id: string;
    action: "keep" | "drop" | "complete" | "merge_into";
    mergeInto?: string;
  }>;
  userMessageActions: Array<{
    messageId: string;
    action: "keep" | "drop";
    taskIds?: string[];
    summary?: string;
  }>;
};

export type TaskUpdateClient = (
  request: TaskUpdateModelRequest,
) => Promise<unknown>;

export type TaskUpdateModelRequest = {
  previousSeq: number;
  latestUserMessage: UserMessageInput;
  tasks: Task[];
  keptUserMessages: UserMessageMemory[];
  validationErrors?: string[];
};

export async function onNewUserMessage(
  message: UserMessageInput,
  state: MemoryState,
  client: TaskUpdateClient,
): Promise<MemoryState> {
  const first = await client({
    previousSeq: state.taskUpdateSeq,
    latestUserMessage: message,
    tasks: state.tasks,
    keptUserMessages: state.keptUserMessages,
  });
  const firstResult = parseAndValidateTaskUpdate(first, state, message);
  if (firstResult.ok) {
    return applyTaskUpdate(state, message, firstResult.update);
  }

  const second = await client({
    previousSeq: state.taskUpdateSeq,
    latestUserMessage: message,
    tasks: state.tasks,
    keptUserMessages: state.keptUserMessages,
    validationErrors: firstResult.errors,
  });
  const secondResult = parseAndValidateTaskUpdate(second, state, message);
  if (!secondResult.ok) {
    throw new Error(`Task update validation failed: ${secondResult.errors.join("; ")}`);
  }
  return applyTaskUpdate(state, message, secondResult.update);
}

export function parseAndValidateTaskUpdate(
  value: unknown,
  previous: MemoryState,
  latestUserMessage: UserMessageInput,
): { ok: true; update: TaskUpdate } | { ok: false; errors: string[] } {
  const update = coerceTaskUpdate(value);
  if (!update) {
    return { ok: false, errors: ["Task update was not a valid object"] };
  }
  const errors = validateTaskUpdate(update, previous, latestUserMessage);
  return errors.length === 0 ? { ok: true, update } : { ok: false, errors };
}

export function validateTaskUpdate(
  update: TaskUpdate,
  previous: MemoryState,
  latestUserMessage: UserMessageInput,
): string[] {
  const errors: string[] = [];
  if (update.taskUpdateSeq !== previous.taskUpdateSeq + 1) {
    errors.push(
      `taskUpdateSeq must equal ${previous.taskUpdateSeq + 1}; got ${update.taskUpdateSeq}`,
    );
  }
  if (update.latestUserMessageId !== latestUserMessage.messageId) {
    errors.push(
      `latestUserMessageId must be ${latestUserMessage.messageId}; got ${update.latestUserMessageId}`,
    );
  }
  if (update.result !== "changed" && update.result !== "same_as_before") {
    errors.push(`result must be changed or same_as_before`);
  }

  const taskIdsAfter = new Set<string>();
  for (const task of update.tasksAfter) {
    if (!task.id || !task.text) {
      errors.push("Every task in tasksAfter must have id and text");
    }
    if (taskIdsAfter.has(task.id)) {
      errors.push(`Duplicate task id in tasksAfter: ${task.id}`);
    }
    taskIdsAfter.add(task.id);
    if (task.status !== "open" && task.status !== "in_progress") {
      errors.push(`Task ${task.id} has invalid status ${task.status}`);
    }
    if (task.kind !== "say" && task.kind !== "do") {
      errors.push(`Task ${task.id} has invalid kind ${task.kind}`);
    }
  }
  if (update.activeTaskId !== null && !taskIdsAfter.has(update.activeTaskId)) {
    errors.push(`activeTaskId references missing task: ${update.activeTaskId}`);
  }

  const previousTaskIds = previous.tasks.map((task) => task.id);
  const actionIds = update.existingTaskActions.map((action) => action.id);
  const duplicateActions = actionIds.filter((id, index) => actionIds.indexOf(id) !== index);
  for (const id of duplicateActions) {
    errors.push(`Duplicate existingTaskAction for task ${id}`);
  }
  for (const taskId of previousTaskIds) {
    if (!actionIds.includes(taskId)) {
      errors.push(`Missing existingTaskAction for previous task ${taskId}`);
    }
  }
  for (const action of update.existingTaskActions) {
    if (!previousTaskIds.includes(action.id)) {
      errors.push(`existingTaskAction references non-previous task ${action.id}`);
    }
    if (!["keep", "drop", "complete", "merge_into"].includes(action.action)) {
      errors.push(`Invalid action for task ${action.id}: ${action.action}`);
    }
    if (action.action === "keep" && !taskIdsAfter.has(action.id)) {
      errors.push(`Kept task ${action.id} must appear in tasksAfter`);
    }
    if ((action.action === "drop" || action.action === "complete") && taskIdsAfter.has(action.id)) {
      errors.push(`${action.action} task ${action.id} must not appear in tasksAfter`);
    }
    if (action.action === "merge_into") {
      if (!action.mergeInto) {
        errors.push(`merge_into action for ${action.id} requires mergeInto`);
      } else if (!taskIdsAfter.has(action.mergeInto)) {
        errors.push(`mergeInto target ${action.mergeInto} must appear in tasksAfter`);
      }
      if (taskIdsAfter.has(action.id)) {
        errors.push(`Merged task ${action.id} must not remain in tasksAfter`);
      }
    }
  }

  const requiredMessageIds = [
    ...previous.keptUserMessages.map((message) => message.messageId),
    latestUserMessage.messageId,
  ];
  const messageActionIds = update.userMessageActions.map((action) => action.messageId);
  for (const messageId of requiredMessageIds) {
    if (!messageActionIds.includes(messageId)) {
      errors.push(`Missing userMessageAction for ${messageId}`);
    }
  }
  const duplicateMessageActions = messageActionIds.filter((id, index) =>
    messageActionIds.indexOf(id) !== index
  );
  for (const id of duplicateMessageActions) {
    errors.push(`Duplicate userMessageAction for ${id}`);
  }

  for (const action of update.userMessageActions) {
    if (action.action !== "keep" && action.action !== "drop") {
      errors.push(`Invalid user message action for ${action.messageId}: ${action.action}`);
    }
    if (action.action === "keep") {
      if (!action.summary || action.summary.trim().length === 0) {
        errors.push(`Kept user message ${action.messageId} requires summary`);
      }
      if (!action.taskIds || action.taskIds.length === 0) {
        errors.push(`Kept user message ${action.messageId} requires live taskIds`);
      }
      for (const taskId of action.taskIds ?? []) {
        if (!taskIdsAfter.has(taskId)) {
          errors.push(`Kept user message ${action.messageId} references missing task ${taskId}`);
        }
      }
    }
  }

  return errors;
}

export function applyTaskUpdate(
  previous: MemoryState,
  latestUserMessage: UserMessageInput,
  update: TaskUpdate,
): MemoryState {
  const existingMessages = new Map(
    previous.keptUserMessages.map((message) => [message.messageId, message]),
  );
  const keptUserMessages: UserMessageMemory[] = [];

  for (const action of update.userMessageActions) {
    if (action.action === "drop") {
      continue;
    }
    const existing = existingMessages.get(action.messageId);
    keptUserMessages.push({
      messageId: action.messageId,
      summary: action.summary ?? existing?.summary ?? latestUserMessage.text,
      taskIds: unique(action.taskIds ?? existing?.taskIds ?? []),
    });
  }

  const mergeMap = new Map<string, string>();
  for (const action of update.existingTaskActions) {
    if (action.action === "merge_into" && action.mergeInto) {
      mergeMap.set(action.id, action.mergeInto);
    }
  }

  const remapTaskIds = (taskIds: string[]) => unique(taskIds.map((id) => mergeMap.get(id) ?? id));

  const next: MemoryState = {
    taskUpdateSeq: update.taskUpdateSeq,
    tasks: update.tasksAfter,
    activeTaskId: update.activeTaskId,
    keptUserMessages: keptUserMessages.map((message) => ({
      ...message,
      taskIds: remapTaskIds(message.taskIds),
    })),
    memoryLibrary: previous.memoryLibrary.map((chunk) => ({
      ...chunk,
      taskIds: remapTaskIds(chunk.taskIds),
    })),
  };
  const pruned = pruneMemoryToLiveTasks(next);
  assertMemoryInvariant(pruned);
  return pruned;
}

function coerceTaskUpdate(value: unknown): TaskUpdate | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    taskUpdateSeq: Number(value.taskUpdateSeq),
    latestUserMessageId: String(value.latestUserMessageId ?? ""),
    result: value.result === "same_as_before" ? "same_as_before" : "changed",
    tasksAfter: Array.isArray(value.tasksAfter)
      ? value.tasksAfter.filter(isRecord).map(coerceTask)
      : [],
    activeTaskId: typeof value.activeTaskId === "string" ? value.activeTaskId : null,
    existingTaskActions: Array.isArray(value.existingTaskActions)
      ? value.existingTaskActions.filter(isRecord).map((action) => ({
        id: String(action.id ?? ""),
        action: coerceExistingTaskAction(action.action),
        mergeInto: typeof action.mergeInto === "string" ? action.mergeInto : undefined,
      }))
      : [],
    userMessageActions: Array.isArray(value.userMessageActions)
      ? value.userMessageActions.filter(isRecord).map((action) => ({
        messageId: String(action.messageId ?? ""),
        action: action.action === "keep" ? "keep" : "drop",
        taskIds: Array.isArray(action.taskIds) ? action.taskIds.map(String) : undefined,
        summary: typeof action.summary === "string" ? action.summary : undefined,
      }))
      : [],
  };
}

function coerceTask(value: Record<string, unknown>): Task {
  return {
    id: String(value.id ?? ""),
    text: String(value.text ?? ""),
    status: value.status === "in_progress" ? "in_progress" : "open",
    kind: value.kind === "say" ? "say" : "do",
  };
}

function coerceExistingTaskAction(value: unknown): "keep" | "drop" | "complete" | "merge_into" {
  return value === "keep" || value === "complete" || value === "merge_into" ? value : "drop";
}
