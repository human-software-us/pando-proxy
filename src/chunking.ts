import type { ProxyConfig } from "./config.ts";
import { stableJson } from "./json.ts";
import type { ChunkDraft, ChunkSelector } from "./memory_state.ts";
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

export async function chunkRoundSources(
  sources: RoundSource[],
  config: ProxyConfig,
  clients: StructuredClients,
): Promise<ChunkDraft[]> {
  const out: ChunkDraft[] = [];
  for (const source of sources) {
    const drafts = source.sourceKind === "user"
      ? chunkWholeSource(source, config)
      : source.sourceKind === "tool" && isPandoToolName(source.toolName)
      ? chunkPandoSource(source, config)
      : await chunkWithModel(source, config, clients);
    out.push(...drafts);
  }
  return out;
}

export function chunkPandoSource(source: RoundSource, config: ProxyConfig): ChunkDraft[] {
  const selectors = deterministicPandoSelectors(source.payload);
  return materializeSourceSelectors(source, selectors, config);
}

export function isPandoToolName(toolName: string | undefined): boolean {
  return typeof toolName === "string" &&
    (toolName.startsWith("mcp__pando__") || toolName.startsWith("pando."));
}

export function deterministicPandoSelectors(payload: unknown): ChunkSelector[] {
  if (Array.isArray(payload)) {
    return payload.map((_, index) => ({ kind: "object_path", path: [index] }));
  }

  const arrayPath = findCandidateArrayPath(payload);
  if (arrayPath) {
    const arrayValue = readObjectPath(payload, arrayPath);
    if (Array.isArray(arrayValue)) {
      return arrayValue.map((_, index) => ({
        kind: "object_path",
        path: [...arrayPath, index],
      }));
    }
  }

  return [{ kind: "whole" }];
}

export function materializeSourceSelectors(
  source: RoundSource,
  selectors: ChunkSelector[],
  _config: Pick<ProxyConfig, "piecePreviewCharLimit">,
): ChunkDraft[] {
  return selectors.map((selector, index) => {
    const payload = materializeSelector(source.payload, selector);
    const pointer = buildPointer(source, selector);
    return {
      id: `${source.sourceId}:${index}`,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      ...(source.toolName ? { toolName: source.toolName } : {}),
      payload,
      ...(pointer ? { pointer } : {}),
      byteSize: byteSize(payload),
      selector,
    };
  });
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

async function chunkWithModel(
  source: RoundSource,
  config: ProxyConfig,
  clients: StructuredClients,
): Promise<ChunkDraft[]> {
  const response = await clients.sourceChunk({
    sourceKind: source.sourceKind as "assistant" | "tool",
    ...(source.toolName ? { toolName: source.toolName } : {}),
    content: source.payload,
  });
  const selectors = response.chunks.length > 0
    ? response.chunks
    : [{ kind: "whole" } satisfies ChunkSelector];
  const drafts = materializeSourceSelectors(source, selectors, config).filter((draft) =>
    draft.payload !== undefined && draft.byteSize > 0
  );
  if (drafts.length > 0) {
    return drafts;
  }
  return materializeSourceSelectors(source, [{ kind: "whole" }], config);
}

function buildPointer(source: RoundSource, selector: ChunkSelector): Record<string, unknown> | null {
  const pointer: Record<string, unknown> = {
    ...(source.pointer ?? {}),
    selector,
  };
  return Object.keys(pointer).length > 0 ? pointer : null;
}

function chunkWholeSource(
  source: RoundSource,
  config: Pick<ProxyConfig, "piecePreviewCharLimit">,
): ChunkDraft[] {
  return materializeSourceSelectors(source, [{ kind: "whole" }], config);
}

function findCandidateArrayPath(payload: unknown): Array<string | number> | null {
  for (const prefix of [[], ["data"]]) {
    for (const key of PANDO_ARRAY_KEYS) {
      const path = [...prefix, key];
      const value = readObjectPath(payload, path);
      if (Array.isArray(value) && value.length > 0) {
        return path;
      }
    }
  }
  return null;
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
    typeof value === "string" ? value : stableJson(value),
  ).length;
}
