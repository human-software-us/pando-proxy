import { compactJson, stableJson } from "./json.ts";
import { shortHash } from "./hash.ts";
import { isRecord, MemoryState } from "./memory_state.ts";

export type ToolResultEnvelope = {
  id: string;
  origin: "mcp" | "native";
  toolName: string;
  serverName?: string;
  params?: Record<string, unknown>;
  content: unknown;
  activeTaskId: string | null;
};

export type UserMessageExtraction = {
  messageId: string;
  text: string;
};

export type AssistantResponseExtraction = {
  responseId: string;
  text: string;
};

export type ExtractedInputs = {
  userMessages: UserMessageExtraction[];
  assistantResponses: AssistantResponseExtraction[];
  toolResults: ToolResultEnvelope[];
};

export type InputItemDescriptor = {
  index: number;
  item: unknown;
  type: string;
  role: string | null;
  kind:
    | "instruction"
    | "user_message"
    | "assistant_message"
    | "tool_call"
    | "tool_output"
    | "reasoning"
    | "other";
  id?: string;
  callId?: string;
  text?: string;
  isSyntheticMemory: boolean;
  isOperationalContext: boolean;
  ref: string;
};

export function inputItems(input: unknown): unknown[] {
  return Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
}

export async function describeInputItems(input: unknown): Promise<InputItemDescriptor[]> {
  const items = inputItems(input);
  return await Promise.all(items.map((item, index) => describeInputItem(item, index)));
}

export async function extractInputs(
  body: Record<string, unknown>,
  state: MemoryState,
): Promise<ExtractedInputs> {
  const items = inputItems(body.input);
  const callsById = new Map<string, { toolName: string; params?: Record<string, unknown> }>();

  for (const item of items) {
    if (!isRecord(item)) {
      continue;
    }
    const type = String(item.type ?? "");
    const callId = typeof item.call_id === "string"
      ? item.call_id
      : typeof item.id === "string"
      ? item.id
      : null;
    if (!callId) {
      continue;
    }
    if (
      type === "function_call" || type === "custom_tool_call" || type === "mcp_tool_call" ||
      "arguments" in item
    ) {
      const name = extractToolName(item);
      if (name) {
        callsById.set(callId, { toolName: name, params: parseMaybeJsonObject(item.arguments) });
      }
    }
  }

  const userMessages: UserMessageExtraction[] = [];
  const assistantResponses: AssistantResponseExtraction[] = [];
  const toolResults: ToolResultEnvelope[] = [];
  const descriptors = await describeInputItems(items);

  for (const descriptor of descriptors) {
    const item = descriptor.item;
    if (descriptor.kind === "user_message") {
      if (
        descriptor.text && descriptor.text.trim().length > 0 && !descriptor.isSyntheticMemory &&
        !descriptor.isOperationalContext && descriptor.id
      ) {
        userMessages.push({
          messageId: descriptor.id,
          text: descriptor.text,
        });
      }
      continue;
    }

    if (descriptor.kind === "assistant_message") {
      if (descriptor.text && descriptor.text.trim().length > 0 && descriptor.id) {
        assistantResponses.push({
          responseId: descriptor.id,
          text: descriptor.text,
        });
      }
      continue;
    }

    if (descriptor.kind === "tool_output" && isRecord(item) && descriptor.id) {
      const callId = typeof item.call_id === "string"
        ? item.call_id
        : typeof item.id === "string"
        ? item.id
        : "";
      const call = callId ? callsById.get(callId) : undefined;
      const toolName = extractToolName(item) ?? call?.toolName ??
        `unknown_tool_${callId || descriptor.index}`;
      const { serverName } = splitQualifiedToolName(toolName);
      toolResults.push({
        id: descriptor.id,
        origin: item.type === "mcp_tool_call_output" || serverName ? "mcp" : "native",
        toolName,
        serverName,
        params: parseMaybeJsonObject(item.arguments) ?? call?.params,
        content: extractToolContent(item),
        activeTaskId: state.activeTaskId,
      });
    }
  }

  return { userMessages, assistantResponses, toolResults };
}

async function describeInputItem(item: unknown, index: number): Promise<InputItemDescriptor> {
  if (typeof item === "string") {
    const id = `user_${await shortHash(`string:${index}:${item}`)}`;
    return {
      index,
      item,
      type: "string",
      role: "user",
      kind: "user_message",
      id,
      text: item,
      isSyntheticMemory: isSyntheticMemoryText(item),
      isOperationalContext: isOperationalContextText(item),
      ref: id,
    };
  }
  if (!isRecord(item)) {
    return {
      index,
      item,
      type: typeof item,
      role: null,
      kind: "other",
      isSyntheticMemory: false,
      isOperationalContext: false,
      ref: `${typeof item}:${index}`,
    };
  }

  const type = String(item.type ?? "");
  const role = typeof item.role === "string" ? item.role : null;
  const callId = typeof item.call_id === "string"
    ? item.call_id
    : typeof item.id === "string" && (type === "function_call" || type.endsWith("_tool_call"))
    ? item.id
    : undefined;

  if (role === "system" || role === "developer") {
    return {
      index,
      item,
      type,
      role,
      kind: "instruction",
      callId,
      isSyntheticMemory: false,
      isOperationalContext: false,
      ref: `${type || "message"}:${role}:${index}`,
    };
  }

  if (isUserMessage(item)) {
    const text = extractMessageText(item);
    const id = await inputItemId("user", index, item);
    return {
      index,
      item,
      type,
      role,
      kind: "user_message",
      id,
      callId,
      text,
      isSyntheticMemory: isSyntheticMemoryText(text),
      isOperationalContext: isOperationalContextText(text),
      ref: id,
    };
  }

  if (isAssistantMessage(item)) {
    const text = extractMessageText(item);
    const id = await inputItemId("assistant", index, item);
    return {
      index,
      item,
      type,
      role,
      kind: "assistant_message",
      id,
      callId,
      text,
      isSyntheticMemory: false,
      isOperationalContext: false,
      ref: id,
    };
  }

  if (isToolOutput(item)) {
    const id = await inputItemId("tool", index, item);
    return {
      index,
      item,
      type,
      role,
      kind: "tool_output",
      id,
      callId,
      isSyntheticMemory: false,
      isOperationalContext: false,
      ref: id,
    };
  }

  if (
    type === "function_call" || type === "custom_tool_call" || type === "mcp_tool_call" ||
    "arguments" in item
  ) {
    return {
      index,
      item,
      type,
      role,
      kind: "tool_call",
      callId,
      isSyntheticMemory: false,
      isOperationalContext: false,
      ref: `${type || "tool_call"}:${callId ?? index}`,
    };
  }

  if (type === "reasoning") {
    return {
      index,
      item,
      type,
      role,
      kind: "reasoning",
      isSyntheticMemory: false,
      isOperationalContext: false,
      ref: `reasoning:${index}`,
    };
  }

  return {
    index,
    item,
    type,
    role,
    kind: "other",
    callId,
    isSyntheticMemory: false,
    isOperationalContext: false,
    ref: `${type || "item"}:${index}`,
  };
}

export function isPandoResult(
  result: Pick<ToolResultEnvelope, "toolName" | "serverName" | "content">,
): boolean {
  const { baseName, serverName } = splitQualifiedToolName(result.toolName);
  if (
    result.toolName.startsWith("pando__") || serverName === "pando" || result.serverName === "pando"
  ) {
    return true;
  }
  return knownPandoToolNames.has(baseName);
}

export function splitQualifiedToolName(
  toolName: string,
): { serverName?: string; baseName: string } {
  const separator = toolName.indexOf("__");
  if (separator < 0) {
    return { baseName: toolName };
  }
  return {
    serverName: toolName.slice(0, separator),
    baseName: toolName.slice(separator + 2),
  };
}

export function normalizeToolContent(content: unknown): unknown {
  if (typeof content !== "string") {
    return content;
  }
  const trimmed = content.trim();
  if (!trimmed) {
    return content;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return content;
  }
}

export function summarizeToolContent(content: unknown, maxChars = 900): string {
  const normalized = normalizeToolContent(content);
  const text = typeof normalized === "string" ? normalized : compactJson(normalized, maxChars);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function isUserMessage(item: Record<string, unknown>): boolean {
  return String(item.type ?? "") === "message" && item.role === "user";
}

function isAssistantMessage(item: Record<string, unknown>): boolean {
  return String(item.type ?? "") === "message" && item.role === "assistant";
}

function isToolOutput(item: Record<string, unknown>): boolean {
  const type = String(item.type ?? "");
  return type === "function_call_output" ||
    type === "custom_tool_call_output" ||
    type === "mcp_tool_call_output" ||
    type.endsWith("_tool_call_output");
}

function extractMessageText(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (isRecord(part) && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  return parts.join("\n");
}

function isSyntheticMemoryText(text: string): boolean {
  return text.includes("<context_memory>") && text.includes("</context_memory>");
}

function isOperationalContextText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<environment_context>") &&
    trimmed.endsWith("</environment_context>");
}

function extractToolName(item: Record<string, unknown>): string | null {
  if (typeof item.server_label === "string" && typeof item.name === "string") {
    return `${item.server_label}__${item.name}`;
  }
  if (typeof item.name === "string") {
    return item.name;
  }
  if (typeof item.tool_name === "string") {
    return item.tool_name;
  }
  return null;
}

function extractToolContent(item: Record<string, unknown>): unknown {
  if ("output" in item) {
    return item.output;
  }
  if ("content" in item) {
    return item.content;
  }
  if ("result" in item) {
    return item.result;
  }
  return item;
}

function parseMaybeJsonObject(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseMaybeJson(value);
  return isRecord(parsed) ? parsed : undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function inputItemId(prefix: string, index: number, item: unknown): Promise<string> {
  const explicit = isRecord(item) && typeof item.id === "string" ? item.id : null;
  if (explicit) {
    return `${prefix}_${explicit}`;
  }
  return `${prefix}_${await shortHash(`${index}:${stableJson(item)}`)}`;
}

const knownPandoToolNames = new Set([
  "find_nodes",
  "find_references",
  "find_callers",
  "query_db",
  "analyze_imports",
  "list_exports",
  "list_snapshots",
  "workspace_overview",
  "get_db_schema",
  "get_enabled_languages",
  "get_project_root",
  "clojure_namespace_graph",
  "clojure_namespace_dependencies",
  "clojure_namespace_dependents",
  "insert",
  "replace",
  "replace_body",
  "delete",
  "rename",
  "change_signature",
  "filter_map_reduce",
  "restore_snapshot",
  "restore_files",
  "snapshot_worktree",
  "move_clojure_namespace",
  "rename_clojure_namespace",
]);
