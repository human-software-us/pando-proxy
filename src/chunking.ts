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

const MAX_CHUNK_ROUNDS = 7;

type SourceSpan = { start: number; end: number };

export type ChunkRoundLogEntry = {
  round: number;
  itemCount: number;
  itemSizes: number[];
  realSplits: number;
  itemErrors: number;
  perItemSections: number[];
  perItemResulting: number[];
  resultingChunkCount: number;
  resultingLargest: number;
  durationMs: number;
};

let chunkRoundLogger: ((entry: ChunkRoundLogEntry) => void) | null = null;
export function setChunkRoundLogger(fn: ((entry: ChunkRoundLogEntry) => void) | null): void {
  chunkRoundLogger = fn;
}

async function chunkBatchWithModel(
  sources: RoundSource[],
  clients: StructuredClients,
): Promise<{
  selectorsBySourceId: Map<string, ChunkSelector[]>;
  modelSelectedSourceIds: Set<string>;
}> {
  const sourceTextById = new Map<string, string>();
  const spansBySourceId = new Map<string, SourceSpan[]>();
  for (const source of sources) {
    const text = sourceTextView(source);
    sourceTextById.set(source.sourceId, text);
    spansBySourceId.set(source.sourceId, [{ start: 0, end: text.length }]);
  }

  let anyCallFailed = false;
  const sourceHasSuccess = new Set<string>();
  for (let round = 0; round < MAX_CHUNK_ROUNDS; round += 1) {
    type ItemKey = { sourceId: string; spanIndex: number };
    const items: { itemId: string; text: string }[] = [];
    const itemKeys: ItemKey[] = [];
    for (const source of sources) {
      const spans = spansBySourceId.get(source.sourceId) ?? [];
      const text = sourceTextById.get(source.sourceId) ?? "";
      for (const [spanIndex, span] of spans.entries()) {
        const itemId = `s${itemKeys.length}`;
        items.push({ itemId, text: text.slice(span.start, span.end) });
        itemKeys.push({ sourceId: source.sourceId, spanIndex });
      }
    }
    if (items.length === 0) {
      break;
    }

    const startedAt = Date.now();
    const response = await callSourceChunkBatchWithRetry(clients, { items }).catch(() => null);
    const durationMs = Date.now() - startedAt;
    if (!response || !Array.isArray(response.results)) {
      anyCallFailed = true;
      break;
    }

    const resultsById = new Map<string, typeof response.results[number]>();
    for (const entry of response.results) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      if (typeof record.itemId !== "string") {
        continue;
      }
      resultsById.set(record.itemId, entry);
    }

    let realSplits = 0;
    let itemErrors = 0;
    const perItemSections: number[] = [];
    const perItemResulting: number[] = [];
    const newSpansBySourceId = new Map<string, SourceSpan[]>();
    for (const source of sources) {
      newSpansBySourceId.set(source.sourceId, []);
    }
    for (const [itemIndex, item] of items.entries()) {
      const key = itemKeys[itemIndex];
      const parentSpans = spansBySourceId.get(key.sourceId) ?? [];
      const parentSpan = parentSpans[key.spanIndex];
      const carry = newSpansBySourceId.get(key.sourceId) ?? [];
      const result = resultsById.get(item.itemId) as
        | { itemId: string; sections?: unknown; error?: unknown }
        | undefined;
      const sections = result && Array.isArray(result.sections) ? result.sections : null;
      if (typeof result?.error === "string") {
        itemErrors += 1;
      }
      if (!sections) {
        perItemSections.push(0);
        perItemResulting.push(1);
        carry.push(parentSpan);
        newSpansBySourceId.set(key.sourceId, carry);
        continue;
      }
      sourceHasSuccess.add(key.sourceId);
      const sub = resolveAnchorsToSpans(item.text, sections as { anchor?: unknown }[]);
      perItemSections.push(sections.length);
      perItemResulting.push(sub.length);
      if (sub.length < 2) {
        carry.push(parentSpan);
        newSpansBySourceId.set(key.sourceId, carry);
        continue;
      }
      for (const local of sub) {
        carry.push({
          start: parentSpan.start + local.start,
          end: parentSpan.start + local.end,
        });
      }
      newSpansBySourceId.set(key.sourceId, carry);
      realSplits += 1;
    }

    for (const [sourceId, spans] of newSpansBySourceId) {
      spansBySourceId.set(sourceId, spans);
    }

    const resultingChunkCount = Array.from(spansBySourceId.values()).reduce(
      (sum, spans) => sum + spans.length,
      0,
    );
    const resultingLargest = Array.from(spansBySourceId.values()).reduce(
      (m, spans) => spans.reduce((mm, s) => Math.max(mm, s.end - s.start), m),
      0,
    );
    chunkRoundLogger?.({
      round: round + 1,
      itemCount: items.length,
      itemSizes: items.map((i) => i.text.length),
      realSplits,
      itemErrors,
      perItemSections,
      perItemResulting,
      resultingChunkCount,
      resultingLargest,
      durationMs,
    });

    if (realSplits === 0) {
      break;
    }
  }

  const selectorsBySourceId = new Map<string, ChunkSelector[]>();
  const modelSelectedSourceIds = new Set<string>();
  for (const source of sources) {
    const text = sourceTextById.get(source.sourceId) ?? "";
    const spans = spansBySourceId.get(source.sourceId) ?? [];
    const losslessOk = spans.length > 0 &&
      spans[0].start === 0 &&
      spans[spans.length - 1].end === text.length &&
      spans.every((span, index) =>
        span.end > span.start &&
        (index === 0 || span.start === spans[index - 1].end)
      );
    if (anyCallFailed || !losslessOk) {
      selectorsBySourceId.set(source.sourceId, [{ kind: "whole" }]);
      continue;
    }
    if (spans.length <= 1 && !sourceHasSuccess.has(source.sourceId)) {
      // Model never returned sections for this source; treat as deterministic whole.
      selectorsBySourceId.set(source.sourceId, [{ kind: "whole" }]);
      continue;
    }
    selectorsBySourceId.set(
      source.sourceId,
      spans.map((span) =>
        ({ kind: "chunks", chunks: [{ start: span.start, end: span.end }] }) satisfies ChunkSelector
      ),
    );
    modelSelectedSourceIds.add(source.sourceId);
  }
  return { selectorsBySourceId, modelSelectedSourceIds };
}

function resolveAnchorsToSpans(
  text: string,
  sections: { label?: unknown; anchor?: unknown }[],
): SourceSpan[] {
  if (text.length === 0) {
    return [];
  }
  if (sections.length === 0) {
    return [{ start: 0, end: text.length }];
  }
  let cursor = 0;
  const offsets: number[] = [];
  for (const section of sections) {
    const anchor = typeof section.anchor === "string" ? section.anchor : "";
    if (!anchor) {
      continue;
    }
    const pos = text.indexOf(anchor, cursor);
    if (pos < 0) {
      continue;
    }
    offsets.push(pos);
    cursor = pos + Math.max(1, anchor.length);
  }
  if (offsets.length === 0) {
    return [{ start: 0, end: text.length }];
  }
  if (offsets[0] !== 0) {
    offsets.unshift(0);
  }
  const out: SourceSpan[] = [];
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : text.length;
    if (end > start) {
      out.push({ start, end });
    }
  }
  if (
    out.length === 0 ||
    out[0].start !== 0 ||
    out[out.length - 1].end !== text.length
  ) {
    return [{ start: 0, end: text.length }];
  }
  return out;
}

async function callSourceChunkBatchWithRetry(
  clients: StructuredClients,
  request: { items: { itemId: string; text: string }[] },
): Promise<{ results?: unknown[] } & Record<string, unknown> | null> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await clients.sourceChunkBatch(request, attempt);
      return response as unknown as { results: unknown[] };
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
