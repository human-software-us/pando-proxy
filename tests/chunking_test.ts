import { assert, assertEquals } from "@std/assert";

import { chunkRoundSources } from "../src/chunking.ts";
import { updateMemoryForCompletedRound } from "../src/memory_pipeline.ts";
import { emptyMemoryState } from "../src/memory_state.ts";
import type { StructuredClients } from "../src/structured_model.ts";
import type { RoundSource } from "../src/tool_results.ts";
import type { SourceChunkBatchResponse } from "../src/working_set_manager.ts";

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
  assert(result.pieces.every((piece) => piece.selector.kind === "chunks"));
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
  assert(result.pieces.every((piece) => piece.selector.kind === "chunks"));
  assert(result.pieces.every((piece) => {
    const content = piece.content;
    return Boolean(
      content &&
        typeof content === "object" &&
        !Array.isArray(content) &&
        (content as Record<string, unknown>).kind === "chunks",
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
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources materializes valid model chunk selectors", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "chunked_user",
          selectors: [{ kind: "chunks", chunks: [{ text: "keep-this" }] }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "chunked_user",
    sourceKind: "user",
    payload: "skip: keep-this; skip",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "chunks", chunks: [{ start: 6, end: 15 }] });
  assertEquals(textSelectionContent(result.pieces[0].content), "keep-this");
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources materializes all exact occurrences of quoted chunk text", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "repeated_user",
          selectors: [{ kind: "chunks", chunks: [{ text: "DUPLICATE=alpha" }] }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "repeated_user",
    sourceKind: "user",
    payload: "DUPLICATE=alpha\nmiddle\nDUPLICATE=alpha",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 2);
  assertEquals(result.pieces.map((piece) => textSelectionContent(piece.content)), [
    "DUPLICATE=alpha",
    "DUPLICATE=alpha",
  ]);
  assertEquals(result.pieces.map((piece) => piece.selector), [
    { kind: "chunks", chunks: [{ start: 0, end: 15 }] },
    { kind: "chunks", chunks: [{ start: 23, end: 38 }] },
  ]);
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources keeps a source whole when quoted model chunk text is missing", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "missing_text",
          selectors: [{ kind: "chunks", chunks: [{ text: "not present" }] }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "missing_text",
    sourceKind: "user",
    payload: "short exact text",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "short exact text");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources keeps a source whole when returned quoted chunks overlap", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "overlap",
          selectors: [{ kind: "chunks", chunks: [{ text: "alpha beta" }, { text: "beta gamma" }] }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "overlap",
    sourceKind: "user",
    payload: "overlapping chunks",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "overlapping chunks");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources keeps a source whole when returned quoted chunk text is empty", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "empty_text",
          selectors: [{ kind: "chunks", chunks: [{ text: "" }] }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "empty_text",
    sourceKind: "user",
    payload: "TOKEN_ALPHA=keep",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "TOKEN_ALPHA=keep");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources keeps sources whole when source_chunk_batch fails after retry", async () => {
  let attempts = 0;
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () => {
      attempts += 1;
      return Promise.reject(new Error("chunk model unavailable"));
    },
  };
  const source: RoundSource = {
    sourceId: "user_1",
    sourceKind: "user",
    payload: "keep this exact text",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(attempts, 2);
  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "keep this exact text");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources keeps sources whole when source_chunk_batch returns malformed selectors", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "tool_1",
          selectors: [{ kind: "not_a_selector" }],
        }],
      } as unknown as SourceChunkBatchResponse),
  };
  const source: RoundSource = {
    sourceId: "tool_1",
    sourceKind: "tool",
    toolName: "exec_command",
    payload: "important output",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "important output");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources keeps a source whole when any returned selector is malformed", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "mixed_bad",
          selectors: [
            { kind: "chunks", chunks: [{ text: "important" }] },
            { kind: "not_a_selector" },
          ],
        }],
      } as unknown as SourceChunkBatchResponse),
  };
  const source: RoundSource = {
    sourceId: "mixed_bad",
    sourceKind: "user",
    payload: "important output that must stay complete",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "important output that must stay complete");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources keeps sources whole when source_chunk_batch duplicates a source id", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [
          {
            sourceId: "duplicate_source",
            selectors: [{ kind: "chunks", chunks: [{ text: "duplicate" }] }],
          },
          {
            sourceId: "duplicate_source",
            selectors: [{ kind: "chunks", chunks: [{ text: "source" }] }],
          },
        ],
      }),
  };
  const source: RoundSource = {
    sourceId: "duplicate_source",
    sourceKind: "user",
    payload: "duplicate source output",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "duplicate source output");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("updateMemoryForCompletedRound keeps new round data when source_chunk_batch fails", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () => Promise.reject(new Error("chunk model unavailable")),
  };

  const result = await updateMemoryForCompletedRound(
    { input: "retain this prompt exactly" },
    emptyMemoryState(),
    {},
    [],
    clients,
  );

  assertEquals(result.changed, true);
  assertEquals(result.memory.pieces.length, 1);
  assertEquals(result.memory.pieces[0].sourceKind, "user");
  assertEquals(result.memory.pieces[0].selector, { kind: "whole" });
  assertEquals(result.memory.activeTask?.pieceIds, [result.memory.pieces[0].id]);
});

function textSelectionContent(content: unknown): string {
  assert(
    content &&
      typeof content === "object" &&
      !Array.isArray(content) &&
      (content as Record<string, unknown>).kind === "chunks",
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
