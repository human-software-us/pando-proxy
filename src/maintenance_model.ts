import { AssistantMemoryRequest } from "./assistant_memory.ts";
import { ProxyConfig, resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import { extractJsonObject, stableJson } from "./json.ts";
import { BatchChunkRequest } from "./chunking.ts";
import { RetentionModelRequest } from "./retention.ts";
import { TaskUpdateModelRequest } from "./task_update.ts";
import { normalizeToolContent } from "./tool_results.ts";

export type MaintenanceClients = {
  taskUpdate: (request: TaskUpdateModelRequest) => Promise<unknown>;
  assistantMemory: (request: AssistantMemoryRequest) => Promise<unknown>;
  chunkBatch: (request: BatchChunkRequest) => Promise<unknown>;
  retention: (request: RetentionModelRequest) => Promise<unknown>;
};

type JsonSchema = Record<string, unknown>;

export const DEFAULT_SMALL_MAINTENANCE_MODEL = "gpt-5.4-mini";
export const DEFAULT_LARGE_MAINTENANCE_MODEL = "gpt-5.4";
export const MAINTENANCE_MODEL_CONTEXT_WINDOWS = {
  [DEFAULT_SMALL_MAINTENANCE_MODEL]: 272_000,
  [DEFAULT_LARGE_MAINTENANCE_MODEL]: 1_000_000,
} as const;
export const MAINTENANCE_MODEL_ALIASES = {
  small: DEFAULT_SMALL_MAINTENANCE_MODEL,
  large: DEFAULT_LARGE_MAINTENANCE_MODEL,
  [DEFAULT_SMALL_MAINTENANCE_MODEL]: DEFAULT_SMALL_MAINTENANCE_MODEL,
  [DEFAULT_LARGE_MAINTENANCE_MODEL]: DEFAULT_LARGE_MAINTENANCE_MODEL,
} as const;

const MAINTENANCE_OUTPUT_TOKEN_RESERVE = 4_096;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHUNK_RESULT_CONTENT_CHARS = 80_000;

export function createMaintenanceClients(
  config: ProxyConfig,
  requestModel: string | null,
  authHeader: string | null,
): MaintenanceClients {
  const call = (system: string, payload: unknown, schema: JsonSchema, name: string) =>
    callMaintenanceJson(config, requestModel, authHeader, system, payload, schema, name);

  return {
    taskUpdate: (request) =>
      call(taskUpdateSystemPrompt, request, taskUpdateJsonSchema, "task_update"),
    assistantMemory: (request) =>
      call(
        assistantMemorySystemPrompt,
        request,
        assistantMemoryJsonSchema,
        "assistant_memory",
      ),
    chunkBatch: (request) =>
      call(
        chunkBatchSystemPrompt,
        sanitizeChunkRequest(request),
        chunkBatchJsonSchema,
        "chunk_batch",
      ),
    retention: (request) =>
      call(retentionSystemPrompt, request, retentionJsonSchema, "retention_decision"),
  };
}

async function callMaintenanceJson(
  config: ProxyConfig,
  requestModel: string | null,
  authHeader: string | null,
  system: string,
  payload: unknown,
  schema: JsonSchema,
  schemaName: string,
): Promise<unknown> {
  if (!authHeader) {
    throw new Error("No Authorization header or OPENAI_API_KEY available for maintenance calls");
  }

  const payloadText = stableJson(payload);
  const model = selectMaintenanceModel({
    configuredModel: config.maintenanceModel,
    requestModel,
    system,
    payloadText,
    schema,
  });
  const upstreamBaseUrl = resolveUpstreamBaseUrl(config.upstreamBaseUrl, authHeader);
  const response = await fetch(responsesUrl(upstreamBaseUrl), {
    method: "POST",
    headers: {
      "authorization": authHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: system,
      stream: true,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: payloadText }],
        },
      ],
    }),
    signal: AbortSignal.timeout(config.maintenanceTimeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Maintenance model call failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const responseText = await response.text();
  const text = isEventStream(response, responseText)
    ? extractResponseTextFromSseText(responseText)
    : extractResponseText(JSON.parse(responseText));
  if (!text) {
    throw new Error("Maintenance model response did not include text");
  }
  return extractJsonObject(text);
}

export function selectMaintenanceModel(options: {
  configuredModel: string | null;
  requestModel: string | null;
  system: string;
  payloadText: string;
  schema: JsonSchema;
}): string {
  if (options.configuredModel) {
    return normalizeMaintenanceModel(options.configuredModel);
  }

  const estimatedInputTokens = estimateMaintenanceInputTokens(
    options.system,
    options.payloadText,
    options.schema,
  );
  const smallLimit = MAINTENANCE_MODEL_CONTEXT_WINDOWS[DEFAULT_SMALL_MAINTENANCE_MODEL] -
    MAINTENANCE_OUTPUT_TOKEN_RESERVE;
  if (estimatedInputTokens <= smallLimit) {
    return DEFAULT_SMALL_MAINTENANCE_MODEL;
  }

  // Keep this as a fixed two-model policy for now. These are the smallest Codex-supported model
  // and the large-context model in the current GPT-5.4 family from the bundled/local catalog.
  return DEFAULT_LARGE_MAINTENANCE_MODEL;
}

export function normalizeMaintenanceModel(value: string): string {
  const normalized = value.trim().toLowerCase();
  const model = MAINTENANCE_MODEL_ALIASES[
    normalized as keyof typeof MAINTENANCE_MODEL_ALIASES
  ];
  if (!model) {
    throw new Error(
      `Unsupported maintenance model "${value}". Allowed values: small, large, ${DEFAULT_SMALL_MAINTENANCE_MODEL}, ${DEFAULT_LARGE_MAINTENANCE_MODEL}`,
    );
  }
  return model;
}

export function estimateMaintenanceInputTokens(
  system: string,
  payloadText: string,
  schema: JsonSchema,
): number {
  return Math.ceil(
    (system.length + payloadText.length + stableJson(schema).length) / APPROX_CHARS_PER_TOKEN,
  );
}

function isEventStream(response: Response, body: string): boolean {
  const contentTypeIsEventStream =
    response.headers.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
  return contentTypeIsEventStream ||
    body.startsWith("event:") ||
    body.startsWith("data:") ||
    body.includes("\ndata:");
}

function extractResponseTextFromSseText(streamText: string): string {
  const deltas: string[] = [];
  let completedText = "";

  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    const finalText = extractResponseTextFromEvent(parsed);
    if (finalText) {
      completedText = finalText;
    }
    const delta = extractTextDelta(parsed);
    if (delta) {
      deltas.push(delta);
    }
  }

  return completedText || deltas.join("");
}

function extractResponseTextFromEvent(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  return extractResponseText(record.response ?? value);
}

function extractTextDelta(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.delta === "string") {
    return record.delta;
  }
  if (typeof record.text === "string" && String(record.type ?? "").endsWith(".delta")) {
    return record.text;
  }
  return "";
}

function sanitizeChunkRequest(request: BatchChunkRequest): BatchChunkRequest {
  return {
    ...request,
    results: request.results.map((result) => ({
      ...result,
      content: truncateUnknown(
        normalizeToolContent(result.content),
        MAX_CHUNK_RESULT_CONTENT_CHARS,
      ),
    })),
  };
}

function truncateUnknown(value: unknown, maxChars: number): unknown {
  const text = typeof value === "string" ? value : stableJson(value);
  return text.length <= maxChars ? value : `${text.slice(0, maxChars)}... [truncated]`;
}

function extractResponseText(value: unknown): string {
  if (
    value && typeof value === "object" &&
    typeof (value as Record<string, unknown>).output_text === "string"
  ) {
    return String((value as Record<string, unknown>).output_text);
  }
  const output = value && typeof value === "object"
    ? (value as Record<string, unknown>).output
    : undefined;
  if (!Array.isArray(output)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        parts.push(String((part as Record<string, unknown>).text));
      }
    }
  }
  return parts.join("\n");
}

const taskUpdateSystemPrompt = `
You update a task-only context-memory state for a local proxy.
Return JSON matching the supplied schema:
{
  "needsMoreInfo": boolean,
  "requestedInfo": [{"type": string, "id": string | null, "reason": string}],
  "taskUpdateSeq": number,
  "latestUserMessageId": string,
  "result": "changed" | "same_as_before",
  "tasksAfter": [{"id": string, "text": string, "status": "open" | "in_progress", "kind": "say" | "do"}],
  "activeTaskId": string | null,
  "existingTaskActions": [{"id": string, "action": "keep" | "drop" | "complete" | "merge_into", "mergeInto"?: string}],
  "userMessageActions": [{"messageId": string, "action": "keep" | "drop", "taskIds"?: string[], "summary"?: string}]
}
Rules:
- The first request is intentionally minimal: latest user message, live tasks, retained
  user-message summaries, and any extraContext already requested.
- If infoRequestAttempt is false and you need more data to update tasks correctly, set
  needsMoreInfo true and fill requestedInfo. You get only one request for more data; err on the
  side of requesting more rather than less.
- If infoRequestAttempt is true, needsMoreInfo must be false and you must return the final task
  update from the provided data.
- Supported requestedInfo types are live_tasks, kept_user_messages, all_memory_chunks,
  memory_chunk, assistant_chunks, and tool_chunks. Use id only for memory_chunk.
- When needsMoreInfo is false, requestedInfo must be [].
- taskUpdateSeq must be previousSeq + 1.
- latestUserMessageId must equal the latest user message id.
- Every previous task must appear exactly once in existingTaskActions.
- Every previously kept user message and the latest user message must appear in userMessageActions.
- tasksAfter is the full ordered live task list after this update.
- Kept messages need a short summary and at least one live task id.
- If validationErrors are provided, fix them. Return JSON only.
`.trim();

export const chunkBatchSystemPrompt = `
You chunk arbitrary non-Pando tool results for task-scoped context memory. These chunks are the
units later retention can keep or drop before the next agent turn, so chunk boundaries matter.
Return JSON matching the supplied schema:
{
  "needsMoreInfo": boolean,
  "requestedInfo": [{"type": string, "id": string | null, "reason": string}],
  "chunks": [
    {
      "sourceResultIndex": number,
      "title": string,
      "summary": string,
      "kind": string,
      "taskIds": string[],
      "pointer"?: object
    }
  ]
}
Rules:
- The payload includes live tasks, activeTaskId, compact keptUserMessages, and raw-ish tool results
  with tool names/params. Use that context to decide what is useful and which taskIds apply.
- If infoRequestAttempt is false and you need more data to chunk correctly, set needsMoreInfo true
  and fill requestedInfo. You get only one request for more data; err on the side of requesting
  more rather than less.
- If infoRequestAttempt is true, needsMoreInfo must be false and you must return final chunks from
  the provided data.
- Supported requestedInfo types are live_tasks, kept_user_messages, all_memory_chunks,
  memory_chunk, assistant_chunks, tool_chunks, all_tool_results, and tool_result. Use id for
  memory_chunk or tool_result.
- When needsMoreInfo is false, requestedInfo must be [].
- Every emitted chunk must support one or more live tasks. Use activeTaskId when a result clearly
  belongs to the active task.
- Choose semantic retention units, not mechanical summaries. Split arrays, search results, lists,
  tables, match sets, grouped errors, and other structured collections into one chunk per useful
  item or small related group when those items may be independently kept or dropped.
- For search/list outputs, prefer small chunks per result with rank/index and locator details in
  the title, summary, or pointer. It is better to create more small chunks than one broad chunk when
  later retention may keep only 1-3 items.
- Use one larger chunk only when the output is a single coherent artifact, a short command result,
  or splitting would remove important context.
- Keep summaries short, factual, and specific enough to identify the retained fact without rereading
  the whole raw result.
- Prefer pointer locators over copying long raw output. Use pointer null when no locator helps. When
  a locator helps, fill only the applicable pointer fields such as itemIndex, rowIndex, key, path,
  url, lineStart, lineEnd, locator, or note, and leave unknown pointer fields null.
- Drop irrelevant results by producing no chunk for them.
- If validationErrors are provided, fix them. Return JSON only.
`.trim();

const assistantMemorySystemPrompt = `
You review prior assistant responses for task-scoped context memory.
Return JSON matching the supplied schema:
{
  "needsMoreInfo": boolean,
  "requestedInfo": [{"type": string, "id": string | null, "reason": string}],
  "chunks": [
    {
      "sourceResponseIndex": number,
      "title": string,
      "summary": string,
      "kind": string,
      "taskIds": string[],
      "pointer"?: object
    }
  ]
}
Rules:
- This runs on the next inbound request, after user-message task updates. It reviews assistant
  responses from prior turns that have not already been handled.
- The payload includes live tasks, activeTaskId, compact keptUserMessages, assistant response
  previews/text, and any extraContext already requested.
- If infoRequestAttempt is false and you need more data to decide what assistant information is
  durable, set needsMoreInfo true and fill requestedInfo. You get only one request for more data;
  err on the side of requesting more rather than less.
- If infoRequestAttempt is true, needsMoreInfo must be false and you must return final chunks from
  the provided data.
- Supported requestedInfo types are live_tasks, kept_user_messages, all_memory_chunks,
  memory_chunk, assistant_chunks, tool_chunks, all_assistant_responses, and assistant_response. Use
  id for memory_chunk or assistant_response.
- When needsMoreInfo is false, requestedInfo must be [].
- Include only durable information from assistant responses that can help one or more live tasks.
- Useful durable information includes decisions made, constraints discovered, implementation facts,
  test results, unresolved errors, or explicit next steps that still matter.
- Do not keep generic progress narration, apologies, pleasantries, repeated user instructions, or
  assistant text for completed/dropped/irrelevant tasks.
- Every useful chunk must support one or more live tasks.
- Keep summaries short, factual, and grounded in the assistant response.
- Drop irrelevant responses by producing no chunk for them.
- If validationErrors are provided, fix them. Return JSON only.
`.trim();

const retentionSystemPrompt = `
You decide eager retention for task-scoped context memory.
Return JSON matching the supplied schema:
{
  "keep": [{"id": string, "taskIds": string[]}],
  "drop": [string]
}
Rules:
- Every candidate id must appear exactly once, either in keep or drop.
- Kept chunks must support one or more live tasks.
- Do not keep chunks for completed, dropped, missing, or irrelevant tasks.
- Prefer dropping stale context. Keep only what can help with live tasks.
- If validationErrors are provided, fix them. Return JSON only.
`.trim();

const stringSchema = { type: "string" };
const stringArraySchema = { type: "array", items: stringSchema };
const nullableStringSchema = { type: ["string", "null"] };
const emptyPointerSchema = {
  type: ["object", "null"],
  properties: {},
  required: [],
  additionalProperties: false,
};

const infoRequestJsonSchema = {
  type: "object",
  properties: {
    type: {
      type: "string",
      enum: [
        "live_tasks",
        "kept_user_messages",
        "all_memory_chunks",
        "memory_chunk",
        "assistant_chunks",
        "tool_chunks",
        "all_tool_results",
        "tool_result",
        "all_assistant_responses",
        "assistant_response",
      ],
    },
    id: nullableStringSchema,
    reason: stringSchema,
  },
  required: ["type", "id", "reason"],
  additionalProperties: false,
};

const infoRequestArraySchema = {
  type: "array",
  items: infoRequestJsonSchema,
};

const chunkPointerSchema = {
  type: ["object", "null"],
  properties: {
    itemIndex: { type: ["number", "null"] },
    rowIndex: { type: ["number", "null"] },
    key: nullableStringSchema,
    path: nullableStringSchema,
    url: nullableStringSchema,
    lineStart: { type: ["number", "null"] },
    lineEnd: { type: ["number", "null"] },
    locator: nullableStringSchema,
    note: nullableStringSchema,
  },
  required: [
    "itemIndex",
    "rowIndex",
    "key",
    "path",
    "url",
    "lineStart",
    "lineEnd",
    "locator",
    "note",
  ],
  additionalProperties: false,
};

const taskJsonSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    text: stringSchema,
    status: { type: "string", enum: ["open", "in_progress"] },
    kind: { type: "string", enum: ["say", "do"] },
  },
  required: ["id", "text", "status", "kind"],
  additionalProperties: false,
};

const taskUpdateJsonSchema = {
  type: "object",
  properties: {
    needsMoreInfo: { type: "boolean" },
    requestedInfo: infoRequestArraySchema,
    taskUpdateSeq: { type: "number" },
    latestUserMessageId: stringSchema,
    result: { type: "string", enum: ["changed", "same_as_before"] },
    tasksAfter: { type: "array", items: taskJsonSchema },
    activeTaskId: nullableStringSchema,
    existingTaskActions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: stringSchema,
          action: { type: "string", enum: ["keep", "drop", "complete", "merge_into"] },
          mergeInto: nullableStringSchema,
        },
        required: ["id", "action", "mergeInto"],
        additionalProperties: false,
      },
    },
    userMessageActions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          messageId: stringSchema,
          action: { type: "string", enum: ["keep", "drop"] },
          taskIds: stringArraySchema,
          summary: nullableStringSchema,
        },
        required: ["messageId", "action", "taskIds", "summary"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "needsMoreInfo",
    "requestedInfo",
    "taskUpdateSeq",
    "latestUserMessageId",
    "result",
    "tasksAfter",
    "activeTaskId",
    "existingTaskActions",
    "userMessageActions",
  ],
  additionalProperties: false,
};

const chunkJsonSchema = {
  type: "object",
  properties: {
    sourceResultIndex: { type: "number" },
    title: stringSchema,
    summary: stringSchema,
    kind: stringSchema,
    taskIds: stringArraySchema,
    pointer: chunkPointerSchema,
  },
  required: ["sourceResultIndex", "title", "summary", "kind", "taskIds", "pointer"],
  additionalProperties: false,
};

const assistantChunkJsonSchema = {
  type: "object",
  properties: {
    sourceResponseIndex: { type: "number" },
    title: stringSchema,
    summary: stringSchema,
    kind: stringSchema,
    taskIds: stringArraySchema,
    pointer: emptyPointerSchema,
  },
  required: ["sourceResponseIndex", "title", "summary", "kind", "taskIds", "pointer"],
  additionalProperties: false,
};

const chunkBatchJsonSchema = {
  type: "object",
  properties: {
    needsMoreInfo: { type: "boolean" },
    requestedInfo: infoRequestArraySchema,
    chunks: { type: "array", items: chunkJsonSchema },
  },
  required: ["needsMoreInfo", "requestedInfo", "chunks"],
  additionalProperties: false,
};

const assistantMemoryJsonSchema = {
  type: "object",
  properties: {
    needsMoreInfo: { type: "boolean" },
    requestedInfo: infoRequestArraySchema,
    chunks: { type: "array", items: assistantChunkJsonSchema },
  },
  required: ["needsMoreInfo", "requestedInfo", "chunks"],
  additionalProperties: false,
};

const retentionJsonSchema = {
  type: "object",
  properties: {
    keep: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: stringSchema,
          taskIds: stringArraySchema,
        },
        required: ["id", "taskIds"],
        additionalProperties: false,
      },
    },
    drop: stringArraySchema,
  },
  required: ["keep", "drop"],
  additionalProperties: false,
};
