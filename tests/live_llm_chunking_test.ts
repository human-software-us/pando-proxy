import { assert } from "@std/assert";

import { chunkRoundSources } from "../src/chunking.ts";
import type { ProxyConfig } from "../src/config.ts";
import type { PieceDraft } from "../src/memory_state.ts";
import { renderTextSelection } from "../src/source_selectors.ts";
import { createStructuredClients } from "../src/structured_model.ts";
import type { RoundSource } from "../src/tool_results.ts";

const runLiveChunkTests = Deno.env.get("PANDO_LIVE_LLM_CHUNK_TESTS") === "1";
const liveApiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
const liveEnabled = runLiveChunkTests && liveApiKey.length > 0;

let liveChunkRun: Promise<{ pieces: PieceDraft[] }> | null = null;

liveChunkTest(
  "live LLM chunking selects exact user payload blocks without wrapper text",
  async () => {
    const pieces = renderedPieces((await liveResult()).pieces, "exact_block");
    const text = pieces.join("\n");

    assert(text.includes("API_TOKEN=live-alpha-123"), text);
    assert(text.includes("ENDPOINT=/v1/live/chunk"), text);
    assert(text.includes("TIMEOUT_MS=12000"), text);
    assert(!text.includes("Please remember"), text);
    assert(!text.includes("Reply done"), text);
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
  const model = Deno.env.get("PANDO_LIVE_LLM_CHUNK_MODEL") ?? "gpt-5.4";
  const clients = createStructuredClients(
    liveProxyConfig(model),
    model,
    `Bearer ${liveApiKey}`,
  );
  return await chunkRoundSources(liveChunkSources(), clients);
}

function liveProxyConfig(model: string): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    upstreamBaseUrl: Deno.env.get("PANDO_LIVE_LLM_UPSTREAM_BASE_URL") ??
      "https://api.openai.com/v1",
    apiKey: null,
    smallStructuredModel: model,
    overflowStructuredModel: Deno.env.get("PANDO_LIVE_LLM_CHUNK_OVERFLOW_MODEL") ?? "gpt-5.4",
    smallStructuredContextWindow: 272_000,
    overflowStructuredContextWindow: 1_000_000,
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
  return pieces
    .filter((piece) => piece.sourceId === sourceId)
    .every((piece) => {
      if (piece.selector.kind !== "chunks") {
        return true;
      }
      const sourceText = sourceTextById(piece.sourceId);
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

function sourceTextById(sourceId: string): string {
  const source = liveChunkSources().find((candidate) => candidate.sourceId === sourceId);
  assert(source, `missing live source ${sourceId}`);
  assert(typeof source.payload === "string", `source ${sourceId} must be string payload`);
  return source.payload;
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
