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
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, payload);
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
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, payload);
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
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, payload);
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
          selectors: [{
            kind: "chunks",
            chunks: [{ startText: "keep-this", endText: "keep-this" }],
          }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "chunked_user",
    sourceKind: "user",
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

Deno.test("chunkRoundSources trims chunk edges and keeps uncovered text", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "trimmed",
          selectors: [{
            kind: "chunks",
            chunks: [{ startText: "  keep this  ", endText: "  keep this  " }],
          }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "trimmed",
    sourceKind: "user",
    payload: "prefix\n  keep this  \n\nsuffix",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.map((piece) => textSelectionContent(piece.content)), [
    "prefix",
    "\n  keep this",
    "  \n\nsuffix",
  ]);
  assertEquals(result.pieces.map((piece) => trimmedTextSelectionContent(piece.content)), [
    "prefix",
    "keep this",
    "suffix",
  ]);
});

Deno.test("chunkRoundSources materializes exact payload block boundaries and repairs uncovered wrapper text", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "exact_block",
          selectors: [{
            kind: "chunks",
            chunks: [{ startText: "API_TOKEN=live-alpha-123", endText: "TIMEOUT_MS=12000" }],
          }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "exact_block",
    sourceKind: "user",
    payload: [
      "Please remember this exact block and ignore the wrapper.",
      "BEGIN LIVE CHUNK PAYLOAD",
      "API_TOKEN=live-alpha-123",
      "ENDPOINT=/v1/live/chunk",
      "TIMEOUT_MS=12000",
      "END LIVE CHUNK PAYLOAD",
      "Reply done after storing it.",
    ].join("\n"),
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

Deno.test("chunkRoundSources materializes JSON array conceptual boundary groups", async () => {
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
          selectors: [{
            kind: "chunks",
            chunks: [
              { startText: alphaLines[0], endText: alphaLines.at(-1)! },
              { startText: betaLines[0], endText: betaLines.at(-1)! },
            ],
          }],
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
  assertEquals(textSelectionContent(result.pieces[0].content), "[");
  assert(textSelectionContent(result.pieces[1].content).includes('"group": "alpha"'));
  assert(textSelectionContent(result.pieces[2].content).includes('"group": "beta"'));
  assertEquals(textSelectionContent(result.pieces[3].content), "\n]");
});

Deno.test("chunkRoundSources materializes repeated XML elements from one boundary pair", async () => {
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
          selectors: [{
            kind: "chunks",
            chunks: [{ startText: "  <item>", endText: "  </item>" }],
          }],
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
  assertEquals(textSelectionContent(result.pieces[0].content), "<catalog>");
  assert(textSelectionContent(result.pieces[2].content).includes("KEEP_XML_BETA"));
  assert(textSelectionContent(result.pieces[3].content).includes("KEEP_XML_GAMMA"));
  assertEquals(textSelectionContent(result.pieces[4].content), "\n</catalog>");
});

Deno.test("chunkRoundSources materializes rg output boundary groups by path area", async () => {
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
          selectors: [{
            kind: "chunks",
            chunks: [
              { startText: apiLines[0], endText: apiLines.at(-1)! },
              { startText: searchLines[0], endText: searchLines.at(-1)! },
              { startText: testLines[0], endText: testLines.at(-1)! },
            ],
          }],
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

Deno.test("chunkRoundSources materializes markdown section boundary chunks", async () => {
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
          selectors: [{
            kind: "chunks",
            chunks: [
              { startText: "## Install", endText: "Install step 1: verify dependency." },
              { startText: "## Configure", endText: "Configure step 1: reload shell." },
              { startText: "## Verify", endText: "Verify step 1: check boundaries." },
            ],
          }],
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

Deno.test("chunkRoundSources materializes all repeated boundary pair occurrences", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "repeated_user",
          selectors: [{
            kind: "chunks",
            chunks: [{ startText: "DUPLICATE=alpha", endText: "DUPLICATE=alpha" }],
          }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "repeated_user",
    sourceKind: "user",
    payload: "DUPLICATE=alpha\nmiddle\nDUPLICATE=alpha",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 3);
  assertEquals(result.pieces.map((piece) => textSelectionContent(piece.content)), [
    "DUPLICATE=alpha",
    "\nmiddle",
    "\nDUPLICATE=alpha",
  ]);
  assertEquals(result.pieces.map((piece) => piece.selector), [
    { kind: "chunks", chunks: [{ start: 0, end: 15 }] },
    { kind: "chunks", chunks: [{ start: 15, end: 22 }] },
    { kind: "chunks", chunks: [{ start: 22, end: 38 }] },
  ]);
  assertEquals(result.chunkedViaModelSourceCount, 1);
  assertEquals(result.chunkedDeterministicSourceCount, 0);
});

Deno.test("chunkRoundSources keeps a source whole when model boundary text is missing", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "missing_text",
          selectors: [{
            kind: "chunks",
            chunks: [{ startText: "not present", endText: "not present" }],
          }],
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

Deno.test("chunkRoundSources keeps a source whole when returned boundary chunks overlap", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "overlap",
          selectors: [{
            kind: "chunks",
            chunks: [
              { startText: "alpha", endText: "beta" },
              { startText: "beta", endText: "gamma" },
            ],
          }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "overlap",
    sourceKind: "user",
    payload: "alpha beta gamma",
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 1);
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, "alpha beta gamma");
  assertEquals(result.chunkedViaModelSourceCount, 0);
  assertEquals(result.chunkedDeterministicSourceCount, 1);
});

Deno.test("chunkRoundSources keeps a source whole when returned boundary text is empty", async () => {
  const clients: StructuredClients = {
    ...keepWholeClients,
    sourceChunkBatch: () =>
      Promise.resolve({
        results: [{
          sourceId: "empty_text",
          selectors: [{ kind: "chunks", chunks: [{ startText: "", endText: "TOKEN_ALPHA=keep" }] }],
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

Deno.test("chunkRoundSources materializes exact XML item boundary chunks", async () => {
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
          selectors: [{
            kind: "chunks",
            chunks: [
              { startText: '  <item id="2">', endText: "  </item>" },
              { startText: '  <item id="3">', endText: "  </item>" },
            ],
          }],
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
          selectors: [{
            kind: "chunks",
            chunks: [{
              startText: '<item id="99">',
              endText: "  </item>",
            }],
          }],
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

Deno.test("chunkRoundSources materializes boundary groups from many item lists", async () => {
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
          selectors: [{
            kind: "chunks",
            chunks: [
              { startText: leftLines[0], endText: leftLines.at(-1)! },
              { startText: rightLines[0], endText: rightLines.at(-1)! },
            ],
          }],
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
          selectors: [{
            kind: "chunks",
            chunks: [{ startText: "SECTION B", endText: "BETA_KEEP=42" }],
          }],
        }],
      }),
  };
  const source: RoundSource = {
    sourceId: "separator_sections",
    sourceKind: "user",
    payload,
  };

  const result = await chunkRoundSources([source], clients);

  assertEquals(result.pieces.length, 3);
  assert(textSelectionContent(result.pieces[0].content).includes("SECTION A"));
  assertEquals(textSelectionContent(result.pieces[1].content), `\n${sectionB}`);
  assert(textSelectionContent(result.pieces[2].content).includes("SECTION C"));
});

Deno.test("chunkRoundSources materializes large log failure boundary blocks", async () => {
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
          selectors: [{
            kind: "chunks",
            chunks: [
              { startText: failAlphaLines[0], endText: failAlphaLines.at(-1)! },
              { startText: failBetaLines[0], endText: failBetaLines.at(-1)! },
            ],
          }],
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
  assertEquals(result.pieces[0].selector, { kind: "whole" });
  assertEquals(result.pieces[0].content, payload);
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
            selectors: [{
              kind: "chunks",
              chunks: [{ startText: "duplicate", endText: "duplicate" }],
            }],
          },
          {
            sourceId: "duplicate_source",
            selectors: [{ kind: "chunks", chunks: [{ startText: "source", endText: "source" }] }],
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

function trimmedTextSelectionContent(content: unknown): string {
  return textSelectionContent(content).trim();
}
