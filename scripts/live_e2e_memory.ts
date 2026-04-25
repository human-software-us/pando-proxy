#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

import { createHandler } from "../src/server.ts";
import { type ProxyConfig } from "../src/config.ts";
import { SessionStore } from "../src/store.ts";

type RoundSpec = {
  prompt: string;
  expectText?: string | RegExp;
  rejectText?: string | RegExp;
  afterRound?: (ctx: ScenarioContext, roundIndex: number, text: string) => Promise<void> | void;
};

type Scenario = {
  name: string;
  description: string;
  config?: Partial<ProxyConfig>;
  rounds: RoundSpec[];
  afterScenario?: (ctx: ScenarioContext) => Promise<void> | void;
};

type ScenarioContext = {
  scenario: Scenario;
  sessionKey: string;
  tokenMap: Record<string, string>;
  tempDir: string;
  logFile: string;
  stateDir: string;
  store: SessionStore;
  readLogs: () => Promise<Array<Record<string, unknown>>>;
  readState: () => Promise<Record<string, unknown>>;
  exactPayloadTexts: () => Promise<string[]>;
};

const MODEL = "gpt-5.4";

async function main(): Promise<void> {
  const authHeader = await resolveAuthHeader();
  const selectedNames = parseSelectedScenarioNames(Deno.args);
  const scenarios = buildScenarios().filter((scenario) =>
    selectedNames.length === 0 || selectedNames.includes(scenario.name)
  );
  if (scenarios.length === 0) {
    throw new Error(`No matching scenarios for --only=${selectedNames.join(",")}`);
  }

  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index];
    console.log(`SCENARIO ${index + 1}/${scenarios.length} ${scenario.name}`);
    console.log(`DESCRIPTION ${scenario.description}`);
    await runScenario(scenario, authHeader);
    console.log(`RESULT ${scenario.name} PASS`);
  }

  console.log(`ALL_SCENARIOS_PASS ${scenarios.length}/${scenarios.length}`);
}

async function runScenario(scenario: Scenario, authHeader: string): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: `pando-live-${scenario.name}-` });
  const logFile = `${tempDir}/proxy.jsonl`;
  const stateDir = `${tempDir}/state`;
  const sessionKey = `live-${scenario.name}`;
  const config = testConfig({
    ...scenario.config,
    stateDir,
    logFile,
  });
  const store = new SessionStore(stateDir, config.inlinePieceByteLimit);
  const { handler, awaitIdle } = createHandler(config, store);
  const tokenMap = tokensForScenario(scenario.name);

  const context: ScenarioContext = {
    scenario,
    sessionKey,
    tokenMap,
    tempDir,
    logFile,
    stateDir,
    store,
    readLogs: async () => {
      try {
        return (await Deno.readTextFile(logFile))
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.sessionKey === sessionKey);
      } catch {
        return [];
      }
    },
    readState: async () => {
      return (await store.load(sessionKey)).memory as unknown as Record<string, unknown>;
    },
    exactPayloadTexts: async () => {
      const record = await store.load(sessionKey);
      const exact = await store.getExactPieces(
        sessionKey,
        record.memory.pieces.map((piece) => piece.id),
      );
      return exact.map((piece) =>
        typeof piece.payload === "string" ? piece.payload : JSON.stringify(piece.payload)
      );
    },
  };

  try {
    for (let roundIndex = 0; roundIndex < scenario.rounds.length; roundIndex += 1) {
      const round = scenario.rounds[roundIndex];
      const response = await handler(
        new Request("http://localhost/v1/responses", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: authHeader,
            "x-pando-session-id": sessionKey,
          },
          body: JSON.stringify({
            model: MODEL,
            stream: false,
            instructions: "Follow the user's request exactly. Be concise.",
            input: [{
              id: `msg_user_${roundIndex + 1}`,
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: interpolate(round.prompt, tokenMap) }],
            }],
          }),
        }),
      );

      if (!response.ok) {
        throw new Error(
          `round ${roundIndex + 1} returned HTTP ${response.status}: ${await response.text()}`,
        );
      }

      const body = await response.json();
      const text = responseText(body);
      console.log(`ROUND ${roundIndex + 1} OUTPUT ${JSON.stringify(text)}`);

      await awaitIdle();
      await assertNoMemoryUpdateFailure(context);

      if (round.expectText !== undefined) {
        assertMatches(
          text,
          interpolateExpectation(round.expectText, tokenMap),
          `round ${roundIndex + 1} expectText`,
        );
      }
      if (round.rejectText !== undefined) {
        assertNotMatches(
          text,
          interpolateExpectation(round.rejectText, tokenMap),
          `round ${roundIndex + 1} rejectText`,
        );
      }
      if (round.afterRound) {
        await round.afterRound(context, roundIndex + 1, text);
      }
    }

    if (scenario.afterScenario) {
      await scenario.afterScenario(context);
    }
  } catch (error) {
    console.error(`SCENARIO_FAIL ${scenario.name}`);
    console.error(`STATE_DIR ${stateDir}`);
    console.error(`LOG_FILE ${logFile}`);
    const logs = await context.readLogs();
    const recent = logs.slice(-12);
    console.error(`RECENT_LOGS ${JSON.stringify(recent, null, 2)}`);
    throw error;
  }
}

function buildScenarios(): Scenario[] {
  return [
    {
      name: "retain_token_4_rounds",
      description: "Retain one exact token across four rounds and answer with it at the end.",
      rounds: [
        {
          prompt:
            "Round 1 of 4. Remember this exact token for the final round only: {{tokenA}}. Preserve it exactly. Reply READY-1 only.",
          expectText: /^READY-1$/,
        },
        {
          prompt: "Round 2 of 4. Do not reveal the token. Reply READY-2 only.",
          expectText: /^READY-2$/,
        },
        {
          prompt: "Round 3 of 4. Do not reveal the token. Reply READY-3 only.",
          expectText: /^READY-3$/,
        },
        {
          prompt:
            "Round 4 of 4. What exact token did I ask you to preserve in round 1? Reply with the token only.",
          expectText: "{{tokenA}}",
        },
      ],
      afterScenario: async (ctx) => {
        await assertStateContains(ctx, "{{tokenA}}");
      },
    },
    {
      name: "retain_token_5_rounds",
      description: "Retain one exact token across five rounds and answer with it at the end.",
      rounds: [
        {
          prompt:
            "Round 1 of 5. Remember this exact token for the final round only: {{tokenA}}. Preserve it exactly. Reply KEEP-1 only.",
          expectText: /^KEEP-1$/,
        },
        {
          prompt: "Round 2 of 5. Do not reveal the token. Reply KEEP-2 only.",
          expectText: /^KEEP-2$/,
        },
        {
          prompt: "Round 3 of 5. Do not reveal the token. Reply KEEP-3 only.",
          expectText: /^KEEP-3$/,
        },
        {
          prompt: "Round 4 of 5. Do not reveal the token. Reply KEEP-4 only.",
          expectText: /^KEEP-4$/,
        },
        {
          prompt:
            "Round 5 of 5. What exact token did I ask you to preserve in round 1? Reply with the token only.",
          expectText: "{{tokenA}}",
        },
      ],
      afterScenario: async (ctx) => {
        await assertStateContains(ctx, "{{tokenA}}");
      },
    },
    {
      name: "retain_token_8_rounds",
      description: "Retain one exact token across eight rounds of continuation.",
      rounds: [
        {
          prompt:
            "Round 1 of 8. Remember this exact token for round 8 only: {{tokenA}}. Preserve it exactly. Reply STEP-1 only.",
          expectText: /^STEP-1$/,
        },
        {
          prompt: "Round 2 of 8. Do not reveal the token. Reply STEP-2 only.",
          expectText: /^STEP-2$/,
        },
        {
          prompt: "Round 3 of 8. Do not reveal the token. Reply STEP-3 only.",
          expectText: /^STEP-3$/,
        },
        {
          prompt: "Round 4 of 8. Do not reveal the token. Reply STEP-4 only.",
          expectText: /^STEP-4$/,
        },
        {
          prompt: "Round 5 of 8. Do not reveal the token. Reply STEP-5 only.",
          expectText: /^STEP-5$/,
        },
        {
          prompt: "Round 6 of 8. Do not reveal the token. Reply STEP-6 only.",
          expectText: /^STEP-6$/,
        },
        {
          prompt: "Round 7 of 8. Do not reveal the token. Reply STEP-7 only.",
          expectText: /^STEP-7$/,
        },
        {
          prompt: "Round 8 of 8. Reply with the exact preserved token only.",
          expectText: "{{tokenA}}",
        },
      ],
      afterScenario: async (ctx) => {
        await assertStateContains(ctx, "{{tokenA}}");
      },
    },
    {
      name: "explicit_close_clears_memory",
      description: "Close a memory task explicitly and ensure retained state is cleared.",
      rounds: [
        {
          prompt: "Remember this exact token for later: {{tokenA}}. Reply STORED only.",
          expectText: /^STORED$/i,
        },
        {
          prompt:
            "The task is complete. Forget the retained token, clear memory, close the task, and reply CLOSED only.",
          expectText: /^CLOSED$/i,
          afterRound: async (ctx) => {
            await assertStateEmpty(ctx);
          },
        },
        {
          prompt:
            "What token did I ask you to remember earlier? If it is no longer available, reply UNKNOWN only.",
          expectText: /^UNKNOWN$/i,
          rejectText: "{{tokenA}}",
        },
      ],
    },
    {
      name: "replacement_drops_old_memory",
      description: "Replace an old token task with a new unrelated token task.",
      rounds: [
        {
          prompt: "Remember this exact old token for later: {{tokenA}}. Reply OLD-STORED only.",
          expectText: /^OLD-STORED$/,
        },
        {
          prompt:
            "Forget the old token completely. New unrelated task: remember this exact token instead: {{tokenB}}. Reply NEW-STORED only.",
          expectText: /^NEW-STORED$/,
        },
        {
          prompt: "What is the current exact token? Reply with the token only.",
          expectText: "{{tokenB}}",
          rejectText: "{{tokenA}}",
        },
      ],
      afterScenario: async (ctx) => {
        await assertStateContains(ctx, "{{tokenB}}");
        await assertStateNotContains(ctx, "{{tokenA}}");
      },
    },
    {
      name: "context_get_fetches_omitted_piece",
      description:
        "Use context_get when the needed retained piece is omitted from the inline memory block.",
      config: { maxInlinePieces: 1 },
      rounds: [
        {
          prompt: "Remember this exact first token for later: {{tokenA}}. Reply HOLD-1 only.",
          expectText: /^HOLD-1$/,
        },
        {
          prompt: "Also remember this exact second token for later: {{tokenB}}. Reply HOLD-2 only.",
          expectText: /^HOLD-2$/,
        },
        {
          prompt:
            "What was the first exact token? Use context_get if needed. Reply with the token only.",
          expectText: "{{tokenA}}",
        },
      ],
      afterScenario: async (ctx) => {
        await assertEventCountAtLeast(ctx, "context_get_fetch", 1);
      },
    },
    {
      name: "payload_externalization_and_recall",
      description: "Externalize a large retained payload and still recall it exactly later.",
      config: { inlinePieceByteLimit: 64, maxInlinePieces: 1 },
      rounds: [
        {
          prompt:
            "Remember this exact secret phrase for later and preserve it exactly: {{longSecret}}. Reply LARGE-STORED only.",
          expectText: /^LARGE-STORED$/,
        },
        {
          prompt:
            "What exact secret phrase did I tell you to preserve? Use context_get if needed. Reply with the phrase only.",
          expectText: "{{longSecret}}",
        },
      ],
      afterScenario: async (ctx) => {
        const state = await ctx.readState();
        const pieces = Array.isArray(state.pieces)
          ? state.pieces as Array<Record<string, unknown>>
          : [];
        if (
          !pieces.some((piece) =>
            typeof piece.payloadRef === "string" && piece.payloadRef.length > 0
          )
        ) {
          throw new Error("expected at least one payloadRef in persisted state");
        }
      },
    },
    {
      name: "transient_question_keeps_empty_memory",
      description: "A one-shot factual answer should not retain memory.",
      rounds: [
        {
          prompt: "What is 2+2? Reply with exactly 4 and do not retain anything for later.",
          expectText: /^4$/,
          afterRound: async (ctx) => {
            await assertStateEmpty(ctx);
          },
        },
      ],
    },
    {
      name: "assistant_chatter_is_pruned",
      description:
        "Keep the durable user fact while dropping assistant chatter across follow-up rounds.",
      rounds: [
        {
          prompt: "Remember this exact token for later: {{tokenA}}. Reply ACK-1 only.",
          expectText: /^ACK-1$/,
        },
        { prompt: "Do not reveal the token. Reply ACK-2 only.", expectText: /^ACK-2$/ },
        { prompt: "Do not reveal the token. Reply ACK-3 only.", expectText: /^ACK-3$/ },
      ],
      afterScenario: async (ctx) => {
        const state = await ctx.readState();
        const pieces = Array.isArray(state.pieces)
          ? state.pieces as Array<Record<string, unknown>>
          : [];
        if (pieces.length !== 1) {
          throw new Error(`expected exactly 1 retained piece, got ${pieces.length}`);
        }
        if (pieces[0].sourceKind !== "user") {
          throw new Error(
            `expected retained durable piece to be user, got ${String(pieces[0].sourceKind)}`,
          );
        }
      },
    },
    {
      name: "close_then_reopen_new_task",
      description: "Close an old task, then start a new one and recall only the new token.",
      rounds: [
        {
          prompt: "Remember this exact token for later: {{tokenA}}. Reply FIRST only.",
          expectText: /^FIRST$/,
        },
        {
          prompt: "Forget the old token, clear memory, close the task, and reply CLEARED only.",
          expectText: /^CLEARED$/i,
        },
        {
          prompt:
            "New task. Remember this exact new token for later: {{tokenB}}. Reply SECOND only.",
          expectText: /^SECOND$/,
        },
        {
          prompt: "What exact token is currently active? Reply with the token only.",
          expectText: "{{tokenB}}",
          rejectText: "{{tokenA}}",
        },
      ],
      afterScenario: async (ctx) => {
        await assertStateContains(ctx, "{{tokenB}}");
        await assertStateNotContains(ctx, "{{tokenA}}");
      },
    },
    {
      name: "multi_value_exact_recall",
      description: "Preserve and later recall multiple exact literals from one durable user piece.",
      rounds: [
        {
          prompt:
            "Remember these exact values for later: alpha={{tokenA}} beta={{tokenB}}. Preserve both exactly. Reply BOTH-STORED only.",
          expectText: /^BOTH-STORED$/,
        },
        {
          prompt: 'What are alpha and beta? Reply exactly as JSON: {"alpha":"...","beta":"..."}',
          expectText: /"alpha":"{{tokenA}}".*"beta":"{{tokenB}}"/,
        },
      ],
      afterScenario: async (ctx) => {
        await assertStateContains(ctx, "{{tokenA}}");
        await assertStateContains(ctx, "{{tokenB}}");
      },
    },
  ];
}

function testConfig(overrides: Partial<ProxyConfig> = {}): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    upstreamBaseUrl: "auto",
    apiKey: null,
    smallStructuredModel: "gpt-5.4-mini",
    overflowStructuredModel: "gpt-5.4",
    smallStructuredContextWindow: 272_000,
    overflowStructuredContextWindow: 1_000_000,
    modelTimeoutMs: 60_000,
    stateDir: "/tmp/pando-live-memory",
    memoryEnabled: true,
    logFile: null,
    inlinePieceByteLimit: 16_384,
    piecePreviewCharLimit: 96,
    maxInlinePieces: 12,
    maxLocalContextToolCalls: 4,
    codexAutoCompactTokenLimit: 280_000,
    ...overrides,
  };
}

function parseSelectedScenarioNames(args: string[]): string[] {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--only") {
      continue;
    }
    const value = args[index + 1] ?? "";
    if (!value) {
      throw new Error("--only requires a comma-separated value");
    }
    selected.push(...value.split(",").map((part) => part.trim()).filter(Boolean));
    index += 1;
  }
  return selected;
}

async function resolveAuthHeader(): Promise<string> {
  const envKey = Deno.env.get("OPENAI_API_KEY")?.trim();
  if (envKey) {
    return `Bearer ${envKey}`;
  }
  const home = Deno.env.get("HOME") ?? "";
  const authPath = `${home}/.codex/auth.json`;
  const auth = JSON.parse(await Deno.readTextFile(authPath));
  const accessToken = auth?.tokens?.access_token;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error(`No OPENAI_API_KEY and no tokens.access_token in ${authPath}`);
  }
  return `Bearer ${accessToken.trim()}`;
}

function responseText(body: unknown): string {
  if (!body || typeof body !== "object") {
    return "";
  }
  const output = (body as Record<string, unknown>).output;
  if (!Array.isArray(output)) {
    return "";
  }
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (
        part && typeof part === "object" &&
        typeof (part as Record<string, unknown>).text === "string"
      ) {
        parts.push(String((part as Record<string, unknown>).text));
      }
    }
  }
  return parts.join("\n").trim();
}

function interpolate(text: string, tokenMap: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(tokenMap)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

function interpolateExpectation(
  expectation: string | RegExp,
  tokenMap: Record<string, string>,
): string | RegExp {
  if (typeof expectation === "string") {
    return interpolate(expectation, tokenMap);
  }
  return new RegExp(interpolate(expectation.source, tokenMap), expectation.flags);
}

function assertMatches(actual: string, expected: string | RegExp, label: string): void {
  if (typeof expected === "string") {
    if (actual !== expected) {
      throw new Error(
        `${label}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
      );
    }
    return;
  }
  if (!expected.test(actual)) {
    throw new Error(`${label}: expected ${String(expected)} got ${JSON.stringify(actual)}`);
  }
}

function assertNotMatches(actual: string, unexpected: string | RegExp, label: string): void {
  if (typeof unexpected === "string") {
    if (actual.includes(unexpected)) {
      throw new Error(
        `${label}: unexpected substring ${JSON.stringify(unexpected)} in ${JSON.stringify(actual)}`,
      );
    }
    return;
  }
  if (unexpected.test(actual)) {
    throw new Error(
      `${label}: unexpected pattern ${String(unexpected)} in ${JSON.stringify(actual)}`,
    );
  }
}

async function assertNoMemoryUpdateFailure(ctx: ScenarioContext): Promise<void> {
  const logs = await ctx.readLogs();
  const failures = logs.filter((entry) => entry.event === "memory_update_failed");
  if (failures.length > 0) {
    throw new Error(`memory_update_failed present: ${JSON.stringify(failures.at(-1))}`);
  }
  const roundCompleteFailures = logs.filter((entry) =>
    entry.event === "round_complete" && typeof entry.memoryUpdateError === "string" &&
    entry.memoryUpdateError.length > 0
  );
  if (roundCompleteFailures.length > 0) {
    throw new Error(
      `round_complete memoryUpdateError present: ${JSON.stringify(roundCompleteFailures.at(-1))}`,
    );
  }
}

async function assertStateEmpty(ctx: ScenarioContext): Promise<void> {
  const state = await ctx.readState();
  const groups = Array.isArray(state.groups) ? state.groups : [];
  const pieces = Array.isArray(state.pieces) ? state.pieces : [];
  if (groups.length !== 0 || pieces.length !== 0) {
    throw new Error(`expected empty state, got groups=${groups.length} pieces=${pieces.length}`);
  }
}

async function assertStateContains(ctx: ScenarioContext, pattern: string): Promise<void> {
  const needle = interpolate(pattern, ctx.tokenMap);
  const texts = await ctx.exactPayloadTexts();
  if (!texts.some((text) => text.includes(needle))) {
    throw new Error(`expected retained payloads to contain ${needle}`);
  }
}

async function assertStateNotContains(ctx: ScenarioContext, pattern: string): Promise<void> {
  const needle = interpolate(pattern, ctx.tokenMap);
  const texts = await ctx.exactPayloadTexts();
  if (texts.some((text) => text.includes(needle))) {
    throw new Error(`expected retained payloads not to contain ${needle}`);
  }
}

async function assertEventCountAtLeast(
  ctx: ScenarioContext,
  event: string,
  minimum: number,
): Promise<void> {
  const logs = await ctx.readLogs();
  const count = logs.filter((entry) => entry.event === event).length;
  if (count < minimum) {
    throw new Error(`expected at least ${minimum} ${event} events, got ${count}`);
  }
}

function tokensForScenario(seed: string): Record<string, string> {
  const suffix = seed.toUpperCase().replace(/[^A-Z0-9]+/g, "-").slice(0, 16);
  return {
    tokenA: `BLUE-${suffix}-7319`,
    tokenB: `AMBER-${suffix}-4826`,
    longSecret: `LONG-${suffix}-SECRET-` +
      "x".repeat(120) +
      `-TAIL-${suffix}-9174`,
  };
}

if (import.meta.main) {
  await main();
}
