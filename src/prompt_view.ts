import { MemoryChunk, MemoryState } from "./memory_state.ts";

export function buildSyntheticMemoryText(state: MemoryState, maxChars: number): string | null {
  const live = new Set(state.tasks.map((task) => task.id));
  const chunks = state.memoryLibrary.filter((chunk) =>
    chunk.taskIds.length > 0 && chunk.taskIds.every((id) => live.has(id))
  );

  if (state.tasks.length === 0 && chunks.length === 0 && state.keptUserMessages.length === 0) {
    return null;
  }

  const lines: string[] = ["<context_memory>"];
  if (state.tasks.length > 0) {
    lines.push("Live tasks:");
    for (const task of state.tasks) {
      const active = task.id === state.activeTaskId ? " active" : "";
      lines.push(`- ${task.id} [${task.status}/${task.kind}${active}]: ${singleLine(task.text)}`);
    }
  }

  const keptMessages = state.keptUserMessages.filter((message) =>
    message.taskIds.length > 0 && message.taskIds.every((id) => live.has(id))
  );
  if (keptMessages.length > 0) {
    lines.push("", "Kept user-message context:");
    for (const message of keptMessages) {
      lines.push(`- ${message.taskIds.join(", ")}: ${singleLine(message.summary)}`);
    }
  }

  if (chunks.length > 0) {
    lines.push("", "Relevant retained context:");
    for (const chunk of chunks) {
      lines.push(`- ${formatChunk(chunk)}`);
    }
  }

  lines.push("</context_memory>");
  return clampAtLineBoundary(lines.join("\n"), maxChars);
}

export function makeSyntheticMemoryItem(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

export function rewriteRequestWithMemory(
  body: Record<string, unknown>,
  state: MemoryState,
  maxChars: number,
): Record<string, unknown> {
  const text = buildSyntheticMemoryText(state, maxChars);
  const input = body.input;
  const next = { ...body };
  if (!text) {
    return next;
  }

  const memoryItem = makeSyntheticMemoryItem(text);
  if (typeof input === "string") {
    next.input = [memoryItem, {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: input }],
    }];
    return next;
  }

  if (!Array.isArray(input)) {
    next.input = [memoryItem];
    return next;
  }

  const filtered = input.filter((item) => !isSyntheticMemoryItem(item));
  const insertIndex = leadingInstructionCount(filtered);
  next.input = [
    ...filtered.slice(0, insertIndex),
    memoryItem,
    ...filtered.slice(insertIndex),
  ];
  return next;
}

function formatChunk(chunk: MemoryChunk): string {
  const pointer = chunk.pointer ? ` pointer=${JSON.stringify(compactPointer(chunk.pointer))}` : "";
  return `${chunk.title}: ${singleLine(chunk.summary)} [tasks: ${
    chunk.taskIds.join(", ")
  }]${pointer}`;
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clampAtLineBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = "\n... retained context truncated ...\n</context_memory>";
  const budget = Math.max(0, maxChars - suffix.length);
  const head = text.slice(0, budget);
  const lineBoundary = head.lastIndexOf("\n");
  return `${head.slice(0, lineBoundary > 0 ? lineBoundary : budget)}${suffix}`;
}

function compactPointer(pointer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (
    const key of [
      "toolName",
      "path",
      "file",
      "nodePath",
      "hash",
      "expectedHash",
      "line",
      "itemIndex",
      "changedPaths",
    ]
  ) {
    if (key in pointer) {
      out[key] = pointer[key];
    }
  }
  return out;
}

function isSyntheticMemoryItem(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const record = item as Record<string, unknown>;
  const content = record.content;
  if (typeof content === "string") {
    return content.includes("<context_memory>") && content.includes("</context_memory>");
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((part) =>
    typeof part === "object" &&
    part !== null &&
    typeof (part as Record<string, unknown>).text === "string" &&
    String((part as Record<string, unknown>).text).includes("<context_memory>")
  );
}

function leadingInstructionCount(input: unknown[]): number {
  let index = 0;
  while (index < input.length) {
    const item = input[index];
    if (!item || typeof item !== "object") {
      break;
    }
    const role = (item as Record<string, unknown>).role;
    if (role !== "system" && role !== "developer") {
      break;
    }
    index += 1;
  }
  return index;
}
