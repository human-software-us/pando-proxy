import { stableJson } from "./json.ts";
import type { RoundSource } from "./tool_results.ts";

type SourceLike = Pick<RoundSource, "sourceKind" | "toolName" | "payload">;

export type TextSpan = {
  start: number;
  end: number;
};

export type TextSpanSelection = {
  kind: "chunks";
  sourceTextLength: number;
  segments: Array<TextSpan & { text: string }>;
};

export function sourceTextView(source: SourceLike): string {
  if (typeof source.payload === "string") {
    return source.payload;
  }
  if (isMessagePayload(source.payload)) {
    const inline = extractInlineMessageText(source.payload);
    if (inline.trim().length > 0) {
      return inline;
    }
  }
  return stableJson(source.payload);
}

export function materializeTextSpans(
  source: SourceLike,
  spans: TextSpan[],
): TextSpanSelection {
  const text = sourceTextView(source);
  return {
    kind: "chunks",
    sourceTextLength: text.length,
    segments: normalizeSpans(spans, text.length).map((span) => ({
      ...span,
      text: text.slice(span.start, span.end),
    })),
  };
}

export function renderTextSelection(selection: TextSpanSelection): string {
  if (selection.segments.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let previousEnd = 0;
  for (const [index, segment] of selection.segments.entries()) {
    if (segment.start > previousEnd) {
      lines.push(`<gap omittedChars=${segment.start - previousEnd} />`);
    } else if (index > 0) {
      lines.push("<gap omittedChars=0 />");
    }
    lines.push(`<segment start=${segment.start} end=${segment.end}>`);
    lines.push(segment.text);
    lines.push("</segment>");
    previousEnd = segment.end;
  }
  if (previousEnd < selection.sourceTextLength) {
    lines.push(`<gap omittedChars=${selection.sourceTextLength - previousEnd} />`);
  }
  return lines.join("\n");
}

export function previewForRenderedText(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function exactByteSizeForSelection(selection: TextSpanSelection): number {
  return new TextEncoder().encode(selection.segments.map((segment) => segment.text).join(""))
    .byteLength;
}

export function hasSafeTextChunkBoundaries(text: string, span: TextSpan): boolean {
  return isSafeTextBoundary(text, span.start) && isSafeTextBoundary(text, span.end);
}

function isSafeTextBoundary(text: string, offset: number): boolean {
  if (offset === 0 || offset === text.length) {
    return true;
  }
  if (offset < 0 || offset > text.length) {
    return false;
  }
  const before = text[offset - 1] ?? "";
  const after = text[offset] ?? "";
  if (/\s/.test(before) || /\s/.test(after)) {
    return true;
  }
  return isBoundaryPunctuation(before) || isBoundaryPunctuation(after);
}

function isBoundaryPunctuation(char: string): boolean {
  return char.length === 1 && /[()[\]{}<>,;:|]/.test(char);
}

function normalizeSpans(spans: TextSpan[], textLength: number): TextSpan[] {
  const normalized = spans
    .filter((span) => Number.isInteger(span.start) && Number.isInteger(span.end))
    .map((span) => ({
      start: Math.max(0, Math.min(textLength, span.start)),
      end: Math.max(0, Math.min(textLength, span.end)),
    }))
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const out: TextSpan[] = [];
  let previousEnd = -1;
  for (const span of normalized) {
    if (span.start < previousEnd) {
      continue;
    }
    out.push(span);
    previousEnd = span.end;
  }
  return out;
}

function isMessagePayload(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "message";
}

function extractInlineMessageText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((entry) => {
    if (typeof entry === "string") {
      return entry;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return "";
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.input_text === "string") {
      return record.input_text;
    }
    if (typeof record.output_text === "string") {
      return record.output_text;
    }
    return "";
  }).join("\n");
}
