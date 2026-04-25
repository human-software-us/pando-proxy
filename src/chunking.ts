import { stableJson } from "./json.ts";
import type { ChunkSelector, PieceDraft } from "./memory_state.ts";
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
    !(source.sourceKind === "tool" && isPandoToolName(source.toolName))
  );
  const batchedSelectors = batchedSources.length > 0
    ? await chunkBatchWithModel(batchedSources, clients)
    : new Map<string, ChunkSelector[]>();

  for (const source of sources) {
    const selectors = source.sourceKind === "tool" && isPandoToolName(source.toolName)
      ? deterministicPandoSelectors(source.payload)
      : batchedSelectors.get(source.sourceId) ?? [{ kind: "whole" } satisfies ChunkSelector];
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

export function materializeSourceSelectors(
  source: RoundSource,
  selectors: ChunkSelector[],
): PieceDraft[] {
  const out: PieceDraft[] = [];
  for (const [index, selector] of selectors.entries()) {
    const payloadInline = materializeSelector(source.payload, selector);
    if (payloadInline === undefined) {
      continue;
    }
    const pointer = buildPointer(source, selector);
    const draft: PieceDraft = {
      id: `${source.sourceId}:${index}`,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      ...(source.toolName ? { toolName: source.toolName } : {}),
      payloadInline,
      previewText: previewText(payloadInline),
      ...(pointer ? { pointer } : {}),
      byteSize: byteSize(payloadInline),
      selector,
    };
    if (draft.byteSize > 0) {
      out.push(draft);
    }
  }
  return out;
}

export function materializeSelector(payload: unknown, selector: ChunkSelector): unknown {
  if (selector.kind === "whole") {
    return payload;
  }
  if (selector.kind === "line_range") {
    const text = typeof payload === "string" ? payload : stableJson(payload);
    const lines = text.split(/\r?\n/);
    const start = Math.max(1, selector.startLine);
    const end = Math.max(start, selector.endLine);
    return lines.slice(start - 1, end).join("\n");
  }
  return readObjectPath(payload, selector.path);
}

async function chunkBatchWithModel(
  sources: RoundSource[],
  clients: StructuredClients,
): Promise<Map<string, ChunkSelector[]>> {
  const response = await clients.sourceChunkBatch({
    sources: sources.map((source) => ({
      sourceId: source.sourceId,
      sourceKind: source.sourceKind,
      ...(source.toolName ? { toolName: source.toolName } : {}),
      content: source.payload,
      ...(source.pointer ? { pointer: source.pointer } : {}),
    })),
  });
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
  return new TextEncoder().encode(typeof value === "string" ? value : stableJson(value)).length;
}

function previewText(value: unknown): string {
  const text = typeof value === "string" ? value : stableJson(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
