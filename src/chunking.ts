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
const LARGE_WHOLE_SPLIT_BYTES = 64_000;
const MAX_DETERMINISTIC_SPAN_BYTES = 48_000;

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
  const batchedSelectors = batchedSources.length > 0
    ? await chunkBatchWithModel(batchedSources, clients)
    : new Map<string, ChunkSelector[]>();

  for (const source of sources) {
    let selectors: ChunkSelector[];
    if (source.sourceKind === "tool_call") {
      selectors = [{ kind: "whole" } satisfies ChunkSelector];
    } else if (source.sourceKind === "tool" && isPandoToolName(source.toolName)) {
      selectors = deterministicPandoSelectors(source.payload);
    } else {
      selectors = batchedSelectors.get(source.sourceId) ??
        [{ kind: "whole" } satisfies ChunkSelector];
    }
    selectors = expandLargeWholeSelectors(source, selectors);
    const pieces = materializeSourceSelectors(source, selectors);
    out.push(
      ...(pieces.length > 0 ? pieces : materializeSourceSelectors(source, [{ kind: "whole" }])),
    );
  }
  return {
    pieces: out,
    chunkedViaModelSourceCount: batchedSources.length,
    chunkedDeterministicSourceCount: sources.length - batchedSources.length,
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

function expandLargeWholeSelectors(
  source: RoundSource,
  selectors: ChunkSelector[],
): ChunkSelector[] {
  const out: ChunkSelector[] = [];
  for (const selector of selectors) {
    if (selector.kind !== "whole") {
      out.push(selector);
      continue;
    }
    const text = sourceTextView(source);
    if (byteSize(text) <= LARGE_WHOLE_SPLIT_BYTES) {
      out.push(selector);
      continue;
    }
    const spans = splitLargeTextIntoBoundarySpans(text);
    if (spans.length > 1) {
      out.push(...spans.map((span): ChunkSelector => ({ kind: "text_spans", spans: [span] })));
    } else {
      out.push(selector);
    }
  }
  return out;
}

function splitLargeTextIntoBoundarySpans(text: string): Array<{ start: number; end: number }> {
  const jsonArraySpans = topLevelJsonArrayElementSpans(text);
  if (jsonArraySpans.length > 1) {
    return packSpansByApproxBytes(jsonArraySpans, text);
  }
  return lineWindowSpans(text);
}

function topLevelJsonArrayElementSpans(text: string): Array<{ start: number; end: number }> {
  const trimmedStart = text.search(/\S/);
  if (trimmedStart < 0 || text[trimmedStart] !== "[") {
    return [];
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  let elementStart = -1;
  let rootClosedAt = -1;
  const spans: Array<{ start: number; end: number }> = [];

  for (let index = trimmedStart; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[" || char === "{") {
      depth += 1;
      if (depth === 1 && char === "[") {
        elementStart = index + 1;
      }
      continue;
    }
    if (char === "]" || char === "}") {
      if (depth === 1 && char === "]") {
        pushTrimmedSpan(spans, text, elementStart, index);
        rootClosedAt = index;
      }
      depth -= 1;
      if (depth < 0) {
        return [];
      }
      continue;
    }
    if (char === "," && depth === 1) {
      pushTrimmedSpan(spans, text, elementStart, index);
      elementStart = index + 1;
    }
  }
  if (depth !== 0 || rootClosedAt < 0) {
    return [];
  }
  return text.slice(rootClosedAt + 1).trim() === "" ? spans : [];
}

function pushTrimmedSpan(
  spans: Array<{ start: number; end: number }>,
  text: string,
  start: number,
  end: number,
): void {
  let spanStart = start;
  let spanEnd = end;
  while (spanStart < spanEnd && /\s/.test(text[spanStart])) {
    spanStart += 1;
  }
  while (spanEnd > spanStart && /\s/.test(text[spanEnd - 1])) {
    spanEnd -= 1;
  }
  if (spanEnd > spanStart) {
    spans.push({ start: spanStart, end: spanEnd });
  }
}

function packSpansByApproxBytes(
  spans: Array<{ start: number; end: number }>,
  text: string,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let current: { start: number; end: number } | null = null;
  for (const span of spans) {
    if (!current) {
      current = { ...span };
      continue;
    }
    const packedBytes = byteSize(text.slice(current.start, span.end));
    if (packedBytes > MAX_DETERMINISTIC_SPAN_BYTES) {
      out.push(current);
      current = { ...span };
      continue;
    }
    current.end = span.end;
  }
  if (current) {
    out.push(current);
  }
  return out;
}

function lineWindowSpans(text: string): Array<{ start: number; end: number }> {
  if (!text.includes("\n")) {
    return [];
  }
  const spans: Array<{ start: number; end: number }> = [];
  let windowStart = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const nextNewline = text.indexOf("\n", cursor);
    const lineEnd = nextNewline < 0 ? text.length : nextNewline + 1;
    if (
      lineEnd > windowStart &&
      byteSize(text.slice(windowStart, lineEnd)) > MAX_DETERMINISTIC_SPAN_BYTES &&
      cursor > windowStart
    ) {
      spans.push({ start: windowStart, end: cursor });
      windowStart = cursor;
    }
    cursor = lineEnd;
  }
  if (windowStart < text.length) {
    spans.push({ start: windowStart, end: text.length });
  }
  return spans.length > 1 ? spans : [];
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
  if (selector.kind !== "text_spans") {
    return selector;
  }
  const spans = [...selector.spans]
    .filter((span) =>
      Number.isInteger(span.start) && Number.isInteger(span.end) && span.end > span.start
    )
    .map((span) => ({ start: span.start, end: span.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: typeof spans = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (!last || span.start > last.end) {
      merged.push(span);
      continue;
    }
    last.end = Math.max(last.end, span.end);
  }
  return merged.length === 0 ? { kind: "whole" } : { kind: "text_spans", spans: merged };
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
  if (selector.kind === "text_spans") {
    const selection = materializeTextSpans(source, selector.spans);
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
): Promise<Map<string, ChunkSelector[]>> {
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
  );
  const byId = new Map<string, ChunkSelector[]>();
  for (const entry of response.results ?? []) {
    byId.set(
      entry.sourceId,
      Array.isArray(entry.selectors) && entry.selectors.length > 0
        ? entry.selectors
        : [{ kind: "whole" }],
    );
  }
  return byId;
}

async function requestChunkBatchWithSingleRetry(
  invoke: (
    attempt: number,
  ) => Promise<{ results?: Array<{ sourceId: string; selectors?: ChunkSelector[] }> }>,
): Promise<{ results?: Array<{ sourceId: string; selectors?: ChunkSelector[] }> }> {
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
