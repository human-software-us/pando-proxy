import type { ProxyConfig } from "./config.ts";
import { stableJson } from "./json.ts";
import { chronologicalChunks, type ChunkRecord, type MemoryState } from "./memory_state.ts";
import { itemTypeCounts, type InputItemDescriptor, describeInputItems, inputItems } from "./tool_results.ts";

export type RewriteDiff = {
  droppedInputIds: string[];
  keptInputIds: string[];
  rawInputTypeCounts: Record<string, number>;
  rewrittenInputTypeCounts: Record<string, number>;
  insertedMemory: boolean;
  inlineChunkCount: number;
  omittedChunkCount: number;
};

export type RewriteResult = {
  body: Record<string, unknown>;
  diff: RewriteDiff;
  inlineChunkIds: string[];
  omittedChunkIds: string[];
};

export async function rewriteRequestWithMemory(
  body: Record<string, unknown>,
  memory: MemoryState,
  config: ProxyConfig,
): Promise<RewriteResult> {
  const raw = await describeInputItems(body.input);
  const filtered = raw.filter((item) => !item.isSyntheticMemory);
  const instructions = leadingInstructions(filtered);
  const tail = currentRoundTail(filtered);
  const selection = selectPromptChunks(memory, config.maxIndexedPiecesPerTask);
  const memoryItem = makeWorkingMemoryItem(memory, selection.inlineChunks);
  const rewrittenItems = [
    ...instructions.map((item) => item.item),
    ...(memoryItem ? [memoryItem] : []),
    ...tail.map((item) => item.item),
  ];

  const rewrittenBody = {
    ...body,
    input: rewrittenItems,
    tools: injectMemoryTool(body.tools, selection.omittedChunks),
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
      insertedMemory: Boolean(memoryItem),
      inlineChunkCount: selection.inlineChunks.length,
      omittedChunkCount: selection.omittedChunks.length,
    },
    inlineChunkIds: selection.inlineChunks.map((chunk) => chunk.id),
    omittedChunkIds: selection.omittedChunks.map((chunk) => chunk.id),
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
      droppedInputIds: filtered.filter((item) => !tailOrInstructionContains(item, instructions, tail))
        .map((item) => item.ref),
      keptInputIds: [...instructions, ...tail].map((item) => item.ref),
      rawInputTypeCounts: itemTypeCounts(raw),
      rewrittenInputTypeCounts: itemTypeCounts(rewrittenDescriptors),
      insertedMemory: Boolean(memoryItem),
      inlineChunkCount: 0,
      omittedChunkCount: 0,
    },
  };
}

export function makeWorkingMemoryItem(
  memory: MemoryState,
  inlineChunks: ChunkRecord[],
): Record<string, unknown> | null {
  if (!memory.objective && inlineChunks.length === 0) {
    return null;
  }

  return {
    type: "message",
    role: "developer",
    content: [{
      type: "input_text",
      text: buildWorkingMemoryText(memory, inlineChunks),
    }],
  };
}

export function buildWorkingMemoryText(
  memory: MemoryState,
  inlineChunks: ChunkRecord[],
): string {
  const lines = ["<pando_working_memory>"];
  if (memory.objective) {
    lines.push("<objective>", memory.objective, "</objective>");
  }
  lines.push("<exact_chunks>");
  for (const chunk of inlineChunks) {
    lines.push(`<chunk id="${chunk.id}">`);
    lines.push(formatChunkPayload(chunk.payload));
    lines.push("</chunk>");
  }
  lines.push("</exact_chunks>");
  lines.push("<memory_fallback>");
  lines.push("If the attached exact chunks are insufficient, call memory({chunkIds:[...]}) to fetch exact retained chunks by id when you already know those ids from visible context or earlier memory() results.");
  lines.push("Use memory({offset, limit}) to paginate additional exact retained chunks from the hidden retained set.");
  lines.push("memory() skips any chunks already visible in this prompt or already returned by earlier memory() calls in this turn.");
  lines.push("If you do not know the needed chunk ids, browse with memory({offset, limit}) until you find the exact chunk, then request specific ids if helpful.");
  lines.push("Prefer attached chunks over running new tools when they already contain the needed exact fact.");
  lines.push("Do not claim prior captured data is unavailable until you have used memory() when the visible chunks are insufficient.");
  lines.push("When asked to restate or recall exact prior captured content, use memory({chunkIds:[...]}) or memory({offset, limit}) before answering from absence.");
  lines.push("</memory_fallback>");
  lines.push("</pando_working_memory>");
  return lines.join("\n");
}

function formatChunkPayload(payload: unknown): string {
  return typeof payload === "string" ? payload : stableJson(payload);
}

function selectPromptChunks(
  memory: MemoryState,
  maxInlineChunks: number,
): { inlineChunks: ChunkRecord[]; omittedChunks: ChunkRecord[] } {
  const ordered = chronologicalChunks(memory.chunks);
  if (maxInlineChunks <= 0 || ordered.length <= maxInlineChunks) {
    return { inlineChunks: ordered, omittedChunks: [] };
  }
  const inlineChunks = [...ordered]
    .sort(compareInlinePriority)
    .slice(0, maxInlineChunks)
    .sort((left, right) =>
      left.createdSeq === right.createdSeq ? left.id.localeCompare(right.id) : left.createdSeq - right.createdSeq
    );
  const inlineIds = new Set(inlineChunks.map((chunk) => chunk.id));
  return {
    inlineChunks,
    omittedChunks: ordered.filter((chunk) => !inlineIds.has(chunk.id)),
  };
}

function compareInlinePriority(left: ChunkRecord, right: ChunkRecord): number {
  const score = (chunk: ChunkRecord): number => {
    let total = 0;
    if (chunk.sourceKind === "tool") {
      total += 100;
    } else if (chunk.sourceKind === "user") {
      total += 50;
    }
    if (chunk.selector.kind === "whole") {
      total += 10;
    }
    total += Math.min(chunk.byteSize, 8_192) / 8_192;
    total += chunk.createdSeq / 1_000_000;
    return total;
  };
  return score(right) - score(left);
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

function injectMemoryTool(tools: unknown, omittedChunks: ChunkRecord[]): unknown {
  const existing = Array.isArray(tools) ? [...tools] : [];
  if (omittedChunks.length === 0) {
    return existing;
  }
  if (existing.some((tool) => isMemoryTool(tool))) {
    return existing;
  }
  existing.push({
    type: "function",
    name: "memory",
    description: "Fetch additional exact retained chunks by id or in chronological order.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        chunkIds: {
          type: "array",
          items: { type: "string" },
          description: "Exact retained chunk ids to fetch. Chunks already visible in the prompt are skipped.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "How many additional retained chunks to skip when browsing omitted chunks.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "How many additional retained chunks to return when browsing omitted chunks.",
        },
      },
    },
  });
  return existing;
}

function isMemoryTool(tool: unknown): boolean {
  return Boolean(
    tool &&
      typeof tool === "object" &&
      !Array.isArray(tool) &&
      (tool as Record<string, unknown>).name === "memory",
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
