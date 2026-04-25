import { ProxyConfig, resolveUpstreamBaseUrl, responsesUrl } from "./config.ts";
import {
  type GroupIntentRequest,
  type GroupIntentResponse,
  type PieceRetentionBatchRequest,
  type PieceRetentionBatchResponse,
  type RetainedPiecePruneRequest,
  type RetainedPiecePruneResponse,
  type SourceChunkBatchRequest,
  type SourceChunkBatchResponse,
} from "./group_manager.ts";
import { extractJsonObject, stableJson } from "./json.ts";
import { extractUsageMetrics, type UsageMetrics } from "./metrics.ts";
import { type ChunkSelector } from "./memory_state.ts";

export type StructuredModelSelection = {
  classifier:
    | "group_intent"
    | "source_chunk_batch"
    | "piece_retention_batch"
    | "retained_piece_prune";
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

export type StructuredClients = {
  groupIntent: (request: GroupIntentRequest) => Promise<GroupIntentResponse>;
  sourceChunkBatch: (request: SourceChunkBatchRequest) => Promise<SourceChunkBatchResponse>;
  pieceRetentionBatch: (
    request: PieceRetentionBatchRequest,
  ) => Promise<PieceRetentionBatchResponse>;
  retainedPiecePrune: (
    request: RetainedPiecePruneRequest,
  ) => Promise<RetainedPiecePruneResponse>;
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
    groupIntent: async (request) => {
      const result = await callStructuredJson<GroupIntentResponse>(
        config,
        requestModel,
        authHeader,
        groupIntentSystemPrompt,
        request,
        groupIntentJsonSchema,
        "group_intent",
        onSelection,
      );
      await emitUsage(result, onUsage);
      return result.value;
    },
    sourceChunkBatch: async (request) => {
      if (
        !canFitOverflowModel(
          config,
          sourceChunkBatchSystemPrompt,
          request,
          sourceChunkBatchJsonSchema,
        )
      ) {
        return {
          results: request.sources.map((source) => ({
            sourceId: source.sourceId,
            selectors: [{ kind: "whole" } satisfies ChunkSelector],
          })),
        };
      }
      const result = await callStructuredJson<SourceChunkBatchResponse>(
        config,
        requestModel,
        authHeader,
        sourceChunkBatchSystemPrompt,
        request,
        sourceChunkBatchJsonSchema,
        "source_chunk_batch",
        onSelection,
      );
      await emitUsage(result, onUsage);
      return normalizeSourceChunkBatchResponse(request, result.value);
    },
    pieceRetentionBatch: async (request) => {
      const schema = pieceRetentionBatchJsonSchema(request);
      const result = await callStructuredJson<PieceRetentionBatchResponse>(
        config,
        requestModel,
        authHeader,
        pieceRetentionBatchSystemPrompt,
        request,
        schema,
        "piece_retention_batch",
        onSelection,
      );
      await emitUsage(result, onUsage);
      return normalizePieceRetentionBatchResponse(request, result.value);
    },
    retainedPiecePrune: async (request) => {
      const result = await callStructuredJson<RetainedPiecePruneResponse>(
        config,
        requestModel,
        authHeader,
        retainedPiecePruneSystemPrompt,
        request,
        retainedPiecePruneJsonSchema,
        "retained_piece_prune",
        onSelection,
      );
      await emitUsage(result, onUsage);
      return result.value;
    },
  };
}

async function emitUsage<T>(
  result: StructuredJsonCallResult<T>,
  onUsage?: (usage: StructuredModelUsage) => Promise<void> | void,
): Promise<void> {
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
    (system.length + stableJson(payload).length + stableJson(schema).length) /
      APPROX_CHARS_PER_TOKEN,
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
    throw new Error(
      "No Authorization header or OPENAI_API_KEY available for structured model calls",
    );
  }

  const selection = chooseStructuredModel(
    config,
    requestModel,
    system,
    payload,
    schema,
    classifier,
  );
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

function extractUsageMetricsFromStructuredResponse(
  response: Response,
  bodyText: string,
): UsageMetrics | null {
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

const groupSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { type: "string", enum: ["active", "closed"] },
    routingLabel: { type: "string" },
    summary: { type: "string" },
    lastTouchedSeq: { type: "integer", minimum: 0 },
  },
  required: ["id", "status", "routingLabel", "summary", "lastTouchedSeq"],
  additionalProperties: false,
};

const groupIntentJsonSchema = {
  type: "object",
  properties: {
    groupsAfter: { type: "array", items: groupSchema },
    closedGroupIds: { type: "array", items: { type: "string" } },
    replacedGroupIds: { type: "array", items: { type: "string" } },
  },
  required: ["groupsAfter", "closedGroupIds", "replacedGroupIds"],
  additionalProperties: false,
};

const sourceChunkBatchJsonSchema = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceId: { type: "string" },
          selectors: { type: "array", items: chunkSelectorSchema },
        },
        required: ["sourceId", "selectors"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
};

function pieceRetentionBatchJsonSchema(request: PieceRetentionBatchRequest): JsonSchema {
  const decisionSchema = {
    type: "object",
    properties: {
      keep: { type: "boolean" },
      groupId: {
        anyOf: [
          { type: "string" },
          { type: "null" },
        ],
      },
      supersedesPieceIds: { type: "array", items: { type: "string" } },
    },
    required: ["keep", "groupId", "supersedesPieceIds"],
    additionalProperties: false,
  };

  return {
    type: "object",
    properties: {
      decisionsByPieceId: {
        type: "object",
        properties: Object.fromEntries(
          request.newPieces.map((piece) => [piece.id, decisionSchema]),
        ),
        required: request.newPieces.map((piece) => piece.id),
        additionalProperties: false,
      },
    },
    required: ["decisionsByPieceId"],
    additionalProperties: false,
  };
}

const retainedPiecePruneJsonSchema = {
  type: "object",
  properties: {
    dropPieceIds: { type: "array", items: { type: "string" } },
  },
  required: ["dropPieceIds"],
  additionalProperties: false,
};

const groupIntentSystemPrompt = `
You maintain durable active memory groups for a coding session.

Return JSON matching the supplied schema.

Rules:
- You are given the current groups, retained exact anchor previews for those groups, and the new user pieces from the latest round.
- groupsAfter must be the full post-round group list.
- Keep groupsAfter small and concrete.
- Continue a group when the user is still working on the same thing.
- If the user is asking a follow-up question about facts, tokens, notes, or markers already established in the same ongoing thread, continue the existing group instead of replacing it.
- Preserve active groups by default when their retained anchor facts may still matter later, even if the current round also asks for new inspection work.
- Do not discard an active group just because the user asks another repo-inspection question in the same broader thread.
- Replace or close obsolete groups when the user moves on.
- closedGroupIds and replacedGroupIds retire prior groups and those ids must not appear in groupsAfter.
- routingLabel should be short and operational.
- summary should say what exact evidence matters in that group.
- Do not invent vague meta-groups.
- Return JSON only.
`.trim();

const sourceChunkBatchSystemPrompt = `
You split user, assistant, and tool payloads into exact retained pieces.

Return JSON matching the supplied schema.

Rules:
- Process all listed sources together.
- Do not summarize, paraphrase, or rewrite content.
- Return exact selectors only:
  - whole
  - line_range using original 1-based lines
  - object_path for exact JSON paths
- Prefer a few meaningful exact pieces over many tiny fragments.
- If splitting would be lossy or ambiguous, use whole.
- Return JSON only.
`.trim();

const pieceRetentionBatchSystemPrompt = `
You decide which exact new pieces should be retained in durable memory groups.

Return JSON matching the supplied schema.

Rules:
- You are given post-round groups, retained anchor pieces, and all new exact pieces.
- Return a decision for every new piece id under decisionsByPieceId.
- Keep only exact pieces that materially matter later.
- Prefer original user literals and original tool results over assistant restatements.
- groupId must be an active group when keep=true.
- When keep=false, set groupId to null and supersedesPieceIds to [].
- supersedesPieceIds should only list older retained pieces made obsolete by the new piece.
- Return JSON only.
`.trim();

function normalizePieceRetentionBatchResponse(
  request: PieceRetentionBatchRequest,
  value: unknown,
): PieceRetentionBatchResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { decisions: [] };
  }
  const record = value as Record<string, unknown>;
  const decisionsByPieceId = (
    record.decisionsByPieceId &&
      typeof record.decisionsByPieceId === "object" &&
      !Array.isArray(record.decisionsByPieceId)
  )
    ? record.decisionsByPieceId as Record<string, unknown>
    : {};

  return {
    decisions: request.newPieces.map((piece) => {
      const rawDecision = decisionsByPieceId[piece.id];
      const decision = rawDecision && typeof rawDecision === "object" && !Array.isArray(rawDecision)
        ? rawDecision as Record<string, unknown>
        : {};
      return {
        pieceId: piece.id,
        keep: decision.keep === true,
        groupId: typeof decision.groupId === "string" ? decision.groupId : null,
        supersedesPieceIds: Array.isArray(decision.supersedesPieceIds)
          ? decision.supersedesPieceIds.map(String)
          : [],
      };
    }),
  };
}

const retainedPiecePruneSystemPrompt = `
You prune previously kept old exact pieces that are no longer worth sending next round.

Return JSON matching the supplied schema.

Rules:
- You are given the current groups, surviving old pieces, and newly kept pieces.
- dropPieceIds must be a subset of retainedOldPieces ids.
- Drop only old pieces that are clearly obsolete now.
- If unsure, keep the old piece.
- Return JSON only.
`.trim();

function normalizeSourceChunkBatchResponse(
  request: SourceChunkBatchRequest,
  value: unknown,
): SourceChunkBatchResponse {
  if (!value || typeof value !== "object") {
    return defaultSourceChunkBatchResponse(request);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.results)) {
    return defaultSourceChunkBatchResponse(request);
  }
  const requestedIds = new Set(request.sources.map((source) => source.sourceId));
  const byId = new Map<string, ChunkSelector[]>();
  for (const entry of record.results) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const sourceId = typeof item.sourceId === "string" ? item.sourceId : "";
    if (!sourceId || !requestedIds.has(sourceId)) {
      continue;
    }
    const selectors = Array.isArray(item.selectors)
      ? item.selectors
        .map(coerceChunkSelector)
        .filter((selector: ChunkSelector | null): selector is ChunkSelector => Boolean(selector))
      : [];
    byId.set(sourceId, selectors.length > 0 ? selectors : [{ kind: "whole" }]);
  }
  return {
    results: request.sources.map((source) => ({
      sourceId: source.sourceId,
      selectors: byId.get(source.sourceId) ?? [{ kind: "whole" }],
    })),
  };
}

function defaultSourceChunkBatchResponse(
  request: SourceChunkBatchRequest,
): SourceChunkBatchResponse {
  return {
    results: request.sources.map((source) => ({
      sourceId: source.sourceId,
      selectors: [{ kind: "whole" }],
    })),
  };
}

function coerceChunkSelector(value: unknown): ChunkSelector | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "whole") {
    return { kind: "whole" };
  }
  if (
    record.kind === "line_range" &&
    typeof record.startLine === "number" &&
    typeof record.endLine === "number"
  ) {
    return { kind: "line_range", startLine: record.startLine, endLine: record.endLine };
  }
  if (record.kind === "object_path" && Array.isArray(record.path)) {
    return {
      kind: "object_path",
      path: record.path.filter((part): part is string | number =>
        typeof part === "string" || typeof part === "number"
      ),
    };
  }
  return null;
}
