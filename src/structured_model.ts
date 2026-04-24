import {
  ProxyConfig,
  resolveUpstreamBaseUrl,
  responsesUrl,
} from "./config.ts";
import { extractJsonObject, stableJson } from "./json.ts";
import { extractUsageMetrics, type UsageMetrics } from "./metrics.ts";
import { ChunkSelector } from "./memory_state.ts";
import { WorkingMemoryUpdateRequest, WorkingMemoryUpdateResponse } from "./round_update.ts";

export type StructuredModelSelection = {
  classifier: "working_memory_update" | "source_chunk";
  requestModel: string | null;
  estimatedInputTokens: number;
  chosenModel: string;
  selectionReason: "fits_small_window" | "overflow_to_large";
};

export type StructuredModelUsage = {
  classifier: StructuredModelSelection["classifier"];
  requestModel: string | null;
  chosenModel: string;
  estimatedInputTokens: number;
  selectionReason: StructuredModelSelection["selectionReason"];
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type SourceChunkRequest = {
  sourceKind: "assistant" | "tool";
  toolName?: string;
  content: unknown;
  pointer?: Record<string, unknown>;
};

export type SourceChunkResponse = {
  chunks: ChunkSelector[];
};

export type StructuredClients = {
  workingMemoryUpdate: (request: WorkingMemoryUpdateRequest) => Promise<WorkingMemoryUpdateResponse>;
  sourceChunk: (request: SourceChunkRequest) => Promise<SourceChunkResponse>;
};

const OUTPUT_TOKEN_RESERVE = 4_096;
const APPROX_CHARS_PER_TOKEN = 4;

type JsonSchema = Record<string, unknown>;

type StructuredJsonCallResult<T> = {
  value: T;
  usage: UsageMetrics | null;
  selection: StructuredModelSelection;
};

export function createStructuredClients(
  config: ProxyConfig,
  requestModel: string | null,
  authHeader: string | null,
  onSelection?: (selection: StructuredModelSelection) => Promise<void> | void,
  onUsage?: (usage: StructuredModelUsage) => Promise<void> | void,
): StructuredClients {
  return {
    workingMemoryUpdate: async (request) => {
      const result = await callStructuredJson<WorkingMemoryUpdateResponse>(
        config,
        requestModel,
        authHeader,
        workingMemoryUpdateSystemPrompt,
        request,
        workingMemoryUpdateJsonSchema,
        "working_memory_update",
        onSelection,
      );
      await onUsage?.({
        classifier: result.selection.classifier,
        requestModel: result.selection.requestModel,
        chosenModel: result.selection.chosenModel,
        estimatedInputTokens: result.selection.estimatedInputTokens,
        selectionReason: result.selection.selectionReason,
        inputTokens: result.usage?.inputTokens,
        cachedInputTokens: result.usage?.cachedInputTokens,
        outputTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
      });
      return result.value;
    },
    sourceChunk: async (request) => {
      if (!canFitOverflowModel(config, sourceChunkSystemPrompt, request, sourceChunkJsonSchema)) {
        return { chunks: [{ kind: "whole" }] };
      }
      const result = await callStructuredJson<SourceChunkResponse>(
        config,
        requestModel,
        authHeader,
        sourceChunkSystemPrompt,
        request,
        sourceChunkJsonSchema,
        "source_chunk",
        onSelection,
      );
      await onUsage?.({
        classifier: result.selection.classifier,
        requestModel: result.selection.requestModel,
        chosenModel: result.selection.chosenModel,
        estimatedInputTokens: result.selection.estimatedInputTokens,
        selectionReason: result.selection.selectionReason,
        inputTokens: result.usage?.inputTokens,
        cachedInputTokens: result.usage?.cachedInputTokens,
        outputTokens: result.usage?.outputTokens,
        totalTokens: result.usage?.totalTokens,
      });
      return result.value;
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
): Promise<StructuredJsonCallResult<T>> {
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
  const usage = extractUsageMetricsFromStructuredResponse(response, bodyText);
  return {
    value: extractJsonObject(text) as T,
    usage,
    selection,
  };
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

function extractUsageMetricsFromStructuredResponse(response: Response, bodyText: string): UsageMetrics | null {
  if (isEventStream(response, bodyText)) {
    return extractUsageMetricsFromSseText(bodyText);
  }
  try {
    return extractUsageMetrics(JSON.parse(bodyText));
  } catch {
    return null;
  }
}

function extractUsageMetricsFromSseText(streamText: string): UsageMetrics | null {
  let usage: UsageMetrics | null = null;

  for (const line of streamText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (!data || data === "[DONE]") {
      continue;
    }
    try {
      const parsed = JSON.parse(data);
      usage = extractUsageMetrics(parsed) ?? extractUsageMetrics(
        parsed && typeof parsed === "object" && "response" in parsed
          ? (parsed as Record<string, unknown>).response
          : parsed,
      ) ?? usage;
    } catch {
      continue;
    }
  }

  return usage;
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

const chunkSelectorSchema = {
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

const workingMemoryUpdateJsonSchema = {
  type: "object",
  properties: {
    objectiveAfter: { anyOf: [{ type: "string" }, { type: "null" }] },
    keepOldChunkIds: { type: "array", items: { type: "string" } },
    keepNewChunkIds: { type: "array", items: { type: "string" } },
  },
  required: ["objectiveAfter", "keepOldChunkIds", "keepNewChunkIds"],
  additionalProperties: false,
};

const sourceChunkJsonSchema = {
  type: "object",
  properties: {
    chunks: { type: "array", items: chunkSelectorSchema },
  },
  required: ["chunks"],
  additionalProperties: false,
};

const workingMemoryUpdateSystemPrompt = `
You maintain one live objective and a minimal exact working-memory set.

Return JSON matching the supplied schema.

Rules:
- You are given the current objective, the currently kept exact chunks, and the exact new chunks from the latest completed round.
- objectiveAfter must be a compact description of the live work that still matters after this round, or null if the work is finished and no memory should remain.
- objectiveAfter may include compact literal anchors such as exact identifiers, key/value pairs, quoted phrases, or short command names when that improves exact later reconstruction.
- Keep objectiveAfter compact. Do not duplicate large blobs, long logs, or full tool outputs there when exact chunks can carry that evidence instead.
- Existing objective stays live by default. Do not clear it unless the user clearly ended, abandoned, or replaced that work.
- keepOldChunkIds must be the exact ids from the current kept set that should survive.
- keepNewChunkIds must be the exact ids from the new chunk set that should survive.
- Keep the working set minimal.
- Prefer dropping chunks unless there is a clear reason they will matter later.
- If many search results or exploratory outputs were observed and only one exact chunk mattered, keep only that one.
- Keep enough exact evidence so a future memory({chunkIds:[...]}) or memory({offset, limit}) fallback is unlikely to be needed.
- If the user clearly says exact values or content will be needed later, keep the exact supporting chunks.
- If an older exact chunk still supports the live objective, keep it unless it is clearly obsolete.
- Retained exact chunks can later be fetched again by chunk id, and pagination skips chunks already visible in prompt memory.
- Do not replace original tool or user evidence with an assistant restatement when the original exact chunk is still available.
- Do not keep user instruction text that only says to remember or recall something when the actual exact supporting chunk is already kept.
- Do not keep assistant acknowledgements, chatter, or confirmations when the underlying exact evidence is already kept.
- Prefer original tool outputs over user instructions and assistant restatements whenever both carry the same fact.
- In a tool-driven recall flow, the ideal retained set is usually just the original exact tool chunk and nothing else.
- If a retained exact chunk explicitly tells the model to call memory({chunkIds:[...]}) or memory({offset, limit}), and the user says that exact instruction will matter in a later turn, keep that instruction chunk together with the underlying exact evidence it is meant to retrieve.
- In that special case, keep both the visible instruction chunk and the hidden exact evidence chunk so fallback can actually be exercised later.
- If a user message is operational scaffolding such as "run this", "remember this", "reply exactly", or "without running any tool", drop it once the exact evidence it referred to is retained elsewhere.
- Never keep a plain user question or request phrasing as retained memory unless that user chunk itself carries a durable exact fact that is not preserved elsewhere.
- A user chunk carries a durable exact fact when it contains a literal token, identifier, quoted phrase, key/value pair, or other exact value that the user said must be recalled later. In that case keep the user chunk unless the exact same literal is stored verbatim in another kept chunk.
- "Remember this exact string: X", "Preserve token X", or similar instructions that introduce a new literal X count as durable: keep the chunk that contains X unless X is preserved elsewhere.
- If an assistant message only says "stored", "closed", repeats a value already present in a kept exact chunk, or wraps exact content in formatting, drop it.
- Keep user-message chunks only when they contain durable facts that are not preserved in a kept exact tool or assistant chunk.
- If the user clearly ends the work or says the memory is no longer needed, set objectiveAfter to null and keep no chunks.
- Do not summarize or rewrite content. Only decide the live objective and exact keep/drop ids.
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
