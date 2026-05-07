import type { ChunkSelector, PieceDraft } from "./memory_state.ts";
import {
  exactByteSizeForSelection,
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
    source.sourceKind !== "user" &&
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
    if (source.sourceKind === "user" || source.sourceKind === "tool_call") {
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
    const selectors = source ? materializeModelChunks(entry.chunks, source) : null;
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

function materializeModelChunks(
  value: unknown,
  source: RoundSource,
): ChunkSelector[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  if (!value.every((chunk) => typeof chunk === "string")) {
    return null;
  }
  const sourceText = sourceTextView(source);
  const chunks = value as string[];
  if (chunks.join("") !== sourceText) {
    return null;
  }
  const selectors: ChunkSelector[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    const start = cursor;
    const end = start + chunk.length;
    cursor = end;
    if (chunk.length === 0) {
      continue;
    }
    selectors.push({ kind: "chunks", chunks: [{ start, end }] });
  }
  return selectors.length > 0 ? selectors : null;
}

async function requestChunkBatchWithSingleRetry(
  invoke: (
    attempt: number,
  ) => Promise<{ results?: Array<{ sourceId: string; chunks?: unknown }> }>,
): Promise<{ results?: Array<{ sourceId: string; chunks?: unknown }> }> {
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
