import type { ProxyConfig } from "./config.ts";
import {
  activeGroups,
  chronologicalPieces,
  type MaterializedMemoryPiece,
  type MaterializedMemoryState,
  piecePreview,
} from "./memory_state.ts";
import { describeInputItems, type InputItemDescriptor, itemTypeCounts } from "./tool_results.ts";

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
  memory: MaterializedMemoryState,
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
  memory: MaterializedMemoryState,
  pieces: MaterializedMemoryPiece[],
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

export function buildPromptMemoryText(
  memory: MaterializedMemoryState,
  pieces: MaterializedMemoryPiece[],
): string {
  const lines = ["<pando_group_memory>"];
  const groups = activeGroups(memory.groups);
  if (groups.length > 0) {
    lines.push("<groups>");
    for (const group of groups) {
      lines.push(
        `- groupId=${group.id} status=${group.status} label=${group.routingLabel} summary=${group.summary}`,
      );
    }
    lines.push(
      "Group summaries are summaries only. For verbatim or formatting-sensitive output, use visible exact pieces or recall. Do not reconstruct byte-exact text from a summary.",
    );
    lines.push(
      "If the user asks for an exact original block, snippet, template, or raw text and that full raw text is not visibly present in <exact_pieces>, you must use recall before answering.",
    );
    lines.push("</groups>");
  }
  lines.push("<exact_pieces>");
  for (const piece of pieces) {
    lines.push(
      `<piece pieceId=${piece.id} groupId=${piece.groupId} sourceKind=${piece.sourceKind}>`,
    );
    lines.push(piece.renderText || piecePreview(piece));
    lines.push("</piece>");
  }
  lines.push("</exact_pieces>");
  const archivedCount = archivedSourceCount(memory);
  if (archivedCount > 0) {
    lines.push("<archive>");
    lines.push(`archivedSourceCount=${archivedCount}`);
    lines.push(
      "If you truly need older exact material that is not shown above, you may call recall({offset,limit}) up to 3 times in this round.",
    );
    lines.push(
      "Use recall only as an emergency recovery path for earlier exact sources from the per-session archive, not from active memory.",
    );
    lines.push(
      "Prefer answering from active memory first. If you do use recall, request enough chronological coverage to satisfy the task and err on asking for more archived pieces rather than fewer.",
    );
    lines.push(
      "If the task asks for verbatim, byte-sensitive, spacing-sensitive, punctuation-sensitive, indentation-sensitive, or line-break-exact reproduction and the needed raw source is not visibly present above, use recall instead of reconstructing from a summary.",
    );
    lines.push(
      "Names or summaries like BLOCK23-A or SNIP26-A do not make the raw text visible. Only <exact_pieces> or recall provide the canonical raw source.",
    );
    lines.push("</archive>");
  }
  lines.push("</pando_group_memory>");
  return lines.join("\n");
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

function hasArchivedSourceGap(memory: MaterializedMemoryState): boolean {
  return archivedSourceCount(memory) > 0;
}

function archivedSourceCount(memory: MaterializedMemoryState): number {
  const visibleSourceIds = new Set(memory.pieces.map((piece) => piece.sourceId));
  return memory.processedSourceIds.filter((sourceId) => !visibleSourceIds.has(sourceId)).length;
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
      "Emergency recovery of older exact archived sources in chronological order. Use it when the user asks for exact original raw text, snippets, blocks, templates, or formatting-sensitive content that is not fully visible in active memory; request enough coverage to satisfy the task, err on asking for more rather than fewer, and use at most 3 times per round.",
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
