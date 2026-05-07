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
        chunks: [source.contentText],
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

Deno.test("chunkRoundSources keeps large whole shell output whole", async () => {
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

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, {
    kind: "chunks",
    chunks: [{ start: 0, end: payload.length }],
  });
  assertEquals(textSelectionContent(result.pieces[0].content), payload);
});

Deno.test("chunkRoundSources keeps large whole JSON arrays whole", async () => {
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

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, {
    kind: "chunks",
    chunks: [{ start: 0, end: payload.length }],
  });
  assertEquals(textSelectionContent(result.pieces[0].content), payload);
});

Deno.test("chunkRoundSources keeps mixed large whole output whole", async () => {
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

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, {
    kind: "chunks",
    chunks: [{ start: 0, end: payload.length }],
  });
  assertEquals(textSelectionContent(result.pieces[0].content), payload);
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
  assertEquals(result.pieces[0].selector, { kind: "chunks", chunks: [{ start: 0, end: 13 }] });
  assertEquals(textSelectionContent(result.pieces[0].content), "small output\n");
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources keeps user messages whole without calling source_chunk_batch", async () => {
  let calls = 0;
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () => {
      calls += 1;
      return Promise.resolve({ results: [] });
    },
  };
  const source: RoundSource = {
    sourceId: "user_atomic",
    sourceKind: "user",
    payload: "remember exact block\nALPHA=1\nBETA=2",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(calls, 0);
  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "remember exact block\nALPHA=1\nBETA=2");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources materializes valid verbatim model chunks", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "chunked_user",
          chunks: ["skip:", " keep-this", "; skip"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "chunked_user",
    sourceKind: "assistant",
    payload: "skip: keep-this; skip",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 3);
  assertEquals(result.pieces.map((piece) => textSelectionContent(piece.content)), [
    "skip:",
    " keep-this",
    "; skip",
  ]);
  assertEquals(result.pieces[1].selector, { kind: "chunks", chunks: [{ start: 5, end: 15 }] });
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources keeps verbatim whitespace in model chunks", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "trimmed",
          chunks: ["prefix\n", "  keep this  ", "\n\nsuffix"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "trimmed",
    sourceKind: "assistant",
    payload: "prefix\n  keep this  \n\nsuffix",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.map((piece) => textSelectionContent(piece.content)), [
    "prefix\n",
    "  keep this  ",
    "\n\nsuffix",
  ]);
});

Deno.test("chunkRoundSources allows model chunks to cut around whitespace", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "edge_whitespace",
          chunks: [" \n\t", "alpha", "\n\n", "beta", "\t \n"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "edge_whitespace",
    sourceKind: "assistant",
    payload: " \n\talpha\n\nbeta\t \n",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.map((piece) => textSelectionContent(piece.content)), [
    " \n\t",
    "alpha",
    "\n\n",
    "beta",
    "\t \n",
  ]);
});

Deno.test("chunkRoundSources materializes lossless inter-chunk whitespace", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "inter_chunk_whitespace",
          chunks: ["alpha", "\n\n  ", "beta", "\t\t\n\n", "gamma"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "inter_chunk_whitespace",
    sourceKind: "assistant",
    payload: "alpha\n\n  beta\t\t\n\ngamma",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.map((piece) => textSelectionContent(piece.content)), [
    "alpha",
    "\n\n  ",
    "beta",
    "\t\t\n\n",
    "gamma",
  ]);
});

Deno.test("chunkRoundSources falls back whole when model chunks are lossy", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "meaningful_gap_whitespace",
          chunks: ["alpha", "\n\nomega"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "meaningful_gap_whitespace",
    sourceKind: "tool",
    toolName: "exec_command",
    payload: "alpha\n\n  MISSING_KEEP=1  \n\nomega",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "alpha\n\n  MISSING_KEEP=1  \n\nomega");
});

Deno.test("chunkRoundSources materializes exact payload chunks while preserving wrappers", async () => {
  const payloadLines = [
    "Please remember this exact block and ignore the wrapper.",
    "BEGIN LIVE CHUNK PAYLOAD",
    "API_TOKEN=live-alpha-123",
    "ENDPOINT=/v1/live/chunk",
    "TIMEOUT_MS=12000",
    "END LIVE CHUNK PAYLOAD",
    "Reply done after storing it.",
  ];
  const payload = payloadLines.join("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "exact_block",
          chunks: [
            `${payloadLines[0]}\n${payloadLines[1]}\n`,
            `${payloadLines[2]}\n${payloadLines[3]}\n${payloadLines[4]}`,
            `\n${payloadLines[5]}\n${payloadLines[6]}`,
          ],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "exact_block",
    sourceKind: "assistant",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 3);
  const text = textSelectionContent(result.pieces[1].content);
  assert(text.includes("API_TOKEN=live-alpha-123"));
  assert(text.includes("TIMEOUT_MS=12000"));
  assert(!text.includes("Please remember"));
  assert(!text.includes("Reply done"));
  assert(textSelectionContent(result.pieces[0].content).includes("Please remember"));
  assert(textSelectionContent(result.pieces[2].content).includes("Reply done"));
});

Deno.test("chunkRoundSources materializes JSON array conceptual chunks", async () => {
  const alphaLines = [
    '  {"id": 0, "group": "alpha", "path": "src/alpha/0.ts"},',
    '  {"id": 1, "group": "alpha", "path": "src/alpha/1.ts"},',
    '  {"id": 2, "group": "alpha", "path": "src/alpha/2.ts"},',
  ];
  const betaLines = [
    '  {"id": 3, "group": "beta", "path": "src/beta/3.ts"},',
    '  {"id": 4, "group": "beta", "path": "src/beta/4.ts"},',
    '  {"id": 5, "group": "beta", "path": "src/beta/5.ts"}',
  ];
  const payload = ["[", ...alphaLines, ...betaLines, "]"].join("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "json_array",
          chunks: ["[\n", `${alphaLines.join("\n")}\n`, betaLines.join("\n"), "\n]"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "json_array",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 4);
  assertEquals(textSelectionContent(result.pieces[0].content), "[\n");
  assert(textSelectionContent(result.pieces[1].content).includes('"group": "alpha"'));
  assert(textSelectionContent(result.pieces[2].content).includes('"group": "beta"'));
  assertEquals(textSelectionContent(result.pieces[3].content), "\n]");
});

Deno.test("chunkRoundSources materializes repeated XML elements from verbatim chunks", async () => {
  const payload = [
    "<catalog>",
    "  <item>",
    "    <name>alpha</name>",
    "  </item>",
    "  <item>",
    "    <name>beta</name>",
    "    <body>KEEP_XML_BETA</body>",
    "  </item>",
    "  <item>",
    "    <name>gamma</name>",
    "    <body>KEEP_XML_GAMMA</body>",
    "  </item>",
    "</catalog>",
  ].join("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "xml_repeated",
          chunks: [
            "<catalog>\n",
            "  <item>\n    <name>alpha</name>\n  </item>",
            "\n  <item>\n    <name>beta</name>\n    <body>KEEP_XML_BETA</body>\n  </item>",
            "\n  <item>\n    <name>gamma</name>\n    <body>KEEP_XML_GAMMA</body>\n  </item>",
            "\n</catalog>",
          ],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "xml_repeated",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 5);
  assertEquals(textSelectionContent(result.pieces[0].content), "<catalog>\n");
  assert(textSelectionContent(result.pieces[2].content).includes("KEEP_XML_BETA"));
  assert(textSelectionContent(result.pieces[3].content).includes("KEEP_XML_GAMMA"));
  assertEquals(textSelectionContent(result.pieces[4].content), "\n</catalog>");
});

Deno.test("chunkRoundSources materializes rg output chunks by path area", async () => {
  const apiLines = [
    "src/api/users.ts:12:export function createUser",
    "src/api/users.ts:48:export function deleteUser",
    "src/api/projects.ts:8:export function createProject",
  ];
  const searchLines = [
    "src/search/index.ts:21:export function searchUsers",
    "src/search/ranking.ts:10:export function rankResults",
  ];
  const testLines = [
    "tests/api/users_test.ts:14:Deno.test('createUser persists')",
    "tests/api/users_test.ts:32:Deno.test('deleteUser removes')",
  ];
  const payload = [...apiLines, ...searchLines, ...testLines].join("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "rg_output",
          chunks: [
            `${apiLines.join("\n")}\n`,
            `${searchLines.join("\n")}\n`,
            testLines.join("\n"),
          ],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "rg_output",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 3);
  assert(textSelectionContent(result.pieces[0].content).includes("src/api/users.ts"));
  assert(textSelectionContent(result.pieces[1].content).includes("src/search/index.ts"));
  assert(textSelectionContent(result.pieces[2].content).includes("tests/api/users_test.ts"));
});

Deno.test("chunkRoundSources materializes markdown section chunks", async () => {
  const install = [
    "## Install",
    "Install step 0: run setup.",
    "Install step 1: verify dependency.",
  ].join("\n");
  const configure = [
    "## Configure",
    "Configure step 0: set LIVE_CHUNK=true.",
    "Configure step 1: reload shell.",
  ].join("\n");
  const verify = [
    "## Verify",
    "Verify step 0: inspect output.",
    "Verify step 1: check boundaries.",
  ].join("\n");
  const payload = ["# Live Chunking Guide", install, configure, verify].join("\n\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "markdown_sections",
          chunks: [
            "# Live Chunking Guide",
            `\n\n${install}`,
            `\n\n${configure}`,
            `\n\n${verify}`,
          ],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "markdown_sections",
    sourceKind: "assistant",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 4);
  assertEquals(textSelectionContent(result.pieces[0].content), "# Live Chunking Guide");
  assertEquals(textSelectionContent(result.pieces[1].content), `\n\n${install}`);
  assertEquals(textSelectionContent(result.pieces[2].content), `\n\n${configure}`);
  assertEquals(textSelectionContent(result.pieces[3].content), `\n\n${verify}`);
});

Deno.test("chunkRoundSources materializes repeated verbatim chunks", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "repeated_user",
          chunks: ["DUPLICATE=alpha", "\nmiddle\n", "DUPLICATE=alpha"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "repeated_user",
    sourceKind: "assistant",
    payload: "DUPLICATE=alpha\nmiddle\nDUPLICATE=alpha",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 3);
  assertEquals(result.pieces.map((piece) => textSelectionContent(piece.content)), [
    "DUPLICATE=alpha",
    "\nmiddle\n",
    "DUPLICATE=alpha",
  ]);
  assertEquals(result.pieces.map((piece) => piece.selector), [
    { kind: "chunks", chunks: [{ start: 0, end: 15 }] },
    { kind: "chunks", chunks: [{ start: 15, end: 23 }] },
    { kind: "chunks", chunks: [{ start: 23, end: 38 }] },
  ]);
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources keeps a source whole when model chunks are not lossless", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "missing_text",
          chunks: ["not present"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "missing_text",
    sourceKind: "assistant",
    payload: "short exact text",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "short exact text");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources keeps a source whole when returned chunks are out of order", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "overlap",
          chunks: ["gamma", " beta ", "alpha"],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "overlap",
    sourceKind: "assistant",
    payload: "alpha beta gamma",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "alpha beta gamma");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources ignores empty chunks when materializing lossless output", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "empty_text",
          chunks: ["", "TOKEN_ALPHA=keep", ""],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "empty_text",
    sourceKind: "assistant",
    payload: "TOKEN_ALPHA=keep",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "chunks", chunks: [{ start: 0, end: 16 }] });
  assertEquals(textSelectionContent(result.pieces[0].content), "TOKEN_ALPHA=keep");
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources materializes exact XML item chunks", async () => {
  const payload = [
    "<catalog>",
    '  <item id="1">',
    "    <name>alpha</name>",
    "    <body>IGNORE</body>",
    "  </item>",
    '  <item id="2">',
    "    <name>beta</name>",
    "    <body>KEEP_XML_BETA</body>",
    "  </item>",
    '  <item id="3">',
    "    <name>gamma</name>",
    "    <body>KEEP_XML_GAMMA</body>",
    "  </item>",
    "</catalog>",
  ].join("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "xml_items",
          chunks: [
            '<catalog>\n  <item id="1">\n    <name>alpha</name>\n    <body>IGNORE</body>\n  </item>\n',
            '  <item id="2">\n    <name>beta</name>\n    <body>KEEP_XML_BETA</body>\n  </item>',
            '\n  <item id="3">\n    <name>gamma</name>\n    <body>KEEP_XML_GAMMA</body>\n  </item>',
            "\n</catalog>",
          ],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "xml_items",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 4);
  assert(textSelectionContent(result.pieces[0].content).includes("IGNORE"));
  assert(textSelectionContent(result.pieces[1].content).includes("KEEP_XML_BETA"));
  assert(textSelectionContent(result.pieces[2].content).includes("KEEP_XML_GAMMA"));
  assertEquals(textSelectionContent(result.pieces[3].content), "\n</catalog>");
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources keeps XML whole when boundaries do not resolve", async () => {
  const payload = [
    "<catalog>",
    '  <item id="1">',
    "    <body>KEEP_XML_ALPHA xml-body xml-body</body>",
    "  </item>",
    "</catalog>",
  ].join("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "xml_not_exact",
          chunks: ['<item id="99">'],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "xml_not_exact",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, payload);
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources materializes chunk groups from many item lists", async () => {
  const left = Array.from(
    { length: 8 },
    (_, index) => `record ${index} | group=left | path=src/left/${index}.ts`,
  ).join("\n");
  const right = Array.from(
    { length: 8 },
    (_, index) => `record ${index + 8} | group=right | path=src/right/${index + 8}.ts`,
  ).join("\n");
  const payload = `${left}\n${right}`;
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "many_items",
          chunks: [`${leftLines.join("\n")}\n`, rightLines.join("\n")],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "many_items",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 2);
  assert(textSelectionContent(result.pieces[0].content).includes("group=left"));
  assert(textSelectionContent(result.pieces[1].content).includes("group=right"));
});

Deno.test("chunkRoundSources materializes random separator sections", async () => {
  const sectionB = "SECTION B\nBETA_KEEP=42";
  const payload = [
    "intro wrapper",
    "--==PANDO_SPLIT_17==--",
    "SECTION A",
    "alpha detail",
    "--==PANDO_SPLIT_17==--",
    sectionB,
    "--==PANDO_SPLIT_17==--",
    "SECTION C",
    "gamma detail",
  ].join("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "separator_sections",
          chunks: [
            [
              "intro wrapper",
              "--==PANDO_SPLIT_17==--",
              "SECTION A",
              "alpha detail",
              "--==PANDO_SPLIT_17==--",
            ].join("\n") + "\n",
            sectionB,
            "\n--==PANDO_SPLIT_17==--\nSECTION C\ngamma detail",
          ],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "separator_sections",
    sourceKind: "assistant",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 3);
  assert(textSelectionContent(result.pieces[0].content).includes("SECTION A"));
  assertEquals(textSelectionContent(result.pieces[1].content), sectionB);
  assert(textSelectionContent(result.pieces[2].content).includes("SECTION C"));
});

Deno.test("chunkRoundSources materializes large log failure chunks", async () => {
  const passBlock = [
    "running test_ok",
    "ok test_ok",
    ...Array.from({ length: 4 }, (_, index) => `ok log ${index}`),
  ].join("\n");
  const failAlpha = [
    "running test_alpha",
    "FAILED test_alpha",
    "AssertionError: expected alpha",
    "  at tests/alpha_test.ts:18:7",
    ...Array.from({ length: 12 }, (_, index) => `alpha log ${index}: detail detail detail`),
  ].join("\n");
  const failBeta = [
    "running test_beta",
    "FAILED test_beta",
    "TypeError: beta missing",
    "  at tests/beta_test.ts:9:3",
    ...Array.from({ length: 12 }, (_, index) => `beta log ${index}: detail detail detail`),
  ].join("\n");
  const payload = [passBlock, failAlpha, failBeta].join("\n\n");
  const failAlphaLines = failAlpha.split("\n");
  const failBetaLines = failBeta.split("\n");
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "large_log",
          chunks: [
            `${passBlock}\n\n`,
            `${failAlphaLines.join("\n")}\n\n`,
            failBetaLines.join("\n"),
          ],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "large_log",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 3);
  assert(textSelectionContent(result.pieces[0].content).includes("running test_ok"));
  assert(textSelectionContent(result.pieces[1].content).includes("FAILED test_alpha"));
  assert(textSelectionContent(result.pieces[2].content).includes("FAILED test_beta"));
});

Deno.test("chunkRoundSources keeps image-like opaque payloads whole when the model chooses whole", async () => {
  const payload = JSON.stringify(
    {
      type: "image_result",
      mime: "image/png",
      metadata: { keep: "IMAGE_META_KEEP" },
      data: `iVBORw0KGgo${"A1b2C3d4E5f6".repeat(100)}`,
    },
    null,
    2,
  );
  const source: RoundSource = {
    sourceId: "image_like",
    sourceKind: "tool",
    toolName: "exec_command",
    payload,
  };

  const result = await chunkRoundSources([source], keepWholeClients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, {
    kind: "chunks",
    chunks: [{ start: 0, end: payload.length }],
  });
  assertEquals(textSelectionContent(result.pieces[0].content), payload);
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
    sourceId: "tool_1",
    sourceKind: "tool",
    toolName: "exec_command",
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

Deno.test("chunkRoundSources keeps sources whole when source_chunk_batch returns malformed chunks", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "tool_1",
          chunks: [{ kind: "not_a_chunk" }],
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

Deno.test("chunkRoundSources keeps a source whole when any returned chunk is malformed", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "mixed_bad",
          chunks: ["important output", { kind: "not_a_chunk" }],
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
            chunks: ["duplicate source output"],
          },
          {
            sourceId: "duplicate_source",
            chunks: ["duplicate source output"],
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
