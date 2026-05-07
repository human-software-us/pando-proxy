import { assert, assertEquals } from "@std/assert";

import { chunkRoundSources } from "../src/chunking.ts";
import type { StructuredClients } from "../src/structured_model.ts";
import type { RoundSource } from "../src/tool_results.ts";

const keepWholeClients: StructuredClients = {
  taskRoute: () => Promise.resolve({ kind: "same_task" }),
  sourceChunkBatch: (request) =>
    Promise.resolve({
      results: request.sources.map((source) => ({
        sourceId: source.sourceId,
        selectors: [{ kind: "whole" }],
      })),
    }),
  pieceDropBatch: (request) =>
    Promise.resolve({
      decisions: request.evaluatedPieces.map((piece) => ({
        pieceId: piece.id,
        drop: false,
        reason: null,
      })),
    }),
};

Deno.test("chunkRoundSources splits large whole shell output on line boundaries", async () => {
  const payload = Array.from(
    { length: 4_000 },
    (_, index) => `src/file_${index}.clj:10: namespace hit ${index}`,
  ).join("\n");
  const source: RoundSource = {
    sourceId: "tool_large",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], keepWholeClients);

  assert(result.pieces.length > 1);
  assert(result.pieces.every((piece) => piece.selector.kind === "text_spans"));
  assertEquals(
    result.pieces.map((piece) => textSelectionContent(piece.content)).join(""),
    payload,
  );
});

Deno.test("chunkRoundSources splits large whole JSON arrays on top-level entry boundaries", async () => {
  const payload = JSON.stringify(
    Array.from({ length: 2_000 }, (_, index) => ({
      path: `src/module_${index}.clj`,
      namespace: `metabase.module.${index}`,
      hits: [index, index + 1],
    })),
  );
  const source: RoundSource = {
    sourceId: "json_large",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], keepWholeClients);

  assert(result.pieces.length > 1);
  assert(result.pieces.every((piece) => piece.selector.kind === "text_spans"));
  assert(result.pieces.every((piece) => {
    const content = piece.content;
    return Boolean(
      content &&
        typeof content === "object" &&
        !Array.isArray(content) &&
        (content as Record<string, unknown>).kind === "text_spans",
    );
  }));
});

Deno.test("chunkRoundSources does not treat JSON array prefixes as whole JSON arrays", async () => {
  const payload = `${
    JSON.stringify(
      Array.from({ length: 5_000 }, (_, index) => ({ path: `src/${index}.clj` })),
    )
  }\ntrailing non-json output that must not disappear\n`;
  const source: RoundSource = {
    sourceId: "mixed_json_large",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], keepWholeClients);

  assert(result.pieces.length > 1);
  assertEquals(
    result.pieces.map((piece) => textSelectionContent(piece.content)).join(""),
    payload,
  );
});

Deno.test("chunkRoundSources keeps small whole payloads whole", async () => {
  const source: RoundSource = {
    sourceId: "small",
    sourceKind: "tool",
    toolName: "exec_command",
    payload: "small output\n",
  };

  const result = await chunkRoundSources([source], keepWholeClients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
});

function textSelectionContent(content: unknown): string {
  assert(
    content &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).kind === "text_spans",
  );
  const segments = (content as Record<string, unknown>).segments;
  assert(Array.isArray(segments));
  return segments.map((segment) => {
    assert(segment && typeof segment === "object" && !Array.isArray(segment));
    const text = (segment as Record<string, unknown>).text;
    assert(typeof text === "string");
    return text;
  }).join("");
}
