import { assert } from "@std/assert";

import { chunkRoundSources } from "../src/chunking.ts";
import {
  DEFAULT_OVERFLOW_STRUCTURED_CONTEXT_WINDOW,
  DEFAULT_OVERFLOW_STRUCTURED_MODEL,
  DEFAULT_SMALL_STRUCTURED_CONTEXT_WINDOW,
  DEFAULT_SMALL_STRUCTURED_MODEL,
  type ProxyConfig,
} from "../src/config.ts";
import type { PieceDraft } from "../src/memory_state.ts";
import { renderTextSelection } from "../src/source_selectors.ts";
import { createStructuredClients } from "../src/structured_model.ts";
import type { RoundSource } from "../src/tool_results.ts";

const runLiveChunkTests = Deno.env.get("PANDO_LIVE_LLM_CHUNK_TESTS") === "1";
const liveApiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
const liveEnabled = runLiveChunkTests && liveApiKey.length > 0;

let liveChunkRun: Promise<{ pieces: PieceDraft[] }> | null = null;

liveChunkTest(
  "live LLM chunking isolates exact user payload blocks and retains wrappers separately",
  async () => {
    const pieces = renderedPieces((await liveResult()).pieces, "exact_block");
    const text = pieces.join("\n");
    const payloadPiece = pieces.find((piece) =>
      piece.includes("API_TOKEN=live-alpha-123") &&
      piece.includes("ENDPOINT=/v1/live/chunk") &&
      piece.includes("TIMEOUT_MS=12000")
    ) ?? "";

    assert(text.includes("API_TOKEN=live-alpha-123"), text);
    assert(text.includes("ENDPOINT=/v1/live/chunk"), text);
    assert(text.includes("TIMEOUT_MS=12000"), text);
    assert(!payloadPiece.includes("Please remember"), payloadPiece);
    assert(!payloadPiece.includes("Reply done"), payloadPiece);
    assert(text.includes("Please remember"), text);
    assert(text.includes("Reply done"), text);
  },
);

liveChunkTest("live LLM chunking splits JSON arrays into multiple retained pieces", async () => {
  const result = await liveResult();
  const pieces = renderedPieces(result.pieces, "json_array");

  assert(pieces.length > 1, diagnostic("json_array", pieces));
  assert(
    pieces.some((piece) => /"group"\s*:\s*"alpha"/.test(piece)),
    diagnostic("json_array", pieces),
  );
  assert(
    pieces.some((piece) => /"group"\s*:\s*"beta"/.test(piece)),
    diagnostic("json_array", pieces),
  );
  assert(
    chunksRespectSafeBoundaries(result.pieces, "json_array"),
    diagnostic("json_array", pieces),
  );
});

liveChunkTest("live LLM chunking splits XML repeated elements on complete elements", async () => {
  const result = await liveResult();
  const pieces = renderedPieces(result.pieces, "xml_items");

  assert(pieces.length > 1, diagnostic("xml_items", pieces));
  assert(
    pieces.some((piece) => piece.includes('id="beta"') && piece.includes("KEEP_XML_BETA")),
    diagnostic("xml_items", pieces),
  );
  assert(
    pieces.some((piece) => piece.includes('id="gamma"') && piece.includes("KEEP_XML_GAMMA")),
    diagnostic("xml_items", pieces),
  );
  assert(chunksRespectSafeBoundaries(result.pieces, "xml_items"), diagnostic("xml_items", pieces));
});

liveChunkTest("live LLM chunking keeps test log failure blocks together", async () => {
  const result = await liveResult();
  const pieces = renderedPieces(result.pieces, "test_log");

  assert(pieces.length > 1, diagnostic("test_log", pieces));
  assert(
    pieces.some((piece) => piece.includes("test_alpha_flow") && piece.includes("AssertionError")),
    diagnostic("test_log", pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("test_beta_flow") && piece.includes("TypeError")),
    diagnostic("test_log", pieces),
  );
  assert(chunksRespectSafeBoundaries(result.pieces, "test_log"), diagnostic("test_log", pieces));
});

liveChunkTest("live LLM chunking groups rg output by conceptual path areas", async () => {
  const result = await liveResult();
  const pieces = renderedPieces(result.pieces, "rg_output");

  assert(pieces.length > 1, diagnostic("rg_output", pieces));
  assert(
    pieces.some((piece) => piece.includes("src/api/users.ts")),
    diagnostic("rg_output", pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("src/search/index.ts")),
    diagnostic("rg_output", pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("tests/api/users_test.ts")),
    diagnostic("rg_output", pieces),
  );
  assert(chunksRespectSafeBoundaries(result.pieces, "rg_output"), diagnostic("rg_output", pieces));
});

liveChunkTest("live LLM chunking splits large markdown/text by complete sections", async () => {
  const result = await liveResult();
  const pieces = renderedPieces(result.pieces, "markdown_sections");

  assert(pieces.length > 1, diagnostic("markdown_sections", pieces));
  assert(
    pieces.some((piece) => piece.includes("## Install")),
    diagnostic("markdown_sections", pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("## Configure")),
    diagnostic("markdown_sections", pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("## Verify")),
    diagnostic("markdown_sections", pieces),
  );
  assert(
    chunksRespectSafeBoundaries(result.pieces, "markdown_sections"),
    diagnostic("markdown_sections", pieces),
  );
});

liveChunkTest(
  "live LLM chunking passes conceptual split checks for most large content types",
  async () => {
    const result = await liveResult();
    const checks = [
      conceptualCheck(result.pieces, "json_array", ['"group"', "src/alpha/", "src/beta/"]),
      conceptualCheck(result.pieces, "xml_items", ['id="beta"', "KEEP_XML_BETA", "KEEP_XML_GAMMA"]),
      conceptualCheck(result.pieces, "test_log", ["AssertionError", "TypeError"]),
      conceptualCheck(result.pieces, "rg_output", ["src/api/", "src/search/", "tests/api/"]),
      conceptualCheck(result.pieces, "markdown_sections", [
        "## Install",
        "## Configure",
        "## Verify",
      ]),
    ];
    const passCount = checks.filter((check) => check.ok).length;

    assert(passCount >= 3, JSON.stringify(checks));
  },
);

liveChunkTest("live LLM chunking splits very large headed chunks", async () => {
  const source = liveLargeHeadedChunksSource();
  const result = await liveSingleSourceResult(source);
  const pieces = renderedPieces(result.pieces, source.sourceId);

  assert(pieces.length > 1, diagnostic(source.sourceId, pieces));
  assert(
    pieces.some((piece) => piece.includes("LARGE_ALPHA_SENTINEL")),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("LARGE_BETA_SENTINEL")),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    chunksRespectSafeBoundariesForSources(result.pieces, [source]),
    diagnostic(source.sourceId, pieces),
  );
});

liveChunkTest("live LLM chunking splits large prose text by conceptual sections", async () => {
  const source = liveLargeTextSource();
  const result = await liveSingleSourceResult(source);
  const pieces = renderedPieces(result.pieces, source.sourceId);

  assert(pieces.length > 1, diagnostic(source.sourceId, pieces));
  assert(pieces.some((piece) => piece.includes("## Problem")), diagnostic(source.sourceId, pieces));
  assert(
    pieces.some((piece) => piece.includes("## Constraints")),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("## Resolution")),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    chunksRespectSafeBoundariesForSources(result.pieces, [source]),
    diagnostic(source.sourceId, pieces),
  );
});

liveChunkTest("live LLM chunking keeps a large opaque blob whole", async () => {
  const source = liveLargeBlobSource();
  const result = await liveSingleSourceResult(source);
  const pieces = renderedPieces(result.pieces, source.sourceId);

  assert(pieces.length === 1, diagnostic(source.sourceId, pieces));
  assert(pieces[0].includes("OPAQUE_BLOB_BEGIN"), diagnostic(source.sourceId, pieces));
  assert(pieces[0].includes("OPAQUE_BLOB_END"), diagnostic(source.sourceId, pieces));
});

liveChunkTest("live LLM chunking splits multiple medium delimited blobs", async () => {
  const source = liveMediumBlobsSource();
  const result = await liveSingleSourceResult(source);
  const pieces = renderedPieces(result.pieces, source.sourceId);

  assert(pieces.length > 1, diagnostic(source.sourceId, pieces));
  assert(
    pieces.some((piece) => piece.includes("MEDIUM_BLOB_ALPHA")),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("MEDIUM_BLOB_BETA")),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    pieces.some((piece) => piece.includes("MEDIUM_BLOB_GAMMA")),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    chunksRespectSafeBoundariesForSources(result.pieces, [source]),
    diagnostic(source.sourceId, pieces),
  );
});

liveChunkTest("live LLM chunking splits big arrays with lots of small items", async () => {
  const source = liveManySmallArrayItemsSource();
  const result = await liveSingleSourceResult(source);
  const pieces = renderedPieces(result.pieces, source.sourceId);

  assert(pieces.length > 1, diagnostic(source.sourceId, pieces));
  assert(
    pieces.some((piece) => piece.includes('"bucket": "north"')),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    pieces.some((piece) => piece.includes('"bucket": "south"')),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    pieces.some((piece) => piece.includes('"bucket": "east"')),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    pieces.some((piece) => piece.includes('"bucket": "west"')),
    diagnostic(source.sourceId, pieces),
  );
  assert(
    chunksRespectSafeBoundariesForSources(result.pieces, [source]),
    diagnostic(source.sourceId, pieces),
  );
});

function liveChunkTest(name: string, fn: () => Promise<void>): void {
  Deno.test({
    name,
    ignore: !liveEnabled,
    fn,
  });
}

async function liveResult(): Promise<{ pieces: PieceDraft[] }> {
  if (!liveChunkRun) {
    liveChunkRun = runLiveChunking();
  }
  return await liveChunkRun;
}

async function runLiveChunking(): Promise<{ pieces: PieceDraft[] }> {
  const model = Deno.env.get("PANDO_LIVE_LLM_CHUNK_MODEL") ?? DEFAULT_SMALL_STRUCTURED_MODEL;
  const clients = createStructuredClients(
    liveProxyConfig(model),
    model,
    `Bearer ${liveApiKey}`,
  );
  return await chunkRoundSources(liveChunkSources(), clients);
}

async function liveSingleSourceResult(source: RoundSource): Promise<{ pieces: PieceDraft[] }> {
  const model = Deno.env.get("PANDO_LIVE_LLM_CHUNK_MODEL") ?? DEFAULT_SMALL_STRUCTURED_MODEL;
  const clients = createStructuredClients(
    liveProxyConfig(model),
    model,
    `Bearer ${liveApiKey}`,
  );
  return await chunkRoundSources([source], clients);
}

function liveProxyConfig(model: string): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: Deno.env.get("PANDO_LIVE_LLM_UPSTREAM_BASE_URL") ??
      "https://api.openai.com/v1",
    apiKey: null,
    smallStructuredModel: model,
    overflowStructuredModel: Deno.env.get("PANDO_LIVE_LLM_CHUNK_OVERFLOW_MODEL") ??
      DEFAULT_OVERFLOW_STRUCTURED_MODEL,
    smallStructuredContextWindow: DEFAULT_SMALL_STRUCTURED_CONTEXT_WINDOW,
    overflowStructuredContextWindow: DEFAULT_OVERFLOW_STRUCTURED_CONTEXT_WINDOW,
    modelTimeoutMs: 60_000,
    stateDir: "/tmp",
    memoryEnabled: true,
    logFile: null,
    codexAutoCompactTokenLimit: 280_000,
  };
}

function conceptualCheck(
  pieces: PieceDraft[],
  sourceId: string,
  requiredFragments: string[],
): { name: string; ok: boolean; pieceCount: number } {
  const rendered = renderedPieces(pieces, sourceId);
  return {
    name: sourceId,
    pieceCount: rendered.length,
    ok: rendered.length > 1 &&
      requiredFragments.every((fragment) => rendered.some((piece) => piece.includes(fragment))) &&
      chunksRespectSafeBoundaries(pieces, sourceId),
  };
}

function chunksRespectSafeBoundaries(pieces: PieceDraft[], sourceId: string): boolean {
  return chunksRespectSafeBoundariesForSources(pieces, liveChunkSources(), sourceId);
}

function chunksRespectSafeBoundariesForSources(
  pieces: PieceDraft[],
  sources: RoundSource[],
  sourceId?: string,
): boolean {
  return pieces
    .filter((piece) => sourceId === undefined || piece.sourceId === sourceId)
    .every((piece) => {
      if (piece.selector.kind !== "chunks") {
        return true;
      }
      const source = sources.find((candidate) => candidate.sourceId === piece.sourceId);
      assert(source, `missing live source ${piece.sourceId}`);
      assert(typeof source.payload === "string", `source ${piece.sourceId} must be string payload`);
      const sourceText = source.payload;
      return piece.selector.chunks.every((span) =>
        isSafeBoundary(sourceText, span.start) && isSafeBoundary(sourceText, span.end)
      );
    });
}

function isSafeBoundary(text: string, offset: number): boolean {
  if (offset === 0 || offset === text.length) {
    return true;
  }
  const before = text[offset - 1] ?? "";
  const after = text[offset] ?? "";
  return /\s/.test(before) || /\s/.test(after) || /[()[\]{}<>,;:|]/.test(before) ||
    /[()[\]{}<>,;:|]/.test(after);
}

function renderedPieces(pieces: PieceDraft[], sourceId: string): string[] {
  return pieces
    .filter((piece) => piece.sourceId === sourceId)
    .map((piece) => {
      if (typeof piece.content === "string") {
        return piece.content;
      }
      if (
        piece.content &&
        typeof piece.content === "object" &&
        !Array.isArray(piece.content) &&
        (piece.content as Record<string, unknown>).kind === "chunks"
      ) {
        return renderTextSelection(piece.content as Parameters<typeof renderTextSelection>[0]);
      }
      return JSON.stringify(piece.content);
    });
}

function diagnostic(sourceId: string, pieces: string[]): string {
  return JSON.stringify({
    sourceId,
    pieceCount: pieces.length,
    previews: pieces.map((piece) => piece.slice(0, 240)),
  });
}

function liveChunkSources(): RoundSource[] {
  return [
    {
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
    },
    {
      sourceId: "json_array",
      sourceKind: "tool",
      toolName: "exec_command",
      payload: JSON.stringify(
        Array.from({ length: 80 }, (_, index) => ({
          id: index,
          group: index < 40 ? "alpha" : "beta",
          path: index < 40 ? `src/alpha/${index}.ts` : `src/beta/${index}.ts`,
          status: index % 3 === 0 ? "changed" : "stable",
        })),
        null,
        2,
      ),
    },
    {
      sourceId: "xml_items",
      sourceKind: "tool",
      toolName: "exec_command",
      payload: [
        "<catalog>",
        '  <item id="alpha">',
        "    <name>alpha</name>",
        `    <body>${"ignore alpha ".repeat(60)}</body>`,
        "  </item>",
        '  <item id="beta">',
        "    <name>beta</name>",
        `    <body>KEEP_XML_BETA ${"beta details ".repeat(60)}</body>`,
        "  </item>",
        '  <item id="gamma">',
        "    <name>gamma</name>",
        `    <body>KEEP_XML_GAMMA ${"gamma details ".repeat(60)}</body>`,
        "  </item>",
        "</catalog>",
      ].join("\n"),
    },
    {
      sourceId: "test_log",
      sourceKind: "tool",
      toolName: "exec_command",
      payload: [
        "running test_alpha_flow",
        "FAILED test_alpha_flow",
        "AssertionError: expected alpha total to equal 42",
        "  at tests/alpha_test.ts:18:7",
        "  received: 41",
        "",
        "running test_beta_flow",
        "FAILED test_beta_flow",
        "TypeError: cannot read properties of undefined",
        "  at src/beta.ts:55:11",
        "  at tests/beta_test.ts:22:5",
        "",
        "running test_gamma_flow",
        "ok test_gamma_flow",
      ].join("\n"),
    },
    {
      sourceId: "rg_output",
      sourceKind: "tool",
      toolName: "exec_command",
      payload: [
        "src/api/users.ts:12:export function createUser",
        "src/api/users.ts:48:export function deleteUser",
        "src/api/projects.ts:8:export function createProject",
        "src/search/index.ts:21:export function searchUsers",
        "src/search/ranking.ts:10:export function rankResults",
        "tests/api/users_test.ts:14:Deno.test('createUser persists')",
        "tests/api/users_test.ts:32:Deno.test('deleteUser removes')",
        "tests/search/index_test.ts:9:Deno.test('searchUsers ranks')",
      ].join("\n"),
    },
    {
      sourceId: "markdown_sections",
      sourceKind: "assistant",
      payload: [
        "# Live Chunking Guide",
        "",
        "## Install",
        ...Array.from(
          { length: 18 },
          (_, index) => `Install step ${index}: run setup command and verify dependency ${index}.`,
        ),
        "",
        "## Configure",
        ...Array.from(
          { length: 18 },
          (_, index) =>
            `Configure step ${index}: set environment variable LIVE_CHUNK_${index}=enabled.`,
        ),
        "",
        "## Verify",
        ...Array.from(
          { length: 18 },
          (_, index) => `Verify step ${index}: inspect chunk group ${index} for section integrity.`,
        ),
      ].join("\n"),
    },
  ];
}

function liveLargeHeadedChunksSource(): RoundSource {
  return {
    sourceId: "large_headed_chunks",
    sourceKind: "tool",
    toolName: "exec_command",
    payload: [
      "# Large Headed Chunks",
      "## Alpha Large Chunk",
      "LARGE_ALPHA_SENTINEL",
      ...Array.from(
        { length: 260 },
        (_, index) =>
          `alpha large detail ${index}: dependency graph observation ${
            index % 17
          } should stay with alpha.`,
      ),
      "## Beta Large Chunk",
      "LARGE_BETA_SENTINEL",
      ...Array.from(
        { length: 260 },
        (_, index) =>
          `beta large detail ${index}: execution log observation ${
            index % 19
          } should stay with beta.`,
      ),
      "## Gamma Large Chunk",
      "LARGE_GAMMA_SENTINEL",
      ...Array.from(
        { length: 260 },
        (_, index) =>
          `gamma large detail ${index}: verification note ${index % 23} should stay with gamma.`,
      ),
    ].join("\n"),
  };
}

function liveLargeTextSource(): RoundSource {
  return {
    sourceId: "large_prose_text",
    sourceKind: "assistant",
    payload: [
      "# Incident Analysis",
      "",
      "## Problem",
      ...Array.from(
        { length: 220 },
        (_, index) =>
          `Problem paragraph ${index}: service latency changed after queue saturation and exact marker PROBLEM_${index}.`,
      ),
      "",
      "## Constraints",
      ...Array.from(
        { length: 220 },
        (_, index) =>
          `Constraint paragraph ${index}: memory retention must preserve evidence marker CONSTRAINT_${index}.`,
      ),
      "",
      "## Resolution",
      ...Array.from(
        { length: 220 },
        (_, index) =>
          `Resolution paragraph ${index}: apply the bounded fix and verify marker RESOLUTION_${index}.`,
      ),
    ].join("\n"),
  };
}

function liveLargeBlobSource(): RoundSource {
  return {
    sourceId: "large_opaque_blob",
    sourceKind: "tool",
    toolName: "exec_command",
    payload: [
      "OPAQUE_BLOB_BEGIN",
      "mime=application/octet-stream",
      "encoding=base64",
      "data:",
      ...Array.from(
        { length: 260 },
        (_, index) => `BLOB_LINE_${index}:${"A1b2C3d4E5f6G7h8I9j0".repeat(12)}`,
      ),
      "OPAQUE_BLOB_END",
    ].join("\n"),
  };
}

function liveMediumBlobsSource(): RoundSource {
  return {
    sourceId: "medium_delimited_blobs",
    sourceKind: "tool",
    toolName: "exec_command",
    payload: ["ALPHA", "BETA", "GAMMA"].flatMap((name) => [
      `BEGIN MEDIUM_BLOB_${name}`,
      `metadata=${name.toLowerCase()}`,
      ...Array.from(
        { length: 80 },
        (_, index) => `${name}_PAYLOAD_${index}:${"0123456789abcdef".repeat(8)}`,
      ),
      `END MEDIUM_BLOB_${name}`,
    ]).join("\n"),
  };
}

function liveManySmallArrayItemsSource(): RoundSource {
  const buckets = ["north", "south", "east", "west"];
  return {
    sourceId: "many_small_array_items",
    sourceKind: "tool",
    toolName: "exec_command",
    payload: JSON.stringify(
      Array.from({ length: 240 }, (_, index) => ({
        id: index,
        bucket: buckets[Math.floor(index / 60)]!,
        path: `src/${buckets[Math.floor(index / 60)]}/item_${index}.ts`,
        value: `small-${index}`,
      })),
      null,
      2,
    ),
  };
}
