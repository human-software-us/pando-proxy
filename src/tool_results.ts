import { shortHash } from "./hash.ts";
import { stableJson } from "./json.ts";
import { isRecord } from "./memory_state.ts";

export type RoundSource = {
  sourceId: string;
  sourceKind: "user" | "assistant" | "tool" | "tool_call";
  payload: unknown;
  toolName?: string;
  pointer?: Record<string, unknown>;
};

export type InputItemDescriptor = {
  ref: string;
  type: string;
  role?: string;
  item: unknown;
  isInstruction: boolean;
  isSyntheticMemory: boolean;
};

export async function extractNewRequestSources(
  body: Record<string, unknown>,
  processedSourceIds: Set<string>,
): Promise<RoundSource[]> {
  const items = inputItems(body.input);
  const toolNamesByCallId = collectToolNamesByCallId(items);
  const out: RoundSource[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const descriptor = await describeInputItem(item, index);
    if (descriptor.isSyntheticMemory) {
      continue;
    }
    const source = sourceFromInputItem(item, descriptor.ref, toolNamesByCallId);
    if (!source || processedSourceIds.has(source.sourceId)) {
      continue;
    }
    out.push(source);
  }

  return out;
}

export async function extractAssistantSourcesFromResponse(
  response: unknown,
): Promise<RoundSource[]> {
  if (!isRecord(response)) {
    return [];
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const toolNamesByCallId = collectToolNamesByCallId(output);
  const out: RoundSource[] = [];

  for (let index = 0; index < output.length; index += 1) {
    const item = output[index];
    if (isAssistantMessageItem(item)) {
      out.push({
        sourceId: await responseItemId(item, response, index),
        sourceKind: "assistant",
        payload: item,
      });
      continue;
    }
    if (isRecord(item)) {
      const type = typeof item.type === "string" ? item.type : "";
      if (isReasoningItem(type)) {
        out.push({
          sourceId: await responseItemId(item, response, index),
          sourceKind: "assistant",
          payload: item,
          pointer: { itemType: type },
        });
      } else if (isToolOutputItem(type)) {
        const sourceId = await responseItemId(item, response, index);
        const callId = typeof item.call_id === "string" ? item.call_id : undefined;
        const toolName = (typeof item.name === "string" ? item.name : undefined) ??
          (callId ? toolNamesByCallId.get(callId) : undefined);
        out.push({
          sourceId,
          sourceKind: "tool",
          payload: normalizeToolPayload(toolName, "output" in item ? item.output : item),
          ...(toolName ? { toolName } : {}),
          pointer: {
            ...(callId ? { callId } : {}),
            itemType: type,
          },
        });
      } else if (isToolCallItem(type)) {
        // The agent's invocation of a tool (function_call / *_tool_call). One source
        // per call; later treated as one whole chunk.
        // Disambiguate from the matching function_call_output (which shares call_id):
        // prefix the call's sourceId with "tool_call:" so they don't collide.
        const baseId = await responseItemId(item, response, index);
        const callId = typeof item.call_id === "string" ? item.call_id : undefined;
        const toolName = typeof item.name === "string" ? item.name : undefined;
        out.push({
          sourceId: `tool_call:${baseId}`,
          sourceKind: "tool_call",
          payload: item,
          ...(toolName ? { toolName } : {}),
          pointer: {
            ...(callId ? { callId } : {}),
            itemType: type,
          },
        });
      }
    }
  }

  if (out.length > 0) {
    return out;
  }

  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return [{
      sourceId: await syntheticResponseId(response, "output_text"),
      sourceKind: "assistant",
      payload: response.output_text,
    }];
  }

  return [];
}

export function inputItems(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return [...input];
  }
  if (typeof input === "string") {
    return [stringInputMessage(input)];
  }
  if (isRecord(input)) {
    return [input];
  }
  return [];
}

export async function describeInputItems(input: unknown): Promise<InputItemDescriptor[]> {
  const items = inputItems(input);
  return await Promise.all(items.map((item, index) => describeInputItem(item, index)));
}

export async function inputItemId(item: unknown, _index: number): Promise<string> {
  return await stableSourceId(item, "input");
}

export function itemTypeCounts(items: InputItemDescriptor[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] ?? 0) + 1;
  }
  return counts;
}

async function describeInputItem(item: unknown, index: number): Promise<InputItemDescriptor> {
  const type = isRecord(item) && typeof item.type === "string" ? item.type : typeof item;
  const role = isRecord(item) && typeof item.role === "string" ? item.role : undefined;
  return {
    ref: await inputItemId(item, index),
    type,
    ...(role ? { role } : {}),
    item,
    isInstruction: type === "message" && (role === "developer" || role === "system"),
    isSyntheticMemory: isSyntheticMemoryItem(item),
  };
}

function sourceFromInputItem(
  item: unknown,
  sourceId: string,
  toolNamesByCallId: Map<string, string>,
): RoundSource | null {
  if (!isRecord(item)) {
    return {
      sourceId,
      sourceKind: "user",
      payload: item,
    };
  }

  const type = typeof item.type === "string" ? item.type : "";
  const role = typeof item.role === "string" ? item.role : "";

  if (type === "message" && role === "user") {
    return {
      sourceId,
      sourceKind: "user",
      payload: item,
    };
  }

  if (type === "message" && role === "assistant") {
    return {
      sourceId,
      sourceKind: "assistant",
      payload: item,
    };
  }

  if (isToolOutputItem(type)) {
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    const toolName = (typeof item.name === "string" ? item.name : undefined) ??
      (callId ? toolNamesByCallId.get(callId) : undefined);
    return {
      sourceId,
      sourceKind: "tool",
      payload: normalizeToolPayload(toolName, "output" in item ? item.output : item),
      ...(toolName ? { toolName } : {}),
      pointer: {
        ...(callId ? { callId } : {}),
        itemType: type,
      },
    };
  }

  if (isToolCallItem(type)) {
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    const toolName = typeof item.name === "string" ? item.name : undefined;
    return {
      sourceId: `tool_call:${sourceId}`,
      sourceKind: "tool_call",
      payload: item,
      ...(toolName ? { toolName } : {}),
      pointer: {
        ...(callId ? { callId } : {}),
        itemType: type,
      },
    };
  }

  if (isReasoningItem(type)) {
    return {
      sourceId,
      sourceKind: "assistant",
      payload: item,
      pointer: { itemType: type },
    };
  }

  return null;
}

function collectToolNamesByCallId(items: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const callId = typeof item.call_id === "string" ? item.call_id : undefined;
    const toolName = typeof item.name === "string" ? item.name : undefined;
    if (callId && toolName) {
      out.set(callId, toolName);
    }
  }
  return out;
}

function isToolOutputItem(type: string): boolean {
  return type === "function_call_output" ||
    type.endsWith("_tool_call_output") ||
    type === "custom_tool_call_output" ||
    type === "mcp_tool_call_output";
}

function isToolCallItem(type: string): boolean {
  if (isToolOutputItem(type)) {
    return false;
  }
  return type === "function_call" ||
    type.endsWith("_tool_call") ||
    type === "custom_tool_call" ||
    type === "mcp_tool_call";
}

function isReasoningItem(type: string): boolean {
  return type === "reasoning" || type.endsWith("_reasoning");
}

function normalizeToolPayload(toolName: string | undefined, payload: unknown): unknown {
  if (toolName === "exec_command" && typeof payload === "string") {
    return normalizeExecCommandOutput(payload);
  }
  return payload;
}

function normalizeExecCommandOutput(payload: string): string {
  const normalized = payload.replace(/\r\n/g, "\n");
  const marker = "\nOutput:\n";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) {
    return payload;
  }

  const extracted = normalized.slice(markerIndex + marker.length);
  return extracted.length > 0 ? extracted : payload;
}

function isAssistantMessageItem(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.type === "message" && value.role === "assistant";
}

function isSyntheticMemoryItem(item: unknown): boolean {
  if (!isRecord(item) || item.type !== "message" || item.role !== "developer") {
    return false;
  }
  const text = extractInlineText(item);
  return text.includes("<pando_task_memory>");
}

function extractInlineText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (!isRecord(entry)) {
      return "";
    }
    if (typeof entry.text === "string") {
      return entry.text;
    }
    if (typeof entry.input_text === "string") {
      return entry.input_text;
    }
    return "";
  }).join("\n");
}

async function responseItemId(
  item: Record<string, unknown>,
  response: Record<string, unknown>,
  index: number,
): Promise<string> {
  if (typeof item.id === "string" && item.id) {
    return item.id;
  }
  const responseId = typeof response.id === "string" ? response.id : "response";
  return await stableSourceId(item, `${responseId}_assistant_${index}`);
}

async function syntheticResponseId(
  response: Record<string, unknown>,
  suffix: string,
): Promise<string> {
  const responseId = typeof response.id === "string" ? response.id : "response";
  return await stableSourceId(response, `${responseId}_${suffix}`);
}

async function stableSourceId(value: unknown, prefix: string): Promise<string> {
  if (isRecord(value) && typeof value.id === "string" && value.id) {
    return value.id;
  }
  if (isRecord(value) && typeof value.call_id === "string" && value.call_id) {
    return value.call_id;
  }
  return `${prefix}_${await shortHash(stableJson(value), 20)}`;
}

function stringInputMessage(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}
