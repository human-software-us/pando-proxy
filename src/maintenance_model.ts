import { ProxyConfig, resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import { extractJsonObject, stableJson } from "./json.ts";
import { BatchChunkRequest } from "./chunking.ts";
import { RetentionModelRequest } from "./retention.ts";
import { TaskUpdateModelRequest } from "./task_update.ts";

export type MaintenanceClients = {
  taskUpdate: (request: TaskUpdateModelRequest) => Promise<unknown>;
  chunkBatch: (request: BatchChunkRequest) => Promise<unknown>;
  retention: (request: RetentionModelRequest) => Promise<unknown>;
};

export function createMaintenanceClients(
  config: ProxyConfig,
  requestModel: string | null,
  authHeader: string | null,
): MaintenanceClients {
  const model = config.maintenanceModel ?? requestModel;
  const call = (system: string, payload: unknown) =>
    callMaintenanceJson(config, model, authHeader, system, payload);

  return {
    taskUpdate: (request) => call(taskUpdateSystemPrompt, request),
    chunkBatch: (request) => call(chunkBatchSystemPrompt, sanitizeChunkRequest(request)),
    retention: (request) => call(retentionSystemPrompt, request),
  };
}

async function callMaintenanceJson(
  config: ProxyConfig,
  model: string | null,
  authHeader: string | null,
  system: string,
  payload: unknown,
): Promise<unknown> {
  if (!model) {
    throw new Error("No model available for maintenance calls");
  }
  if (!authHeader) {
    throw new Error("No Authorization header or OPENAI_API_KEY available for maintenance calls");
  }

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
      input: [
        {
          role: "user",
          content: [{ type: "input_text", text: stableJson(payload) }],
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
      content: truncateUnknown(result.content, 14_000),
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
Return strict JSON only, matching this shape:
{
  "taskUpdateSeq": number,
  "latestUserMessageId": string,
  "result": "changed" | "same_as_before",
  "tasksAfter": [{"id": string, "text": string, "status": "open" | "in_progress", "kind": "say" | "do"}],
  "activeTaskId": string | null,
  "existingTaskActions": [{"id": string, "action": "keep" | "drop" | "complete" | "merge_into", "mergeInto"?: string}],
  "userMessageActions": [{"messageId": string, "action": "keep" | "drop", "taskIds"?: string[], "summary"?: string}]
}
Rules:
- taskUpdateSeq must be previousSeq + 1.
- latestUserMessageId must equal the latest user message id.
- Every previous task must appear exactly once in existingTaskActions.
- Every previously kept user message and the latest user message must appear in userMessageActions.
- tasksAfter is the full ordered live task list after this update.
- Kept messages need a short summary and at least one live task id.
- If validationErrors are provided, fix them. Return JSON only.
`.trim();

const chunkBatchSystemPrompt = `
You chunk arbitrary tool results for task-scoped context memory.
Return strict JSON only:
{
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
- Every useful chunk must support one or more live tasks.
- Use activeTaskId when a result clearly belongs to the active task.
- Keep summaries short and factual.
- Prefer pointers over copying long raw output.
- Drop irrelevant results by producing no chunk for them.
- If validationErrors are provided, fix them. Return JSON only.
`.trim();

const retentionSystemPrompt = `
You decide eager retention for task-scoped context memory.
Return strict JSON only:
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
