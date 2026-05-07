import type { ChunkSelector, PieceDraft } from "./memory_state.ts";
import {
  exactByteSizeForSelection,
  hasSafeTextChunkBoundaries,
  materializeTextSpans,
  previewForRenderedText,
  renderTextSelection,
  sourceTextView,
} from "./source_selectors.ts";
import type { StructuredClients } from "./structured_model.ts";
import type { RoundSource } from "./tool_results.ts";

const PANDO_ARRAY_KEYS = [
  "results",
  "rows",
  "items",
  "exports",
  "changedFiles",
  "namespaces",
  "edges",
];

export type ChunkRoundSourcesResult = {
  pieces: PieceDraft[];
  chunkedViaModelSourceCount: number;
  chunkedDeterministicSourceCount: number;
};

export async function chunkRoundSources(
  sources: RoundSource[],
  clients: StructuredClients,
): Promise<ChunkRoundSourcesResult> {
  const out: PieceDraft[] = [];
  const batchedSources = sources.filter((source) =>
    !(source.sourceKind === "tool" && isPandoToolName(source.toolName)) &&
    source.sourceKind !== "tool_call"
  );
  const chunkedWithModel = batchedSources.length > 0
    ? await chunkBatchWithModel(batchedSources, clients)
    : {
      selectorsBySourceId: new Map<string, ChunkSelector[]>(),
      modelSelectedSourceIds: new Set<string>(),
    };
  const modelSelectedSourceIds = new Set(chunkedWithModel.modelSelectedSourceIds);

  for (const source of sources) {
    let selectors: ChunkSelector[];
    if (source.sourceKind === "tool_call") {
      selectors = [{ kind: "whole" } satisfies ChunkSelector];
    } else if (source.sourceKind === "tool" && isPandoToolName(source.toolName)) {
      selectors = deterministicPandoSelectors(source.payload);
    } else {
      selectors = chunkedWithModel.selectorsBySourceId.get(source.sourceId) ??
        [{ kind: "whole" } satisfies ChunkSelector];
    }
    const pieces = materializeSourceSelectors(source, selectors);
    out.push(
      ...(pieces.length > 0 ? pieces : materializeSourceSelectors(source, [{ kind: "whole" }])),
    );
  }
  return {
    pieces: out,
    chunkedViaModelSourceCount: modelSelectedSourceIds.size,
    chunkedDeterministicSourceCount: sources.length - modelSelectedSourceIds.size,
  };
}

export function isPandoToolName(toolName: string | undefined): boolean {
  return typeof toolName === "string" &&
    (toolName.startsWith("mcp__pando__") || toolName.startsWith("pando."));
}

export function deterministicPandoSelectors(payload: unknown): ChunkSelector[] {
  if (Array.isArray(payload)) {
    return payload.map((_, index) => ({ kind: "object_path", path: [index] }));
  }

  for (const prefix of [[], ["data"]]) {
    for (const key of PANDO_ARRAY_KEYS) {
      const path = [...prefix, key];
      const value = readObjectPath(payload, path);
      if (Array.isArray(value) && value.length > 0) {
        return value.map((_, index) => ({ kind: "object_path", path: [...path, index] }));
      }
    }
  }

  return [{ kind: "whole" }];
}

export function materializeSourceSelectors(
  source: RoundSource,
  selectors: ChunkSelector[],
): PieceDraft[] {
  const normalizedSelectors = normalizeSelectors(selectors);
  const out: PieceDraft[] = [];
  for (const [index, selector] of normalizedSelectors.entries()) {
    const materialized = materializeSelector(source, selector);
    if (!materialized) {
      continue;
    }
    const pointer = buildPointer(source, selector);
    const draft: PieceDraft = {
      id: `${source.sourceId}:${index}`,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      ...(source.toolName ? { toolName: source.toolName } : {}),
      content: materialized.content,
      previewText: materialized.previewText,
      ...(pointer ? { pointer } : {}),
      byteSize: materialized.byteSize,
      selector,
    };
    if (draft.byteSize > 0) {
      out.push(draft);
    }
  }
  return out;
}

function normalizeSelectors(selectors: ChunkSelector[]): ChunkSelector[] {
  const seen = new Set<string>();
  const out: ChunkSelector[] = [];
  for (const selector of selectors) {
    const normalized = normalizeSelector(selector);
    const key = JSON.stringify(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function normalizeSelector(selector: ChunkSelector): ChunkSelector {
  if (selector.kind !== "chunks") {
    return selector;
  }
  const chunks = [...selector.chunks]
    .filter((span) =>
      Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start
    )
    .map((span) => ({ start: span.start, end: span.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: typeof chunks = [];
  for (const span of chunks) {
    const last = merged.at(-1);
    if (!last || span.start > last.end) {
      merged.push(span);
      continue;
    }
    last.end = Math.max(last.end, span.end);
  }
  return merged.length === 0 ? { kind: "whole" } : { kind: "chunks", chunks: merged };
}

export function materializeSelector(
  source: Pick<RoundSource, "sourceKind" | "toolName" | "payload">,
  selector: ChunkSelector,
): { content: unknown; previewText: string; byteSize: number } | null {
  if (selector.kind === "whole") {
    if (source.sourceKind === "tool" && isPandoToolName(source.toolName)) {
      const content = source.payload;
      return {
        content,
        previewText: previewText(content),
        byteSize: byteSize(content),
      };
    }
    const text = sourceTextView(source);
    return {
      content: text,
      previewText: previewForRenderedText(text),
      byteSize: byteSize(text),
    };
  }
  if (selector.kind === "chunks") {
    const selection = materializeTextSpans(source, selector.chunks);
    const rendered = renderTextSelection(selection);
    return {
      content: selection,
      previewText: previewForRenderedText(rendered),
      byteSize: exactByteSizeForSelection(selection),
    };
  }
  const content = readObjectPath(source.payload, selector.path);
  if (content === undefined) {
    return null;
  }
  return {
    content,
    previewText: previewText(content),
    byteSize: byteSize(content),
  };
}

async function chunkBatchWithModel(
  sources: RoundSource[],
  clients: StructuredClients,
): Promise<{
  selectorsBySourceId: Map<string, ChunkSelector[]>;
  modelSelectedSourceIds: Set<string>;
}> {
  const request = {
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
      ...(source.toolName ? { toolName: source.toolName } : {}),
      contentText: sourceTextView(source),
      ...(source.pointer ? { pointer: source.pointer } : {}),
    })),
  };
  const response = await requestChunkBatchWithSingleRetry(
    (attempt) => clients.sourceChunkBatch(request, attempt),
  ).catch(() => null);
  if (!response || !Array.isArray(response.results)) {
    return wholeSelectorFallback(sources);
  }
  const byId = new Map<string, ChunkSelector[]>();
  const requestedIds = new Set(sources.map((source) => source.sourceId));
  const modelSelectedSourceIds = new Set<string>();
  for (const entry of response.results ?? []) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.sourceId !== "string" ||
      !requestedIds.has(entry.sourceId)
    ) {
      continue;
    }
    if (byId.has(entry.sourceId)) {
      return wholeSelectorFallback(sources);
    }
    const source = sources.find((candidate) => candidate.sourceId === entry.sourceId);
    const selectors = source ? materializeModelChunkSelectors(entry.selectors, source) : null;
    byId.set(
      entry.sourceId,
      selectors ?? [{ kind: "whole" }],
    );
    if (selectors) {
      modelSelectedSourceIds.add(entry.sourceId);
    }
  }
  return { selectorsBySourceId: byId, modelSelectedSourceIds };
}

function wholeSelectorFallback(sources: RoundSource[]): {
  selectorsBySourceId: Map<string, ChunkSelector[]>;
  modelSelectedSourceIds: Set<string>;
} {
  return {
    selectorsBySourceId: new Map(
      sources.map((source) => [source.sourceId, [{ kind: "whole" } satisfies ChunkSelector]]),
    ),
    modelSelectedSourceIds: new Set(),
  };
}

function materializeModelChunkSelectors(
  value: unknown,
  source: RoundSource,
): ChunkSelector[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (value.some((selector) => isWholeSelector(selector)) && value.length > 1) {
    return null;
  }
  if (value.length === 1 && isWholeSelector(value[0])) {
    return [{ kind: "whole" }];
  }
  const sourceText = sourceTextView(source);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const selector of value) {
    if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
      return null;
    }
    const record = selector as Record<string, unknown>;
    if (record.kind !== "chunks" || !Array.isArray(record.chunks) || record.chunks.length === 0) {
      return null;
    }
    for (const chunk of record.chunks) {
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
        return null;
      }
      const item = chunk as Record<string, unknown>;
      const startText = item.startText;
      const endText = item.endText;
      if (
        typeof startText !== "string" ||
        typeof endText !== "string" ||
        startText.length === 0 ||
        endText.length === 0
      ) {
        return null;
      }
      const matches = findAllBoundaryOccurrences(sourceText, startText, endText);
      if (matches.length === 0) {
        return null;
      }
      ranges.push(...matches);
    }
  }
  const sortedRanges = ranges.sort((left, right) =>
    left.start - right.start || left.end - right.end
  );
  const combinedSelector: ChunkSelector = { kind: "chunks", chunks: sortedRanges };
  if (!isValidMaterializedChunkSelector(combinedSelector, sourceText)) {
    return null;
  }
  return sortedRanges.map((range): ChunkSelector => ({ kind: "chunks", chunks: [range] }));
}

function findAllBoundaryOccurrences(
  text: string,
  startText: string,
  endText: string,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const start = text.indexOf(startText, cursor);
    if (start < 0) {
      break;
    }
    const endSearchStart = startText === endText ? start : start + startText.length;
    const endStart = text.indexOf(endText, endSearchStart);
    if (endStart < 0) {
      break;
    }
    const end = endStart + endText.length;
    out.push({ start, end });
    cursor = end;
  }
  return out;
}

function isValidMaterializedChunkSelector(
  value: unknown,
  sourceText: string,
): value is ChunkSelector {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "whole") {
    return true;
  }
  if (record.kind !== "chunks" || !Array.isArray(record.chunks)) {
    return false;
  }
  const textLength = sourceText.length;
  let previousEnd = -1;
  if (record.chunks.length === 0) {
    return false;
  }
  for (const chunk of record.chunks) {
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      return false;
    }
    const startValue = (chunk as Record<string, unknown>).start;
    const endValue = (chunk as Record<string, unknown>).end;
    if (
      !Number.isInteger(startValue) ||
      !Number.isInteger(endValue)
    ) {
      return false;
    }
    const start = startValue as number;
    const end = endValue as number;
    if (
      start < 0 ||
      end <= start ||
      end > textLength ||
      start < previousEnd ||
      !hasSafeTextChunkBoundaries(sourceText, { start, end })
    ) {
      return false;
    }
    previousEnd = end;
  }
  return true;
}

function isWholeSelector(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "whole";
}

async function requestChunkBatchWithSingleRetry(
  invoke: (
    attempt: number,
  ) => Promise<{ results?: Array<{ sourceId: string; selectors?: unknown }> }>,
): Promise<{ results?: Array<{ sourceId: string; selectors?: unknown }> }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await invoke(attempt);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function buildPointer(
  source: RoundSource,
  selector: ChunkSelector,
): Record<string, unknown> | null {
  const pointer: Record<string, unknown> = {
    ...(source.pointer ?? {}),
    selector,
  };
  return Object.keys(pointer).length > 0 ? pointer : null;
}

function readObjectPath(payload: unknown, path: Array<string | number>): unknown {
  let current: unknown = payload;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function byteSize(value: unknown): number {
  return new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  ).length;
}

function previewText(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
