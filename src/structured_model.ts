import {
  ProxyConfig,
  resolveUpstreamBaseUrl,
  responsesUrl,
} from "./config.ts";
import { extractJsonObject, stableJson } from "./json.ts";
import { PieceSelector } from "./memory_state.ts";
import { RoundUpdateRequest, RoundUpdateResponse } from "./round_update.ts";

export type StructuredModelSelection = {
  classifier: "round_update" | "source_chunk";
  requestModel: string | null;
  estimatedInputTokens: number;
  chosenModel: string;
  selectionReason: "fits_small_window" | "overflow_to_large";
};

export type SourceChunkRequest = {
  sourceKind: "assistant" | "tool";
  toolName?: string;
  content: unknown;
  pointer?: Record<string, unknown>;
};

export type SourceChunkResponse = {
  chunks: PieceSelector[];
};

export type StructuredClients = {
  roundUpdate: (request: RoundUpdateRequest) => Promise<RoundUpdateResponse>;
  sourceChunk: (request: SourceChunkRequest) => Promise<SourceChunkResponse>;
};

const OUTPUT_TOKEN_RESERVE = 4_096;
const APPROX_CHARS_PER_TOKEN = 4;

type JsonSchema = Record<string, unknown>;

export function createStructuredClients(
  config: ProxyConfig,
  requestModel: string | null,
  authHeader: string | null,
  onSelection?: (selection: StructuredModelSelection) => Promise<void> | void,
): StructuredClients {
  return {
    roundUpdate: (request) =>
      callStructuredJson<RoundUpdateResponse>(
        config,
        requestModel,
        authHeader,
        roundUpdateSystemPrompt,
        request,
        roundUpdateJsonSchema,
        "round_update",
        onSelection,
      ),
    sourceChunk: async (request) => {
      if (!canFitOverflowModel(config, sourceChunkSystemPrompt, request, sourceChunkJsonSchema)) {
        return { chunks: [{ kind: "whole" }] };
      }
      return await callStructuredJson<SourceChunkResponse>(
        config,
        requestModel,
        authHeader,
        sourceChunkSystemPrompt,
        request,
        sourceChunkJsonSchema,
        "source_chunk",
        onSelection,
      );
    },
  };
}

export function canFitOverflowModel(
  config: ProxyConfig,
  system: string,
  payload: unknown,
  schema: JsonSchema,
): boolean {
  return estimateStructuredInputTokens(system, payload, schema) <=
    config.overflowStructuredContextWindow - OUTPUT_TOKEN_RESERVE;
}

export function estimateStructuredInputTokens(
  system: string,
  payload: unknown,
  schema: JsonSchema,
): number {
  return Math.ceil(
    (system.length + stableJson(payload).length + stableJson(schema).length) / APPROX_CHARS_PER_TOKEN,
  );
}

async function callStructuredJson<T>(
  config: ProxyConfig,
  requestModel: string | null,
  authHeader: string | null,
  system: string,
  payload: unknown,
  schema: JsonSchema,
  classifier: StructuredModelSelection["classifier"],
  onSelection?: (selection: StructuredModelSelection) => Promise<void> | void,
): Promise<T> {
  if (!authHeader) {
    throw new Error("No Authorization header or OPENAI_API_KEY available for structured model calls");
  }

  const selection = chooseStructuredModel(config, requestModel, system, payload, schema, classifier);
  await onSelection?.(selection);
  const url = responsesUrl(resolveUpstreamBaseUrl(config.upstreamBaseUrl, authHeader));
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "authorization": authHeader,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: selection.chosenModel,
      instructions: system,
      stream: true,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: classifier,
          strict: true,
          schema,
        },
      },
      input: [{
        role: "user",
        content: [{ type: "input_text", text: stableJson(payload) }],
      }],
    }),
    signal: AbortSignal.timeout(config.modelTimeoutMs),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Structured model call failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const bodyText = await response.text();
  const text = isEventStream(response, bodyText)
    ? extractResponseTextFromSseText(bodyText)
    : extractResponseText(JSON.parse(bodyText));
  if (!text) {
    throw new Error("Structured model response did not include text");
  }
  return extractJsonObject(text) as T;
}

function chooseStructuredModel(
  config: ProxyConfig,
  requestModel: string | null,
  system: string,
  payload: unknown,
  schema: JsonSchema,
  classifier: StructuredModelSelection["classifier"],
): StructuredModelSelection {
  const estimatedInputTokens = estimateStructuredInputTokens(system, payload, schema);
  if (estimatedInputTokens <= config.smallStructuredContextWindow - OUTPUT_TOKEN_RESERVE) {
    return {
      classifier,
      requestModel,
      estimatedInputTokens,
      chosenModel: config.smallStructuredModel,
      selectionReason: "fits_small_window",
    };
  }
  return {
    classifier,
    requestModel,
    estimatedInputTokens,
    chosenModel: config.overflowStructuredModel,
    selectionReason: "overflow_to_large",
  };
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

const pathPartSchema = {
  anyOf: [
    { type: "string" },
    { type: "number" },
  ],
};

const pieceSelectorSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["whole"] },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["line_range"] },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["kind", "startLine", "endLine"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["object_path"] },
        path: { type: "array", items: pathPartSchema },
      },
      required: ["kind", "path"],
      additionalProperties: false,
    },
  ],
};

const taskJsonSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    text: { type: "string" },
    status: { type: "string", enum: ["open", "in_progress"] },
    kind: { type: "string", enum: ["say", "do"] },
  },
  required: ["id", "text", "status", "kind"],
  additionalProperties: false,
};

const pieceSelectionJsonSchema = {
  anyOf: [
    {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["drop_all"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["keep_all"] },
      },
      required: ["mode"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["keep_only", "drop_only"] },
        ids: { type: "array", items: { type: "string" } },
      },
      required: ["mode", "ids"],
      additionalProperties: false,
    },
  ],
};

const roundUpdateJsonSchema = {
  type: "object",
  properties: {
    tasksAfter: { type: "array", items: taskJsonSchema },
    pieceSelection: pieceSelectionJsonSchema,
    keptPieceTaskLinks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          taskIds: { type: "array", items: { type: "string" } },
        },
        required: ["id", "taskIds"],
        additionalProperties: false,
      },
    },
  },
  required: ["tasksAfter", "pieceSelection", "keptPieceTaskLinks"],
  additionalProperties: false,
};

const sourceChunkJsonSchema = {
  type: "object",
  properties: {
    chunks: { type: "array", items: pieceSelectorSchema },
  },
  required: ["chunks"],
  additionalProperties: false,
};

const roundUpdateSystemPrompt = `
You update the live task list and explicitly decide which exact new content pieces should be kept.

Return JSON matching the supplied schema.

Rules:
- You are given the current live task list and the exact new content pieces from the latest completed round.
- tasksAfter must be the full ordered live task list after processing this new content.
- Reuse existing task ids whenever a task is still the same task. Avoid minting new ids unless the task is genuinely new.
- pieceSelection must be explicit. Always choose one of: drop_all, keep_all, keep_only, drop_only.
- keptPieceTaskLinks must contain exactly the kept pieces and no dropped pieces.
- Every kept piece must have at least one live task id.
- Drop pieces that do not materially help any live task.
- Do not summarize or rewrite content. Only decide task structure and piece/task links.
- Return JSON only.
`.trim();

const sourceChunkSystemPrompt = `
You split one exact assistant or tool payload into exact retained pieces.

Return JSON matching the supplied schema.

Rules:
- Do not summarize, paraphrase, or rewrite content.
- Only return exact selectors:
  - whole: keep the entire payload as one piece
  - line_range: for text payloads split by original 1-based line numbers
  - object_path: for JSON/array payloads point at an exact nested value using path segments
- Prefer a few meaningful exact pieces over many tiny fragments.
- If splitting would be lossy or ambiguous, use whole.
- Return JSON only.
`.trim();
