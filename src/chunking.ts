import type { ProxyConfig } from "./config.ts";
import { stableJson } from "./json.ts";
import type { PieceDraft, PieceSelector } from "./memory_state.ts";
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
): Promise<PieceDraft[]> {
  const out: PieceDraft[] = [];
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

export function chunkPandoSource(source: RoundSource, config: ProxyConfig): PieceDraft[] {
  const selectors = deterministicPandoSelectors(source.payload);
  return materializeSourceSelectors(source, selectors, config);
}

export function isPandoToolName(toolName: string | undefined): boolean {
  return typeof toolName === "string" &&
    (toolName.startsWith("mcp__pando__") || toolName.startsWith("pando."));
}

export function deterministicPandoSelectors(payload: unknown): PieceSelector[] {
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
  selectors: PieceSelector[],
  config: Pick<ProxyConfig, "piecePreviewCharLimit">,
): PieceDraft[] {
  return selectors.map((selector, index) => {
    const payloadInline = materializeSelector(source.payload, selector);
    const pointer = buildPointer(source, selector);
    return {
      id: `${source.sourceId}:${index}`,
      sourceKind: source.sourceKind,
      sourceId: source.sourceId,
      ...(source.toolName ? { toolName: source.toolName } : {}),
      payloadInline,
      ...(pointer ? { pointer } : {}),
      previewText: previewForPayload(payloadInline, config.piecePreviewCharLimit),
      byteSize: byteSize(payloadInline),
      selector,
    };
  });
}

export function materializeSelector(payload: unknown, selector: PieceSelector): unknown {
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
): Promise<PieceDraft[]> {
  const response = await clients.sourceChunk({
    sourceKind: source.sourceKind as "assistant" | "tool",
    ...(source.toolName ? { toolName: source.toolName } : {}),
    content: source.payload,
  });
  const selectors = response.chunks.length > 0
    ? response.chunks
    : [{ kind: "whole" } satisfies PieceSelector];
  return materializeSourceSelectors(source, selectors, config);
}

function buildPointer(source: RoundSource, selector: PieceSelector): Record<string, unknown> | null {
  const pointer: Record<string, unknown> = {
    ...(source.pointer ?? {}),
    selector,
  };
  return Object.keys(pointer).length > 0 ? pointer : null;
}

function previewForPayload(payload: unknown, maxChars: number): string | undefined {
  const text = previewSourceText(payload).trim();
  if (!text) {
    return undefined;
  }
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}...`;
}

function previewSourceText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.split(/\r?\n/, 1)[0] ?? "";
  }
  if (Array.isArray(payload)) {
    return stableJson(payload[0] ?? "");
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.content === "string") {
      return record.content;
    }
    return stableJson(record);
  }
  return String(payload ?? "");
}

function chunkWholeSource(
  source: RoundSource,
  config: Pick<ProxyConfig, "piecePreviewCharLimit">,
): PieceDraft[] {
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
