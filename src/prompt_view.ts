import type { ProxyConfig } from "./config.ts";
import { stableJson } from "./json.ts";
import {
  activeGroups,
  chronologicalPieces,
  type MemoryPiece,
  type MemoryState,
  piecePreview,
} from "./memory_state.ts";
import {
  describeInputItems,
  type InputItemDescriptor,
  itemTypeCounts,
} from "./tool_results.ts";

export type RewriteDiff = {
  droppedInputIds: string[];
  keptInputIds: string[];
  rawInputTypeCounts: Record<string, number>;
  rewrittenInputTypeCounts: Record<string, number>;
  insertedMemory: boolean;
  memoryPieceCount: number;
};

export type RewriteResult = {
  body: Record<string, unknown>;
  diff: RewriteDiff;
  memoryPieceIds: string[];
};

export async function rewriteRequestWithMemory(
  body: Record<string, unknown>,
  memory: MemoryState,
  _config: ProxyConfig,
): Promise<RewriteResult> {
  const raw = await describeInputItems(body.input);
  const filtered = raw.filter((item) => !item.isSyntheticMemory);
  const instructions = leadingInstructions(filtered);
  const tail = currentRoundTail(filtered);
  const memoryPieces = chronologicalPieces(memory.pieces);
  const memoryItem = makePromptMemoryItem(memory, memoryPieces);
  const rewrittenItems = [
    ...instructions.map((item) => item.item),
    ...(memoryItem ? [memoryItem] : []),
    ...tail.map((item) => item.item),
  ];
  const rewrittenDescriptors = await describeInputItems(rewrittenItems);

  return {
    body: {
      ...body,
      input: rewrittenItems,
      tools: injectRecallTool(body.tools, hasArchivedSourceGap(memory)),
    },
    diff: {
      droppedInputIds: filtered.filter((item) => !containsRef(item, instructions, tail)).map((
        item,
      ) => item.ref),
      keptInputIds: [...instructions, ...tail].map((item) => item.ref),
      rawInputTypeCounts: itemTypeCounts(raw),
      rewrittenInputTypeCounts: itemTypeCounts(rewrittenDescriptors),
      insertedMemory: Boolean(memoryItem),
      memoryPieceCount: memoryPieces.length,
    },
    memoryPieceIds: memoryPieces.map((piece) => piece.id),
  };
}

export async function buildDerivedPrompt(
  input: unknown,
  memoryItem: Record<string, unknown> | null,
): Promise<{ input: unknown; diff: RewriteDiff }> {
  const raw = await describeInputItems(input);
  const filtered = raw.filter((item) => !item.isSyntheticMemory);
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
      droppedInputIds: filtered.filter((item) => !containsRef(item, instructions, tail)).map((
        item,
      ) => item.ref),
      keptInputIds: [...instructions, ...tail].map((item) => item.ref),
      rawInputTypeCounts: itemTypeCounts(raw),
      rewrittenInputTypeCounts: itemTypeCounts(rewrittenDescriptors),
      insertedMemory: Boolean(memoryItem),
      memoryPieceCount: 0,
    },
  };
}

export function makePromptMemoryItem(
  memory: MemoryState,
  pieces: MemoryPiece[],
): Record<string, unknown> | null {
  if (memory.groups.length === 0 && pieces.length === 0) {
    return null;
  }

  return {
    type: "message",
    role: "developer",
    content: [{
      type: "input_text",
      text: buildPromptMemoryText(memory, pieces),
    }],
  };
}

export function buildPromptMemoryText(memory: MemoryState, pieces: MemoryPiece[]): string {
  const lines = ["<pando_group_memory>"];
  const groups = activeGroups(memory.groups);
  if (groups.length > 0) {
    lines.push("<groups>");
    for (const group of groups) {
      lines.push(
        `- groupId=${group.id} status=${group.status} label=${group.routingLabel} summary=${group.summary}`,
      );
    }
    lines.push("</groups>");
  }
  lines.push("<exact_pieces>");
  for (const piece of pieces) {
    lines.push(
      `<piece pieceId=${piece.id} groupId=${piece.groupId} sourceKind=${piece.sourceKind}>`,
    );
    lines.push(
      piece.payloadInline === undefined
        ? piecePreview(piece)
        : formatPiecePayload(piece.payloadInline),
    );
    lines.push("</piece>");
  }
  lines.push("</exact_pieces>");
  if (hasArchivedSourceGap(memory)) {
    lines.push("<archive>");
    lines.push(
      "If you truly need older exact material that is not shown above, you may call recall({offset,limit}) once.",
    );
    lines.push(
      "Use it only as an emergency recovery path for earlier exact sources from the per-session archive, not from active memory.",
    );
    lines.push("</archive>");
  }
  lines.push("</pando_group_memory>");
  return lines.join("\n");
}

function formatPiecePayload(payload: unknown): string {
  return typeof payload === "string" ? payload : stableJson(payload);
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

function containsRef(
  item: InputItemDescriptor,
  instructions: InputItemDescriptor[],
  tail: InputItemDescriptor[],
): boolean {
  return instructions.some((candidate) => candidate.ref === item.ref) ||
    tail.some((candidate) => candidate.ref === item.ref);
}

function hasArchivedSourceGap(memory: MemoryState): boolean {
  const visibleSourceIds = new Set(memory.pieces.map((piece) => piece.sourceId));
  return memory.processedSourceIds.some((sourceId) => !visibleSourceIds.has(sourceId));
}

function injectRecallTool(tools: unknown, shouldInject: boolean): unknown {
  const existing = Array.isArray(tools) ? [...tools] : [];
  if (!shouldInject) {
    return existing;
  }
  if (existing.some((tool) => isRecallTool(tool))) {
    return existing;
  }
  existing.push({
    type: "function",
    name: "recall",
    description:
      "Emergency one-shot recovery of older exact archived sources in chronological order.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        offset: {
          type: "integer",
          minimum: 0,
          description: "How many archived older sources to skip.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "How many archived older sources to return.",
        },
      },
      required: ["offset", "limit"],
    },
  });
  return existing;
}

function isRecallTool(tool: unknown): boolean {
  return Boolean(
    tool &&
      typeof tool === "object" &&
      !Array.isArray(tool) &&
      (tool as Record<string, unknown>).name === "recall",
  );
}

export function inputTypeCounts(input: unknown): Promise<Record<string, number>> {
  return describeInputItems(input).then(itemTypeCounts);
}

export function normalizedInputItems(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [input];
}
