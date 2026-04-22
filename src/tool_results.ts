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

export async function extractInputs(
  body: Record<string, unknown>,
  state: MemoryState,
): Promise<ExtractedInputs> {
  const input = body.input;
  const items = Array.isArray(input) ? input : typeof input === "string" ? [input] : [];
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

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (typeof item === "string") {
      userMessages.push({
        messageId: `user_${await shortHash(`string:${index}:${item}`)}`,
        text: item,
      });
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }

    if (isUserMessage(item)) {
      const text = extractMessageText(item);
      if (text.trim().length > 0 && !isSyntheticMemoryText(text)) {
        userMessages.push({
          messageId: await itemId("user", index, item),
          text,
        });
      }
      continue;
    }

    if (isAssistantMessage(item)) {
      const text = extractMessageText(item);
      if (text.trim().length > 0) {
        assistantResponses.push({
          responseId: await itemId("assistant", index, item),
          text,
        });
      }
      continue;
    }

    if (isToolOutput(item)) {
      const callId = typeof item.call_id === "string"
        ? item.call_id
        : typeof item.id === "string"
        ? item.id
        : "";
      const call = callId ? callsById.get(callId) : undefined;
      const toolName = extractToolName(item) ?? call?.toolName ?? `unknown_tool_${callId || index}`;
      const { serverName } = splitQualifiedToolName(toolName);
      toolResults.push({
        id: await itemId("tool", index, item),
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

async function itemId(prefix: string, index: number, item: unknown): Promise<string> {
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
