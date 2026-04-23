import type { ProxyConfig } from "./config.ts";
import { itemTypeCounts, type InputItemDescriptor, describeInputItems, inputItems } from "./tool_results.ts";
import type { MemoryState, PieceRecord } from "./memory_state.ts";

export type RewriteDiff = {
  droppedInputIds: string[];
  keptInputIds: string[];
  rawInputTypeCounts: Record<string, number>;
  rewrittenInputTypeCounts: Record<string, number>;
  insertedTaskCount: number;
  indexedPieceCount: number;
};

export type RewriteResult = {
  body: Record<string, unknown>;
  diff: RewriteDiff;
};

export async function rewriteRequestWithMemory(
  body: Record<string, unknown>,
  memory: MemoryState,
  config: ProxyConfig,
): Promise<RewriteResult> {
  const raw = await describeInputItems(body.input);
  const filtered = raw.filter((item) => !item.isSyntheticTaskMemory);
  const instructions = leadingInstructions(filtered);
  const tail = currentRoundTail(filtered);
  const memoryItem = makeTaskMemoryItem(memory, config);
  const rewrittenItems = [
    ...instructions.map((item) => item.item),
    ...(memoryItem ? [memoryItem] : []),
    ...tail.map((item) => item.item),
  ];

  const rewrittenBody = {
    ...body,
    input: rewrittenItems,
    tools: injectContextGetTool(body.tools, memory),
  };
  const rewrittenDescriptors = await describeInputItems(rewrittenItems);

  return {
    body: rewrittenBody,
    diff: {
      droppedInputIds: filtered.filter((item) => !tailOrInstructionContains(item, instructions, tail))
        .map((item) => item.ref),
      keptInputIds: [...instructions, ...tail].map((item) => item.ref),
      rawInputTypeCounts: itemTypeCounts(raw),
      rewrittenInputTypeCounts: itemTypeCounts(rewrittenDescriptors),
      insertedTaskCount: memory.tasks.length,
      indexedPieceCount: memory.pieces.length,
    },
  };
}

export async function buildDerivedPrompt(
  input: unknown,
  memoryItem: Record<string, unknown> | null,
): Promise<{ input: unknown; diff: RewriteDiff }> {
  const raw = await describeInputItems(input);
  const filtered = raw.filter((item) => !item.isSyntheticTaskMemory);
  const instructions = leadingInstructions(filtered);
  const tail = currentRoundTail(filtered);
  const items = [
    ...instructions.map((item) => item.item),
    ...(memoryItem ? [memoryItem] : []),
    ...tail.map((item) => item.item),
  ];
  const rewrittenDescriptors = await describeInputItems(items);

  return {
    input: items,
    diff: {
      droppedInputIds: filtered.filter((item) => !tailOrInstructionContains(item, instructions, tail))
        .map((item) => item.ref),
      keptInputIds: [...instructions, ...tail].map((item) => item.ref),
      rawInputTypeCounts: itemTypeCounts(raw),
      rewrittenInputTypeCounts: itemTypeCounts(rewrittenDescriptors),
      insertedTaskCount: memoryItem ? 1 : 0,
      indexedPieceCount: 0,
    },
  };
}

export function makeTaskMemoryItem(
  memory: MemoryState,
  config: Pick<ProxyConfig, "maxIndexedPiecesPerTask">,
): Record<string, unknown> | null {
  if (memory.tasks.length === 0) {
    return null;
  }

  return {
    type: "message",
    role: "developer",
    name: "pando_task_memory",
    content: [{
      type: "input_text",
      text: buildTaskMemoryText(memory, config),
    }],
  };
}

export function buildTaskMemoryText(
  memory: MemoryState,
  config: Pick<ProxyConfig, "maxIndexedPiecesPerTask">,
): string {
  const lines = ["<pando_task_memory>", "<tasks>"];
  for (const task of memory.tasks) {
    lines.push(`- id=${task.id} status=${task.status} kind=${task.kind} text=${JSON.stringify(task.text)}`);
  }
  lines.push("</tasks>", "<piece_index>");
  for (const task of memory.tasks) {
    const pieces = memory.pieces
      .filter((piece) => piece.taskIds.includes(task.id))
      .sort((left, right) => right.createdSeq - left.createdSeq);
    lines.push(`task=${task.id}`);
    for (const piece of pieces.slice(0, config.maxIndexedPiecesPerTask)) {
      lines.push(`- ${formatPieceIndexLine(piece)}`);
    }
    if (pieces.length > config.maxIndexedPiecesPerTask) {
      lines.push(`- omitted=${pieces.length - config.maxIndexedPiecesPerTask}`);
    }
  }
  lines.push(
    "</piece_index>",
    "<context_get>",
    "Use context_get with exact pieceIds when you need exact old context. Do not ask for broad fetches.",
    "</context_get>",
    "</pando_task_memory>",
  );
  return lines.join("\n");
}

function formatPieceIndexLine(piece: PieceRecord): string {
  const fields = [
    `pieceId=${piece.id}`,
    `source=${piece.sourceKind}`,
    ...(piece.toolName ? [`tool=${piece.toolName}`] : []),
    `bytes=${piece.byteSize}`,
    `selector=${selectorLabel(piece)}`,
    ...(piece.previewText ? [`preview=${JSON.stringify(piece.previewText)}`] : []),
    ...(piece.pointer ? [`pointer=${JSON.stringify(piece.pointer)}`] : []),
  ];
  return fields.join(" ");
}

function selectorLabel(piece: PieceRecord): string {
  if (piece.selector.kind === "whole") {
    return "whole";
  }
  if (piece.selector.kind === "line_range") {
    return `lines:${piece.selector.startLine}-${piece.selector.endLine}`;
  }
  return `path:${JSON.stringify(piece.selector.path)}`;
}

function leadingInstructions(items: InputItemDescriptor[]): InputItemDescriptor[] {
  const out: InputItemDescriptor[] = [];
  for (const item of items) {
    if (!item.isInstruction) {
      break;
    }
    out.push(item);
  }
  return out;
}

function currentRoundTail(items: InputItemDescriptor[]): InputItemDescriptor[] {
  const withoutLeading = items.slice(leadingInstructions(items).length);
  let lastUserIndex = -1;
  for (let index = 0; index < withoutLeading.length; index += 1) {
    const item = withoutLeading[index];
    if (item.type === "message" && item.role === "user") {
      lastUserIndex = index;
    }
  }
  return lastUserIndex >= 0 ? withoutLeading.slice(lastUserIndex) : withoutLeading;
}

function injectContextGetTool(tools: unknown, memory: MemoryState): unknown {
  const existing = Array.isArray(tools) ? [...tools] : [];
  if (memory.pieces.length === 0) {
    return existing;
  }
  if (existing.some((tool) => isContextGetTool(tool))) {
    return existing;
  }
  existing.push({
    type: "function",
    name: "context_get",
    description: "Fetch exact previously stored pieces by exact piece id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pieceIds"],
      properties: {
        pieceIds: {
          type: "array",
          items: { type: "string" },
          description: "Exact piece ids to retrieve.",
        },
      },
    },
  });
  return existing;
}

function isContextGetTool(tool: unknown): boolean {
  return Boolean(
    tool &&
      typeof tool === "object" &&
      !Array.isArray(tool) &&
      (tool as Record<string, unknown>).name === "context_get",
  );
}

function tailOrInstructionContains(
  item: InputItemDescriptor,
  instructions: InputItemDescriptor[],
  tail: InputItemDescriptor[],
): boolean {
  return instructions.some((candidate) => candidate.ref === item.ref) ||
    tail.some((candidate) => candidate.ref === item.ref);
}

export function inputTypeCounts(input: unknown): Promise<Record<string, number>> {
  return describeInputItems(input).then(itemTypeCounts);
}

export function normalizedInputItems(input: unknown): unknown[] {
  return inputItems(input);
}
