import { isRecord, MemoryChunk, Task, UserMessageMemory } from "./memory_state.ts";
import { AssistantResponseExtraction, ToolResultEnvelope } from "./tool_results.ts";

export type MaintenanceInfoRequest = {
  type:
    | "live_tasks"
    | "kept_user_messages"
    | "all_memory_chunks"
    | "memory_chunk"
    | "assistant_chunks"
    | "tool_chunks"
    | "all_tool_results"
    | "tool_result"
    | "all_assistant_responses"
    | "assistant_response";
  id: string | null;
  reason: string;
};

export type MaintenanceExtraContextItem = {
  type: MaintenanceInfoRequest["type"];
  id: string | null;
  data: unknown;
};

export type MaintenanceInfoSources = {
  tasks?: Task[];
  keptUserMessages?: UserMessageMemory[];
  memoryChunks?: MemoryChunk[];
  toolResults?: ToolResultEnvelope[];
  assistantResponses?: AssistantResponseExtraction[];
};

export function parseInfoRequestResponse(
  value: unknown,
): { needsMoreInfo: false } | { needsMoreInfo: true; requestedInfo: MaintenanceInfoRequest[] } {
  if (!isRecord(value) || value.needsMoreInfo !== true) {
    return { needsMoreInfo: false };
  }
  const requestedInfo = coerceInfoRequests(value.requestedInfo);
  if (requestedInfo.length === 0) {
    throw new Error("Maintenance model requested more info without requestedInfo entries");
  }
  return { needsMoreInfo: true, requestedInfo };
}

export function resolveRequestedInfo(
  requestedInfo: MaintenanceInfoRequest[],
  sources: MaintenanceInfoSources,
): MaintenanceExtraContextItem[] {
  return requestedInfo.map((request) => resolveOne(request, sources));
}

function coerceInfoRequests(value: unknown): MaintenanceInfoRequest[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).flatMap((item) => {
    const type = coerceInfoType(item.type);
    if (!type) {
      return [];
    }
    return [{
      type,
      id: typeof item.id === "string" && item.id.length > 0 ? item.id : null,
      reason: String(item.reason ?? ""),
    }];
  });
}

function coerceInfoType(value: unknown): MaintenanceInfoRequest["type"] | null {
  return value === "live_tasks" ||
      value === "kept_user_messages" ||
      value === "all_memory_chunks" ||
      value === "memory_chunk" ||
      value === "assistant_chunks" ||
      value === "tool_chunks" ||
      value === "all_tool_results" ||
      value === "tool_result" ||
      value === "all_assistant_responses" ||
      value === "assistant_response"
    ? value
    : null;
}

function resolveOne(
  request: MaintenanceInfoRequest,
  sources: MaintenanceInfoSources,
): MaintenanceExtraContextItem {
  switch (request.type) {
    case "live_tasks":
      return { type: request.type, id: null, data: sources.tasks ?? [] };
    case "kept_user_messages":
      return { type: request.type, id: null, data: sources.keptUserMessages ?? [] };
    case "all_memory_chunks":
      return { type: request.type, id: null, data: sources.memoryChunks ?? [] };
    case "assistant_chunks":
      return {
        type: request.type,
        id: null,
        data: (sources.memoryChunks ?? []).filter((chunk) => chunk.source === "assistant"),
      };
    case "tool_chunks":
      return {
        type: request.type,
        id: null,
        data: (sources.memoryChunks ?? []).filter((chunk) => chunk.source === "tool"),
      };
    case "memory_chunk":
      return {
        type: request.type,
        id: requireId(request),
        data: findById(sources.memoryChunks ?? [], requireId(request), "memory chunk"),
      };
    case "all_tool_results":
      return { type: request.type, id: null, data: sources.toolResults ?? [] };
    case "tool_result":
      return {
        type: request.type,
        id: requireId(request),
        data: findById(sources.toolResults ?? [], requireId(request), "tool result"),
      };
    case "all_assistant_responses":
      return { type: request.type, id: null, data: sources.assistantResponses ?? [] };
    case "assistant_response":
      return {
        type: request.type,
        id: requireId(request),
        data: findAssistantResponse(
          sources.assistantResponses ?? [],
          requireId(request),
        ),
      };
  }
}

function requireId(request: MaintenanceInfoRequest): string {
  if (!request.id) {
    throw new Error(`Maintenance info request ${request.type} requires id`);
  }
  return request.id;
}

function findById<T extends { id: string }>(items: T[], id: string, label: string): T {
  const found = items.find((item) => item.id === id);
  if (!found) {
    throw new Error(`Requested ${label} not available: ${id}`);
  }
  return found;
}

function findAssistantResponse(
  responses: AssistantResponseExtraction[],
  id: string,
): AssistantResponseExtraction {
  const found = responses.find((response) => response.responseId === id);
  if (!found) {
    throw new Error(`Requested assistant response not available: ${id}`);
  }
  return found;
}
