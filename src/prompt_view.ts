import { MemoryChunk, MemoryState } from "./memory_state.ts";
import { describeInputItems, InputItemDescriptor, inputItems } from "./tool_results.ts";

export type DerivedPromptOptions = {
  keepRawHistory?: boolean;
  handledInputIds?: Iterable<string>;
};

export type RewriteDiff = {
  droppedInputIds: string[];
  keptInputIds: string[];
  rawInputTypeCounts: Record<string, number>;
  rewrittenInputTypeCounts: Record<string, number>;
  droppedInputTypeCounts: Record<string, number>;
  insertedSyntheticMemoryChars: number;
};

export type RewriteResult = {
  body: Record<string, unknown>;
  diff: RewriteDiff;
};

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

export async function rewriteRequestWithMemory(
  body: Record<string, unknown>,
  state: MemoryState,
  maxChars: number,
  options: DerivedPromptOptions = { keepRawHistory: false },
): Promise<RewriteResult> {
  const text = buildSyntheticMemoryText(state, maxChars);
  const { input, diff } = await buildDerivedPrompt(
    body.input,
    text ? makeSyntheticMemoryItem(text) : null,
    options,
  );
  return {
    body: {
      ...body,
      input,
    },
    diff: {
      ...diff,
      insertedSyntheticMemoryChars: text?.length ?? 0,
    },
  };
}

export async function buildDerivedPrompt(
  input: unknown,
  memoryItem: Record<string, unknown> | null,
  options: DerivedPromptOptions = { keepRawHistory: false },
): Promise<{ input: unknown; diff: RewriteDiff }> {
  const rawDescriptors = await describeInputItems(input);
  const filtered = rawDescriptors.filter((item) => !item.isSyntheticMemory);
  const derived = options.keepRawHistory === true ? filtered : deriveCurrentTurnInput(filtered);
  const pruned = options.keepRawHistory === true
    ? derived
    : pruneHandledProtocolSegments(derived, new Set(options.handledInputIds ?? []));
  const finalRawItems = pruned.map((item) => item.item);
  const finalItems = memoryItem
    ? insertAfterInstructions(finalRawItems, memoryItem)
    : finalRawItems;

  return {
    input: shapeDerivedInput(input, finalItems, memoryItem),
    diff: {
      droppedInputIds: rawDescriptors.filter((item) => !pruned.some((kept) => kept.ref === item.ref)).map((
        item,
      ) => item.ref),
      keptInputIds: pruned.map((item) => item.ref),
      rawInputTypeCounts: countDescriptorTypes(rawDescriptors),
      rewrittenInputTypeCounts: countDescriptorTypes(await describeInputItems(finalItems)),
      droppedInputTypeCounts: countDescriptorTypes(
        rawDescriptors.filter((item) => !pruned.some((kept) => kept.ref === item.ref)),
      ),
      insertedSyntheticMemoryChars: 0,
    },
  };
}

function deriveCurrentTurnInput(input: InputItemDescriptor[]): InputItemDescriptor[] {
  const instructionCount = leadingInstructionCount(input.map((item) => item.item));
  const instructions = input.slice(0, instructionCount);
  const rest = input.slice(instructionCount);
  const latestUserIndex = findLatestUserMessageIndex(rest);
  if (latestUserIndex < 0) {
    return input;
  }
  return [
    ...instructions,
    ...rest.slice(latestUserIndex),
  ];
}

function findLatestUserMessageIndex(input: InputItemDescriptor[]): number {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index].kind === "user_message" && !input[index].isSyntheticMemory) {
      return index;
    }
  }
  return -1;
}

function pruneHandledProtocolSegments(
  input: InputItemDescriptor[],
  handledInputIds: Set<string>,
): InputItemDescriptor[] {
  const instructionCount = leadingInstructionCount(input.map((item) => item.item));
  const latestUserOffset = input.slice(instructionCount).findIndex((item) =>
    item.kind === "user_message" && !item.isSyntheticMemory
  );
  if (latestUserOffset < 0) {
    return input;
  }

  const latestUserIndex = instructionCount + latestUserOffset;
  const head = input.slice(0, latestUserIndex + 1);
  const tail = input.slice(latestUserIndex + 1);
  const segments = splitProtocolSegments(tail);
  if (segments.length < 2) {
    return input;
  }

  const kept = [...head];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLastSegment = index === segments.length - 1;
    if (isLastSegment || !canDropHandledSegment(segment, handledInputIds)) {
      kept.push(...segment);
    }
  }
  return kept;
}

function splitProtocolSegments(tail: InputItemDescriptor[]): InputItemDescriptor[][] {
  const segments: InputItemDescriptor[][] = [];
  let current: InputItemDescriptor[] = [];
  for (const item of tail) {
    current.push(item);
    if (item.kind === "tool_output") {
      segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function canDropHandledSegment(
  segment: InputItemDescriptor[],
  handledInputIds: Set<string>,
): boolean {
  let hasHandledAnchor = false;
  const outputsByCallId = new Map<string, InputItemDescriptor>();
  for (const item of segment) {
    if (item.kind === "tool_output" && item.callId) {
      outputsByCallId.set(item.callId, item);
    }
  }

  for (const item of segment) {
    if (item.kind === "assistant_message" || item.kind === "tool_output") {
      if (!item.id || !handledInputIds.has(item.id)) {
        return false;
      }
      hasHandledAnchor = true;
      continue;
    }
    if (item.kind === "tool_call") {
      if (!item.callId) {
        return false;
      }
      const output = outputsByCallId.get(item.callId);
      if (!output?.id || !handledInputIds.has(output.id)) {
        return false;
      }
      continue;
    }
    if (item.kind === "reasoning") {
      continue;
    }
    return false;
  }

  return hasHandledAnchor;
}

function insertAfterInstructions(
  input: unknown[],
  memoryItem: Record<string, unknown>,
): unknown[] {
  const insertIndex = leadingInstructionCount(input);
  return [
    ...input.slice(0, insertIndex),
    memoryItem,
    ...input.slice(insertIndex),
  ];
}

function shapeDerivedInput(
  originalInput: unknown,
  finalItems: unknown[],
  memoryItem: Record<string, unknown> | null,
): unknown {
  if (Array.isArray(originalInput)) {
    return finalItems;
  }
  if (typeof originalInput === "string") {
    return memoryItem ? finalItems : originalInput;
  }
  return memoryItem ? finalItems : originalInput;
}

function countDescriptorTypes(input: InputItemDescriptor[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of input) {
    const key = descriptorTypeKey(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function descriptorTypeKey(item: InputItemDescriptor): string {
  if (item.kind === "instruction" || item.kind === "user_message" || item.kind === "assistant_message") {
    return `message:${item.role ?? "unknown"}`;
  }
  return item.type || item.kind;
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
