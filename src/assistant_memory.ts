import { stableJson } from "./json.ts";
import { shortHash } from "./hash.ts";
import {
  MaintenanceExtraContextItem,
  parseInfoRequestResponse,
  resolveRequestedInfo,
} from "./maintenance_info.ts";
import { isRecord, MemoryChunk, MemoryState, unique } from "./memory_state.ts";
import { AssistantResponseExtraction } from "./tool_results.ts";

export type AssistantMemoryClient = (request: AssistantMemoryRequest) => Promise<unknown>;

export type AssistantMemoryRequest = {
  tasks: MemoryState["tasks"];
  activeTaskId: string | null;
  keptUserMessages: MemoryState["keptUserMessages"];
  infoRequestAttempt: boolean;
  extraContext: MaintenanceExtraContextItem[];
  responses: AssistantResponseExtraction[];
  validationErrors?: string[];
};

export type AssistantMemoryResponse = {
  chunks: Array<{
    sourceResponseIndex: number;
    title: string;
    summary: string;
    kind: string;
    taskIds: string[];
    pointer?: Record<string, unknown>;
  }>;
};

export async function chunkAssistantResponses(
  responses: AssistantResponseExtraction[],
  state: MemoryState,
  client: AssistantMemoryClient,
): Promise<MemoryChunk[]> {
  if (responses.length === 0 || state.tasks.length === 0) {
    return [];
  }

  const first = await safeAssistantMemoryCall(client, {
    tasks: state.tasks,
    activeTaskId: state.activeTaskId,
    keptUserMessages: state.keptUserMessages,
    infoRequestAttempt: false,
    extraContext: [],
    responses,
  });
  const infoRequest = parseInfoRequestResponse(first);
  if (infoRequest.needsMoreInfo) {
    const second = await safeAssistantMemoryCall(client, {
      tasks: state.tasks,
      activeTaskId: state.activeTaskId,
      keptUserMessages: state.keptUserMessages,
      infoRequestAttempt: true,
      extraContext: resolveRequestedInfo(infoRequest.requestedInfo, {
        tasks: state.tasks,
        keptUserMessages: state.keptUserMessages,
        memoryChunks: state.memoryLibrary,
        assistantResponses: responses,
      }),
      responses,
    });
    if (parseInfoRequestResponse(second).needsMoreInfo) {
      throw new Error(
        "Assistant memory model requested more info after its single allowed request",
      );
    }
    const secondParsed = validateAssistantMemoryResponse(second, responses, state);
    if (!secondParsed.ok) {
      throw new Error(`Assistant memory validation failed: ${secondParsed.errors.join("; ")}`);
    }
    return await materializeAssistantChunks(secondParsed.response, responses);
  }

  const parsed = validateAssistantMemoryResponse(first, responses, state);
  if (parsed.ok) {
    return await materializeAssistantChunks(parsed.response, responses);
  }

  const second = await safeAssistantMemoryCall(client, {
    tasks: state.tasks,
    activeTaskId: state.activeTaskId,
    keptUserMessages: state.keptUserMessages,
    infoRequestAttempt: false,
    extraContext: [],
    responses,
    validationErrors: parsed.errors,
  });
  if (parseInfoRequestResponse(second).needsMoreInfo) {
    throw new Error(
      "Assistant memory model requested more info instead of fixing validation errors",
    );
  }
  const reparsed = validateAssistantMemoryResponse(second, responses, state);
  if (reparsed.ok) {
    return await materializeAssistantChunks(reparsed.response, responses);
  }

  throw new Error(`Assistant memory validation failed: ${reparsed.errors.join("; ")}`);
}

export function validateAssistantMemoryResponse(
  value: unknown,
  responses: AssistantResponseExtraction[],
  state: MemoryState,
): { ok: true; response: AssistantMemoryResponse } | { ok: false; errors: string[] } {
  if (!isRecord(value) || !Array.isArray(value.chunks)) {
    return { ok: false, errors: ["Assistant memory response must have chunks array"] };
  }

  const live = new Set(state.tasks.map((task) => task.id));
  const chunks = value.chunks.filter(isRecord).map((chunk) => ({
    sourceResponseIndex: Number(chunk.sourceResponseIndex),
    title: String(chunk.title ?? ""),
    summary: String(chunk.summary ?? ""),
    kind: String(chunk.kind ?? "assistant"),
    taskIds: Array.isArray(chunk.taskIds) ? chunk.taskIds.map(String) : [],
    pointer: isRecord(chunk.pointer) ? chunk.pointer : undefined,
  }));

  const errors: string[] = [];
  for (const chunk of chunks) {
    if (
      !Number.isInteger(chunk.sourceResponseIndex) || chunk.sourceResponseIndex < 0 ||
      chunk.sourceResponseIndex >= responses.length
    ) {
      errors.push(`Invalid sourceResponseIndex: ${chunk.sourceResponseIndex}`);
    }
    if (!chunk.title.trim()) {
      errors.push("Assistant chunk title is required");
    }
    if (!chunk.summary.trim()) {
      errors.push("Assistant chunk summary is required");
    }
    if (chunk.taskIds.length === 0) {
      errors.push(`Assistant chunk ${chunk.title || "(untitled)"} requires taskIds`);
    }
    for (const taskId of chunk.taskIds) {
      if (!live.has(taskId)) {
        errors.push(`Assistant chunk references missing task ${taskId}`);
      }
    }
  }

  return errors.length === 0 ? { ok: true, response: { chunks } } : { ok: false, errors };
}

async function materializeAssistantChunks(
  response: AssistantMemoryResponse,
  responses: AssistantResponseExtraction[],
): Promise<MemoryChunk[]> {
  return await Promise.all(response.chunks.map(async (chunk, index) => {
    const source = responses[chunk.sourceResponseIndex];
    return {
      id: `chunk_${await shortHash(
        `${source.responseId}:${index}:${chunk.title}:${chunk.summary}`,
      )}`,
      title: chunk.title,
      summary: chunk.summary,
      kind: chunk.kind.startsWith("assistant/") ? chunk.kind : `assistant/${chunk.kind}`,
      taskIds: unique(chunk.taskIds),
      pointer: {
        sourceResponseId: source.responseId,
        ...chunk.pointer,
      },
      source: "assistant" as const,
    };
  }));
}

async function safeAssistantMemoryCall(
  client: AssistantMemoryClient,
  request: AssistantMemoryRequest,
): Promise<unknown> {
  return await client({
    ...request,
    responses: request.responses.map((response) => ({
      ...response,
      text: truncate(response.text, 14_000),
    })),
  });
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated ${stableJson({ originalLength: text.length })}]`;
}
