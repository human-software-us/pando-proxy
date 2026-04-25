import type { ProxyConfig } from "./config.ts";
import { stableJson } from "./json.ts";
import {
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
  inlinePieceCount: number;
  omittedPieceCount: number;
};

export type RewriteResult = {
  body: Record<string, unknown>;
  diff: RewriteDiff;
  inlinePieceIds: string[];
  omittedPieceIds: string[];
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
  const selected = selectedPromptPieces(memory);
  const memoryItem = makePromptMemoryItem(memory, selected.inlinePieces);
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
      tools: injectContextGetTool(body.tools, memory.pieces.length > 0),
    },
    diff: {
      droppedInputIds: filtered.filter((item) => !containsRef(item, instructions, tail)).map((
        item,
      ) => item.ref),
      keptInputIds: [...instructions, ...tail].map((item) => item.ref),
      rawInputTypeCounts: itemTypeCounts(raw),
      rewrittenInputTypeCounts: itemTypeCounts(rewrittenDescriptors),
      insertedMemory: Boolean(memoryItem),
      inlinePieceCount: selected.inlinePieces.length,
      omittedPieceCount: selected.omittedPieces.length,
    },
    inlinePieceIds: selected.inlinePieces.map((piece) => piece.id),
    omittedPieceIds: selected.omittedPieces.map((piece) => piece.id),
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
      inlinePieceCount: 0,
      omittedPieceCount: 0,
    },
  };
}

export function makePromptMemoryItem(
  memory: MemoryState,
  inlinePieces: MemoryPiece[],
): Record<string, unknown> | null {
  if (memory.pieces.length === 0) {
    return null;
  }

  return {
    type: "message",
    role: "developer",
    content: [{
      type: "input_text",
      text: buildPromptMemoryText(inlinePieces),
    }],
  };
}

export function buildPromptMemoryText(inlinePieces: MemoryPiece[]): string {
  const lines = ["<pando_memory>"];
  lines.push("<exact_pieces>");
  for (const piece of inlinePieces) {
    lines.push(`<piece pieceId=${piece.id} sourceKind=${piece.sourceKind}>`);
    lines.push(
      piece.payloadInline === undefined
        ? piecePreview(piece)
        : formatPiecePayload(piece.payloadInline),
    );
    lines.push("</piece>");
  }
  lines.push("</exact_pieces>");
  lines.push("<context_get>");
  lines.push("Use context_get({pieceIds:[...]}) when you know the needed piece ids.");
  lines.push(
    "Use context_get({offset,limit}) to browse additional retained exact pieces in chronological order.",
  );
  lines.push("Prefer attached exact pieces when they already contain the needed fact.");
  lines.push("</context_get>");
  lines.push("</pando_memory>");
  return lines.join("\n");
}

function formatPiecePayload(payload: unknown): string {
  return typeof payload === "string" ? payload : stableJson(payload);
}

function selectedPromptPieces(
  memory: MemoryState,
): { inlinePieces: MemoryPiece[]; omittedPieces: MemoryPiece[] } {
  const ordered = chronologicalPieces(memory.pieces);
  const inlineIdSet = new Set(memory.inlinePieceIds);
  const inlinePieces = ordered.filter((piece) => inlineIdSet.has(piece.id));
  return {
    inlinePieces,
    omittedPieces: ordered.filter((piece) => !inlineIdSet.has(piece.id)),
  };
}

function injectContextGetTool(tools: unknown, shouldInject: boolean): unknown {
  const existing = Array.isArray(tools) ? [...tools] : [];
  if (!shouldInject) {
    return existing;
  }
  if (existing.some((tool) => isContextGetTool(tool))) {
    return existing;
  }
  existing.push({
    type: "function",
    name: "context_get",
    description:
      "Fetch additional exact retained memory pieces by id or in chronological order.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        pieceIds: {
          type: "array",
          items: { type: "string" },
          description: "Exact retained piece ids to fetch.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "How many retained pieces to skip when browsing.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "How many retained pieces to return when browsing.",
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

export function inputTypeCounts(input: unknown): Promise<Record<string, number>> {
  return describeInputItems(input).then(itemTypeCounts);
}

export function normalizedInputItems(input: unknown): unknown[] {
  return Array.isArray(input) ? input : [input];
}
