import { chunkAssistantResponses } from "./assistant_memory.ts";
import { chunkToolResults } from "./chunking.ts";
import { createMaintenanceClients } from "./maintenance_model.ts";
import { ProxyLogger } from "./logger.ts";
import { isRecord, MemoryChunk, MemoryState, SessionRecord } from "./memory_state.ts";
import { ProxyConfig } from "./config.ts";
import { retainMemory } from "./retention.ts";
import { onNewUserMessage } from "./task_update.ts";
import { AssistantResponseExtraction, extractInputs, ToolResultEnvelope } from "./tool_results.ts";

export type MaintenanceResult = {
  record: SessionRecord;
  changed: boolean;
};

export type MaintenanceLogContext = {
  logger?: ProxyLogger;
  sessionKey?: string;
};

export async function runMaintenancePass(
  body: Record<string, unknown>,
  record: SessionRecord,
  config: ProxyConfig,
  authHeader: string | null,
  requestModel: string | null,
  logContext: MaintenanceLogContext = {},
): Promise<MaintenanceResult> {
  const handled = new Set(record.handledInputIds);
  let state: MemoryState = record.memory;
  let changed = false;
  await logMemory(logContext, "pass_start", {
    requestModel,
    beforeState: summarizeState(state),
    handledInputIds: [...handled],
  });

  const extracted = await extractInputs(body, state);
  await logMemory(logContext, "inputs_extracted", {
    userMessageIds: extracted.userMessages.map((message) => message.messageId),
    assistantResponseIds: extracted.assistantResponses.map((response) => response.responseId),
    toolResults: extracted.toolResults.map(summarizeToolResult),
  });

  const clients = instrumentMaintenanceClients(
    createMaintenanceClients(config, requestModel, authHeader),
    logContext,
  );

  for (const message of extracted.userMessages) {
    if (handled.has(message.messageId)) {
      await logMemory(logContext, "user_message_skipped", { messageId: message.messageId });
      continue;
    }
    const before = state;
    await logMemory(logContext, "task_update_start", {
      messageId: message.messageId,
      beforeState: summarizeState(before),
    });
    state = await onNewUserMessage(message, state, clients.taskUpdate);
    await logMemory(logContext, "task_update_applied", {
      messageId: message.messageId,
      taskIdDiff: diffIds(before.tasks.map((task) => task.id), state.tasks.map((task) => task.id)),
      keptUserMessageIdDiff: diffIds(
        before.keptUserMessages.map((item) => item.messageId),
        state.keptUserMessages.map((item) => item.messageId),
      ),
      memoryChunkIdDiff: diffIds(
        before.memoryLibrary.map((chunk) => chunk.id),
        state.memoryLibrary.map((chunk) => chunk.id),
      ),
      afterState: summarizeState(state),
    });
    handled.add(message.messageId);
    changed = true;
  }

  const newAssistantResponses = extracted.assistantResponses.filter((response) =>
    !handled.has(response.responseId)
  );
  if (newAssistantResponses.length > 0) {
    await logMemory(logContext, "assistant_responses_start", {
      assistantResponses: newAssistantResponses.map(summarizeAssistantResponse),
      beforeState: summarizeState(state),
    });
    const inbox = await chunkAssistantResponses(
      newAssistantResponses,
      state,
      clients.assistantMemory,
    );
    await logMemory(logContext, "assistant_chunks_created", {
      chunkIds: inbox.map((chunk) => chunk.id),
      chunks: inbox.map(summarizeChunk),
    });
    const candidateIds = uniqueIds([
      ...state.memoryLibrary.map((chunk) => chunk.id),
      ...inbox.map((chunk) => chunk.id),
    ]);
    await logMemory(logContext, "assistant_retention_start", {
      existingChunkIds: state.memoryLibrary.map((chunk) => chunk.id),
      inboxChunkIds: inbox.map((chunk) => chunk.id),
      candidateChunkIds: candidateIds,
    });
    state = await retainMemory(state, inbox, clients.retention);
    await logMemory(logContext, "assistant_retention_applied", {
      keptChunkIds: state.memoryLibrary.map((chunk) => chunk.id),
      droppedChunkIds: candidateIds.filter((id) =>
        !state.memoryLibrary.some((chunk) => chunk.id === id)
      ),
      afterState: summarizeState(state),
    });
    for (const response of newAssistantResponses) {
      handled.add(response.responseId);
    }
    changed = true;
  } else {
    await logMemory(logContext, "assistant_responses_none", {
      extractedAssistantResponseIds: extracted.assistantResponses.map((response) =>
        response.responseId
      ),
      handledInputIds: [...handled],
    });
  }

  const newToolResults = extracted.toolResults.filter((result) => !handled.has(result.id));
  if (newToolResults.length > 0) {
    await logMemory(logContext, "tool_results_start", {
      toolResults: newToolResults.map(summarizeToolResult),
      beforeState: summarizeState(state),
    });
    const inbox = await chunkToolResults(newToolResults, state, clients.chunkBatch);
    await logMemory(logContext, "chunks_created", {
      chunkIds: inbox.map((chunk) => chunk.id),
      chunks: inbox.map(summarizeChunk),
    });
    const candidateIds = uniqueIds([
      ...state.memoryLibrary.map((chunk) => chunk.id),
      ...inbox.map((chunk) => chunk.id),
    ]);
    await logMemory(logContext, "retention_start", {
      existingChunkIds: state.memoryLibrary.map((chunk) => chunk.id),
      inboxChunkIds: inbox.map((chunk) => chunk.id),
      candidateChunkIds: candidateIds,
    });
    state = await retainMemory(state, inbox, clients.retention);
    await logMemory(logContext, "retention_applied", {
      keptChunkIds: state.memoryLibrary.map((chunk) => chunk.id),
      droppedChunkIds: candidateIds.filter((id) =>
        !state.memoryLibrary.some((chunk) => chunk.id === id)
      ),
      afterState: summarizeState(state),
    });
    for (const result of newToolResults) {
      handled.add(result.id);
    }
    changed = true;
  } else {
    await logMemory(logContext, "tool_results_none", {
      extractedToolResultIds: extracted.toolResults.map((result) => result.id),
      handledInputIds: [...handled],
    });
  }

  await logMemory(logContext, "pass_end", {
    changed,
    afterState: summarizeState(state),
    handledInputIds: [...handled],
  });

  return {
    record: {
      memory: state,
      handledInputIds: [...handled],
    },
    changed,
  };
}

function instrumentMaintenanceClients(
  clients: ReturnType<typeof createMaintenanceClients>,
  logContext: MaintenanceLogContext,
): ReturnType<typeof createMaintenanceClients> {
  return {
    taskUpdate: async (request) => {
      await logMemory(logContext, "task_update_model_request", {
        previousSeq: request.previousSeq,
        latestUserMessageId: request.latestUserMessage.messageId,
        taskIds: request.tasks.map((task) => task.id),
        keptUserMessageIds: request.keptUserMessages.map((message) => message.messageId),
        infoRequestAttempt: request.infoRequestAttempt,
        extraContext: request.extraContext.map(summarizeExtraContext),
        validationErrors: request.validationErrors,
      });
      try {
        const response = await clients.taskUpdate(request);
        await logMemory(
          logContext,
          "task_update_model_response",
          summarizeTaskUpdateResponse(
            response,
          ),
        );
        return response;
      } catch (error) {
        await logMemory(logContext, "task_update_model_error", { message: messageFor(error) });
        throw error;
      }
    },
    assistantMemory: async (request) => {
      await logMemory(logContext, "assistant_memory_model_request", {
        taskIds: request.tasks.map((task) => task.id),
        activeTaskId: request.activeTaskId,
        keptUserMessageIds: request.keptUserMessages.map((message) => message.messageId),
        infoRequestAttempt: request.infoRequestAttempt,
        extraContext: request.extraContext.map(summarizeExtraContext),
        responseIds: request.responses.map((response) => response.responseId),
        assistantResponses: request.responses.map(summarizeAssistantResponse),
        validationErrors: request.validationErrors,
      });
      try {
        const response = await clients.assistantMemory(request);
        await logMemory(
          logContext,
          "assistant_memory_model_response",
          summarizeAssistantMemoryResponse(response),
        );
        return response;
      } catch (error) {
        await logMemory(logContext, "assistant_memory_model_error", { message: messageFor(error) });
        throw error;
      }
    },
    chunkBatch: async (request) => {
      await logMemory(logContext, "chunk_batch_model_request", {
        taskIds: request.tasks.map((task) => task.id),
        activeTaskId: request.activeTaskId,
        keptUserMessageIds: request.keptUserMessages.map((message) => message.messageId),
        infoRequestAttempt: request.infoRequestAttempt,
        extraContext: request.extraContext.map(summarizeExtraContext),
        resultIds: request.results.map((result) => result.id),
        results: request.results.map(summarizeToolResult),
        validationErrors: request.validationErrors,
      });
      try {
        const response = await clients.chunkBatch(request);
        await logMemory(
          logContext,
          "chunk_batch_model_response",
          summarizeChunkBatchResponse(
            response,
          ),
        );
        return response;
      } catch (error) {
        await logMemory(logContext, "chunk_batch_model_error", { message: messageFor(error) });
        throw error;
      }
    },
    retention: async (request) => {
      await logMemory(logContext, "retention_model_request", {
        taskIds: request.tasks.map((task) => task.id),
        activeTaskId: request.activeTaskId,
        candidateChunkIds: request.candidates.map((chunk) => chunk.id),
        candidates: request.candidates.map(summarizeChunk),
        validationErrors: request.validationErrors,
      });
      try {
        const response = await clients.retention(request);
        await logMemory(
          logContext,
          "retention_model_response",
          summarizeRetentionResponse(response),
        );
        return response;
      } catch (error) {
        await logMemory(logContext, "retention_model_error", { message: messageFor(error) });
        throw error;
      }
    },
  };
}

async function logMemory(
  context: MaintenanceLogContext,
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await context.logger?.log(`memory_${event}`, {
    sessionKey: context.sessionKey,
    ...fields,
  });
}

function summarizeState(state: MemoryState): Record<string, unknown> {
  return {
    taskUpdateSeq: state.taskUpdateSeq,
    taskIds: state.tasks.map((task) => task.id),
    tasks: state.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      kind: task.kind,
      active: task.id === state.activeTaskId,
    })),
    activeTaskId: state.activeTaskId,
    keptUserMessageIds: state.keptUserMessages.map((message) => message.messageId),
    keptUserMessages: state.keptUserMessages.map((message) => ({
      messageId: message.messageId,
      taskIds: message.taskIds,
    })),
    memoryChunkIds: state.memoryLibrary.map((chunk) => chunk.id),
    memoryChunks: state.memoryLibrary.map(summarizeChunk),
  };
}

function summarizeToolResult(result: ToolResultEnvelope): Record<string, unknown> {
  return {
    id: result.id,
    origin: result.origin,
    toolName: result.toolName,
    serverName: result.serverName,
    activeTaskId: result.activeTaskId,
    paramKeys: result.params ? Object.keys(result.params).sort() : [],
    contentShape: shapeOf(result.content),
  };
}

function summarizeAssistantResponse(
  response: AssistantResponseExtraction,
): Record<string, unknown> {
  return {
    responseId: response.responseId,
    textLength: response.text.length,
  };
}

function summarizeChunk(chunk: MemoryChunk): Record<string, unknown> {
  const pointer = isRecord(chunk.pointer) ? chunk.pointer : {};
  return {
    id: chunk.id,
    kind: chunk.kind,
    source: chunk.source,
    taskIds: chunk.taskIds,
    sourceResultId: typeof pointer.sourceResultId === "string" ? pointer.sourceResultId : undefined,
    sourceResponseId: typeof pointer.sourceResponseId === "string"
      ? pointer.sourceResponseId
      : undefined,
    toolName: typeof pointer.toolName === "string" ? pointer.toolName : undefined,
    itemIndex: typeof pointer.itemIndex === "number" ? pointer.itemIndex : undefined,
    changedPathCount: Array.isArray(pointer.changedPaths) ? pointer.changedPaths.length : undefined,
    pointerKeys: Object.keys(pointer).sort(),
  };
}

function summarizeExtraContext(item: Record<string, unknown>): Record<string, unknown> {
  return {
    type: item.type,
    id: item.id,
    dataShape: shapeOf(item.data),
  };
}

function summarizeTaskUpdateResponse(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) {
    return { shape: shapeOf(response) };
  }
  return {
    taskUpdateSeq: response.taskUpdateSeq,
    latestUserMessageId: response.latestUserMessageId,
    result: response.result,
    activeTaskId: response.activeTaskId,
    tasksAfter: Array.isArray(response.tasksAfter)
      ? response.tasksAfter.filter(isRecord).map((task) => ({
        id: task.id,
        status: task.status,
        kind: task.kind,
      }))
      : [],
    existingTaskActions: Array.isArray(response.existingTaskActions)
      ? response.existingTaskActions.filter(isRecord).map((action) => ({
        id: action.id,
        action: action.action,
        mergeInto: action.mergeInto,
      }))
      : [],
    userMessageActions: Array.isArray(response.userMessageActions)
      ? response.userMessageActions.filter(isRecord).map((action) => ({
        messageId: action.messageId,
        action: action.action,
        taskIds: action.taskIds,
        hasSummary: typeof action.summary === "string" && action.summary.length > 0,
      }))
      : [],
  };
}

function summarizeAssistantMemoryResponse(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || !Array.isArray(response.chunks)) {
    return { shape: shapeOf(response) };
  }
  return {
    chunks: response.chunks.filter(isRecord).map((chunk) => ({
      sourceResponseIndex: chunk.sourceResponseIndex,
      kind: chunk.kind,
      taskIds: chunk.taskIds,
      hasPointer: isRecord(chunk.pointer),
      pointerKeys: isRecord(chunk.pointer) ? Object.keys(chunk.pointer).sort() : [],
    })),
  };
}

function summarizeChunkBatchResponse(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || !Array.isArray(response.chunks)) {
    return { shape: shapeOf(response) };
  }
  return {
    chunks: response.chunks.filter(isRecord).map((chunk) => ({
      sourceResultIndex: chunk.sourceResultIndex,
      kind: chunk.kind,
      taskIds: chunk.taskIds,
      hasPointer: isRecord(chunk.pointer),
      pointerKeys: isRecord(chunk.pointer) ? Object.keys(chunk.pointer).sort() : [],
    })),
  };
}

function summarizeRetentionResponse(response: unknown): Record<string, unknown> {
  if (!isRecord(response)) {
    return { shape: shapeOf(response) };
  }
  return {
    keep: Array.isArray(response.keep)
      ? response.keep.filter(isRecord).map((item) => ({
        id: item.id,
        taskIds: item.taskIds,
      }))
      : [],
    drop: Array.isArray(response.drop) ? response.drop : [],
  };
}

function shapeOf(value: unknown): Record<string, unknown> | string {
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (isRecord(value)) {
    return { type: "object", keys: Object.keys(value).sort() };
  }
  return typeof value;
}

function diffIds(before: string[], after: string[]): Record<string, string[]> {
  return {
    added: after.filter((id) => !before.includes(id)),
    removed: before.filter((id) => !after.includes(id)),
    kept: after.filter((id) => before.includes(id)),
  };
}

function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
