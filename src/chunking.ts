import { compactJson, stableJson } from "./json.ts";
import { shortHash } from "./hash.ts";
import {
  MaintenanceExtraContextItem,
  parseInfoRequestResponse,
  resolveRequestedInfo,
} from "./maintenance_info.ts";
import { isRecord, MemoryChunk, MemoryState, unique } from "./memory_state.ts";
import {
  isPandoResult,
  normalizeToolContent,
  splitQualifiedToolName,
  summarizeToolContent,
  ToolResultEnvelope,
} from "./tool_results.ts";

export type BatchChunkClient = (request: BatchChunkRequest) => Promise<unknown>;

export type BatchChunkRequest = {
  tasks: MemoryState["tasks"];
  activeTaskId: string | null;
  keptUserMessages: MemoryState["keptUserMessages"];
  infoRequestAttempt: boolean;
  extraContext: MaintenanceExtraContextItem[];
  results: ToolResultEnvelope[];
  validationErrors?: string[];
};

export type BatchChunkResponse = {
  chunks: Array<{
    sourceResultIndex: number;
    title: string;
    summary: string;
    kind: string;
    taskIds: string[];
    pointer?: Record<string, unknown>;
  }>;
};

export async function chunkToolResults(
  results: ToolResultEnvelope[],
  state: MemoryState,
  client: BatchChunkClient,
): Promise<MemoryChunk[]> {
  const pando: ToolResultEnvelope[] = [];
  const nonPando: ToolResultEnvelope[] = [];
  for (const result of results) {
    if (isPandoResult(result)) {
      pando.push(result);
    } else {
      nonPando.push(result);
    }
  }

  const pandoChunks = await Promise.all(pando.map((result) => chunkPandoInCode(result, state)));
  const nonPandoChunks = await chunkNonPandoInBatches(nonPando, state, client);
  return [...pandoChunks.flat(), ...nonPandoChunks];
}

export async function chunkPandoInCode(
  result: ToolResultEnvelope,
  state: MemoryState,
): Promise<MemoryChunk[]> {
  const { baseName } = splitQualifiedToolName(result.toolName);
  const content = normalizeToolContent(result.content);
  const defaultTaskIds = defaultChunkTaskIds(state);

  if (baseName === "find_nodes") {
    return createItemChunks(
      result,
      "pando/find_nodes",
      getArrayByKeys(content, ["nodes", "matches", "results", "items"]),
      defaultTaskIds,
    );
  }
  if (baseName === "find_references") {
    return createItemChunks(
      result,
      "pando/find_references",
      getArrayByKeys(content, ["references", "results", "items"]),
      defaultTaskIds,
    );
  }
  if (baseName === "find_callers") {
    return createItemChunks(
      result,
      "pando/find_callers",
      getArrayByKeys(content, ["callers", "results", "items"]),
      defaultTaskIds,
    );
  }

  if (isAnalysisStylePandoTool(baseName)) {
    const rows = getArrayByKeys(content, [
      "rows",
      "results",
      "items",
      "namespaces",
      "edges",
      "exports",
    ]);
    if (rows.length > 0) {
      return createItemChunks(result, `pando/${baseName}`, rows, defaultTaskIds);
    }
    return [await pointerChunk(result, `pando/${baseName}`, content, defaultTaskIds)];
  }

  return [await mutationSummaryChunk(result, baseName, content, defaultTaskIds)];
}

export async function chunkNonPandoInBatches(
  results: ToolResultEnvelope[],
  state: MemoryState,
  client: BatchChunkClient,
): Promise<MemoryChunk[]> {
  if (results.length === 0) {
    return [];
  }

  const batches = splitBatches(results, 80_000);
  const chunks: MemoryChunk[] = [];
  let resultOffset = 0;

  for (const batch of batches) {
    const first = await safeChunkBatch(client, {
      tasks: state.tasks,
      activeTaskId: state.activeTaskId,
      keptUserMessages: state.keptUserMessages,
      infoRequestAttempt: false,
      extraContext: [],
      results: batch,
    });
    const infoRequest = parseInfoRequestResponse(first);
    if (infoRequest.needsMoreInfo) {
      const second = await safeChunkBatch(client, {
        tasks: state.tasks,
        activeTaskId: state.activeTaskId,
        keptUserMessages: state.keptUserMessages,
        infoRequestAttempt: true,
        extraContext: resolveRequestedInfo(infoRequest.requestedInfo, {
          tasks: state.tasks,
          keptUserMessages: state.keptUserMessages,
          memoryChunks: state.memoryLibrary,
          toolResults: batch,
        }),
        results: batch,
      });
      if (parseInfoRequestResponse(second).needsMoreInfo) {
        throw new Error("Chunking model requested more info after its single allowed request");
      }
      const secondParsed = validateBatchChunkResponse(second, batch, state);
      if (!secondParsed.ok) {
        throw new Error(`Chunking validation failed: ${secondParsed.errors.join("; ")}`);
      }
      chunks.push(...await materializeBatchChunks(secondParsed.response, batch, resultOffset));
      resultOffset += batch.length;
      continue;
    }

    const parsed = validateBatchChunkResponse(first, batch, state);
    if (parsed.ok) {
      chunks.push(...await materializeBatchChunks(parsed.response, batch, resultOffset));
    } else {
      const second = await safeChunkBatch(client, {
        tasks: state.tasks,
        activeTaskId: state.activeTaskId,
        keptUserMessages: state.keptUserMessages,
        infoRequestAttempt: false,
        extraContext: [],
        results: batch,
        validationErrors: parsed.errors,
      });
      if (parseInfoRequestResponse(second).needsMoreInfo) {
        throw new Error("Chunking model requested more info instead of fixing validation errors");
      }
      const reparsed = validateBatchChunkResponse(second, batch, state);
      if (reparsed.ok) {
        chunks.push(...await materializeBatchChunks(reparsed.response, batch, resultOffset));
      } else {
        throw new Error(`Chunking validation failed: ${reparsed.errors.join("; ")}`);
      }
    }
    resultOffset += batch.length;
  }

  return chunks;
}

export function validateBatchChunkResponse(
  value: unknown,
  results: ToolResultEnvelope[],
  state: MemoryState,
): { ok: true; response: BatchChunkResponse } | { ok: false; errors: string[] } {
  if (!isRecord(value) || !Array.isArray(value.chunks)) {
    return { ok: false, errors: ["Batch chunk response must have chunks array"] };
  }

  const live = new Set(state.tasks.map((task) => task.id));
  const chunks = value.chunks.filter(isRecord).map((chunk) => ({
    sourceResultIndex: Number(chunk.sourceResultIndex),
    title: String(chunk.title ?? ""),
    summary: String(chunk.summary ?? ""),
    kind: String(chunk.kind ?? "tool"),
    taskIds: Array.isArray(chunk.taskIds) ? chunk.taskIds.map(String) : [],
    pointer: isRecord(chunk.pointer) ? chunk.pointer : undefined,
  }));

  const errors: string[] = [];
  for (const chunk of chunks) {
    if (
      !Number.isInteger(chunk.sourceResultIndex) || chunk.sourceResultIndex < 0 ||
      chunk.sourceResultIndex >= results.length
    ) {
      errors.push(`Invalid sourceResultIndex: ${chunk.sourceResultIndex}`);
    }
    if (!chunk.title.trim()) {
      errors.push("Chunk title is required");
    }
    if (!chunk.summary.trim()) {
      errors.push("Chunk summary is required");
    }
    if (chunk.taskIds.length === 0) {
      errors.push(`Chunk ${chunk.title || "(untitled)"} requires taskIds`);
    }
    for (const taskId of chunk.taskIds) {
      if (!live.has(taskId)) {
        errors.push(`Chunk references missing task ${taskId}`);
      }
    }
  }

  return errors.length === 0 ? { ok: true, response: { chunks } } : { ok: false, errors };
}

function isAnalysisStylePandoTool(baseName: string): boolean {
  return baseName.startsWith("find_") ||
    baseName.startsWith("list_") ||
    baseName.startsWith("analyze_") ||
    baseName.startsWith("get_") ||
    baseName === "workspace_overview" ||
    baseName === "query_db" ||
    baseName.includes("namespace");
}

async function createItemChunks(
  result: ToolResultEnvelope,
  kind: string,
  items: unknown[],
  taskIds: string[],
): Promise<MemoryChunk[]> {
  if (items.length === 0) {
    return [await pointerChunk(result, kind, normalizeToolContent(result.content), taskIds)];
  }

  return Promise.all(items.map(async (item, index) => {
    const title = itemTitle(item, result.toolName, index);
    return {
      id: `chunk_${await shortHash(`${result.id}:${index}:${stableJson(item)}`)}`,
      title,
      summary: itemSummary(item),
      kind,
      taskIds,
      pointer: {
        sourceResultId: result.id,
        toolName: result.toolName,
        itemIndex: index,
        ...extractPointer(item),
      },
      source: "tool" as const,
    };
  }));
}

async function pointerChunk(
  result: ToolResultEnvelope,
  kind: string,
  content: unknown,
  taskIds: string[],
): Promise<MemoryChunk> {
  return {
    id: `chunk_${await shortHash(`${result.id}:pointer:${stableJson(content)}`)}`,
    title: `${result.toolName} result`,
    summary: summarizeToolContent(content, 700),
    kind,
    taskIds,
    pointer: {
      sourceResultId: result.id,
      toolName: result.toolName,
      params: result.params,
      pagination: extractPagination(content),
    },
    source: "tool",
  };
}

async function mutationSummaryChunk(
  result: ToolResultEnvelope,
  baseName: string,
  content: unknown,
  taskIds: string[],
): Promise<MemoryChunk> {
  const changedPaths = extractChangedPaths(content);
  return {
    id: `chunk_${await shortHash(`${result.id}:mutation:${stableJson(content)}`)}`,
    title: `Pando ${baseName} operation`,
    summary: changedPaths.length > 0
      ? `${baseName} changed ${changedPaths.slice(0, 12).join(", ")}`
      : summarizeToolContent(content, 700),
    kind: `pando/${baseName}/mutation`,
    taskIds,
    pointer: {
      sourceResultId: result.id,
      toolName: result.toolName,
      changedPaths,
    },
    source: "tool",
  };
}

function getArrayByKeys(content: unknown, keys: string[]): unknown[] {
  if (Array.isArray(content)) {
    return content;
  }
  if (!isRecord(content)) {
    return [];
  }
  for (const key of keys) {
    const value = content[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  if (isRecord(content.data)) {
    return getArrayByKeys(content.data, keys);
  }
  return [];
}

function itemTitle(item: unknown, toolName: string, index: number): string {
  if (!isRecord(item)) {
    return `${toolName} item ${index + 1}`;
  }
  const name = item.name ?? item.symbol ?? item.path ?? item.file ?? item.namespace ?? item.id;
  return typeof name === "string" && name.trim()
    ? `${toolName}: ${name}`
    : `${toolName} item ${index + 1}`;
}

function itemSummary(item: unknown): string {
  if (!isRecord(item)) {
    return summarizeToolContent(item, 700);
  }
  const parts: string[] = [];
  for (const key of ["name", "path", "file", "line", "kind", "symbolKind", "summary", "text"]) {
    const value = item[key];
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}: ${value}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : compactJson(item, 700);
}

function extractPointer(item: unknown): Record<string, unknown> {
  if (!isRecord(item)) {
    return {};
  }
  const pointer: Record<string, unknown> = {};
  for (
    const key of ["path", "file", "nodePath", "hash", "expectedHash", "id", "start", "end", "line"]
  ) {
    if (key in item) {
      pointer[key] = item[key];
    }
  }
  return pointer;
}

function extractPagination(content: unknown): unknown {
  if (!isRecord(content)) {
    return undefined;
  }
  const pagination: Record<string, unknown> = {};
  for (const key of ["limit", "offset", "nextOffset", "cursor", "nextCursor", "hasMore", "total"]) {
    if (key in content) {
      pagination[key] = content[key];
    }
  }
  if (Object.keys(pagination).length === 0 && isRecord(content.page)) {
    return extractPagination(content.page);
  }
  if (Object.keys(pagination).length === 0 && isRecord(content.data)) {
    return extractPagination(content.data);
  }
  return Object.keys(pagination).length > 0 ? pagination : undefined;
}

function extractChangedPaths(content: unknown): string[] {
  const normalized = normalizeToolContent(content);
  const paths = new Set<string>();
  collectChangedPaths(normalized, paths);
  return [...paths];
}

function collectChangedPaths(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectChangedPaths(item, paths);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["path", "file", "filename"]) {
    const found = value[key];
    if (typeof found === "string") {
      paths.add(found);
    }
  }
  for (const key of ["changedFiles", "changed_files", "files"]) {
    const found = value[key];
    if (Array.isArray(found)) {
      for (const item of found) {
        if (typeof item === "string") {
          paths.add(item);
        } else {
          collectChangedPaths(item, paths);
        }
      }
    }
  }

  for (const nested of Object.values(value)) {
    if (Array.isArray(nested) || isRecord(nested)) {
      collectChangedPaths(nested, paths);
    }
  }
}

function defaultChunkTaskIds(state: MemoryState): string[] {
  const live = new Set(state.tasks.map((task) => task.id));
  if (state.activeTaskId && live.has(state.activeTaskId)) {
    return [state.activeTaskId];
  }
  return state.tasks.length === 1 ? [state.tasks[0].id] : [];
}

async function materializeBatchChunks(
  response: BatchChunkResponse,
  results: ToolResultEnvelope[],
  resultOffset: number,
): Promise<MemoryChunk[]> {
  return await Promise.all(response.chunks.map(async (chunk, index) => {
    const source = results[chunk.sourceResultIndex];
    return {
      id: `chunk_${await shortHash(
        `${source.id}:${resultOffset}:${index}:${chunk.title}:${chunk.summary}`,
      )}`,
      title: chunk.title,
      summary: chunk.summary,
      kind: chunk.kind,
      taskIds: unique(chunk.taskIds),
      pointer: {
        sourceResultId: source.id,
        toolName: source.toolName,
        ...chunk.pointer,
      },
      source: "tool" as const,
    };
  }));
}

async function safeChunkBatch(
  client: BatchChunkClient,
  request: BatchChunkRequest,
): Promise<unknown> {
  return await client(request);
}

function splitBatches(results: ToolResultEnvelope[], maxChars: number): ToolResultEnvelope[][] {
  const batches: ToolResultEnvelope[][] = [];
  let current: ToolResultEnvelope[] = [];
  let currentSize = 0;

  for (const result of results) {
    const size = stableJson(result).length;
    if (current.length > 0 && currentSize + size > maxChars) {
      batches.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(result);
    currentSize += size;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
