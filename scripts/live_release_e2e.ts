#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write

import { createHandler } from "../src/server.ts";
import {
  DEFAULT_OVERFLOW_STRUCTURED_CONTEXT_WINDOW,
  DEFAULT_OVERFLOW_STRUCTURED_MODEL,
  DEFAULT_SMALL_STRUCTURED_CONTEXT_WINDOW,
  DEFAULT_SMALL_STRUCTURED_MODEL,
  type ProxyConfig,
} from "../src/config.ts";
import { SessionStore } from "../src/store.ts";

type Expectation = {
  contains?: string[];
  regex?: RegExp;
  exact?: string;
  rejects?: string[];
};

type RoundSpec = {
  prompt: string;
  expect: Expectation;
};

type Scenario = {
  name: string;
  kind: string;
  description: string;
  rounds: RoundSpec[];
};

type RoundRecord = {
  index: number;
  prompt: string;
  output: string;
};

type ScenarioRecord = {
  name: string;
  kind: string;
  description: string;
  sessionKey: string;
  tempDir: string;
  rounds: RoundRecord[];
  roundCompleteCount: number;
  memoryErrors: number;
  archiveRecalls: number;
  allInTokens: number;
  managerTokens: number;
};

const MODEL = Deno.env.get("PANDO_LIVE_E2E_MODEL") ?? "gpt-5.4";

async function main(): Promise<void> {
  const authHeader = await resolveAuthHeader();
  const started = new Date();
  const suiteId = started.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
  const resultPath = `tests/live_e2e_release_${suiteId}.md`;
  const records: ScenarioRecord[] = [];

  for (const scenario of scenarios()) {
    console.log(`SCENARIO ${scenario.name}`);
    records.push(await runScenario(scenario, authHeader, suiteId));
    console.log(`PASS ${scenario.name}`);
  }

  await Deno.writeTextFile(resultPath, renderMarkdown(started, records));
  console.log(`RESULTS ${resultPath}`);
}

async function runScenario(
  scenario: Scenario,
  authHeader: string,
  suiteId: string,
): Promise<ScenarioRecord> {
  const tempDir = await Deno.makeTempDir({ prefix: `pando-release-${scenario.name}-` });
  const logFile = `${tempDir}/proxy.jsonl`;
  const stateDir = `${tempDir}/state`;
  const sessionKey = `release-${suiteId}-${scenario.name}`;
  const store = new SessionStore(stateDir);
  const { handler, awaitIdle } = createHandler(config(stateDir, logFile), store);
  const rounds: RoundRecord[] = [];

  for (let index = 0; index < scenario.rounds.length; index += 1) {
    const round = scenario.rounds[index];
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
          instructions:
            "Follow the user's request exactly. Preserve exact literals when asked. Be concise.",
          input: [{
            id: `msg_user_${index + 1}`,
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: round.prompt }],
          }],
        }),
      }),
    );

    if (!response.ok) {
      throw new Error(
        `${scenario.name} round ${index + 1} HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const body = await response.json();
    const output = responseText(body);
    assertExpectation(output, round.expect, `${scenario.name} round ${index + 1}`);
    rounds.push({ index: index + 1, prompt: round.prompt, output });
    console.log(`ROUND ${scenario.name} ${index + 1} ${JSON.stringify(output)}`);

    await awaitIdle();
    const logs = await readLogs(logFile, sessionKey);
    const failed = logs.filter((entry) =>
      entry.event === "memory_update_failed" ||
      (entry.event === "round_complete" && typeof entry.memoryUpdateError === "string")
    );
    if (failed.length > 0) {
      throw new Error(`${scenario.name} memory update failed: ${JSON.stringify(failed.at(-1))}`);
    }
  }

  const logs = await readLogs(logFile, sessionKey);
  const roundComplete = logs.filter((entry) => entry.event === "round_complete");
  return {
    name: scenario.name,
    kind: scenario.kind,
    description: scenario.description,
    sessionKey,
    tempDir,
    rounds,
    roundCompleteCount: roundComplete.length,
    memoryErrors: roundComplete.filter((entry) => typeof entry.memoryUpdateError === "string")
      .length,
    archiveRecalls: sumNumber(roundComplete, "archiveRecallCount"),
    allInTokens: sumNumber(roundComplete, "allInTotalTokens"),
    managerTokens: sumNumber(roundComplete, "internalManagerTotalTokens"),
  };
}

function scenarios(): Scenario[] {
  return [
    {
      name: "realistic_incident_handoff",
      kind: "realistic ops handoff",
      description: "Preserve incident facts across an operations handoff.",
      rounds: [
        {
          prompt:
            "Round 1 of 3. Preserve these incident facts for later: service=api-gateway, deploy=2026-04-25T17:14Z, exact symptom_literal=`p95-latency-1840ms`. Reply OPS-R1 only.",
          expect: { exact: "OPS-R1" },
        },
        {
          prompt:
            "Round 2 of 3. Add this mitigation for the same incident: disable feature flag payment.cache-v3. Reply OPS-R2 only.",
          expect: { exact: "OPS-R2" },
        },
        {
          prompt:
            "Round 3 of 3. Return the preserved service, deploy, symptom_literal, and mitigation in one concise sentence. Copy symptom_literal and mitigation exactly.",
          expect: {
            contains: [
              "api-gateway",
              "2026-04-25T17:14Z",
              "p95-latency-1840ms",
              "payment.cache-v3",
            ],
          },
        },
      ],
    },
    {
      name: "realistic_release_checklist",
      kind: "realistic release notes",
      description: "Carry release checklist details and retrieve them after a distractor round.",
      rounds: [
        {
          prompt:
            "Round 1 of 3. Remember this release checklist: command=`npm run pack:check`; required artifact=`dist/main.js`; blocker=`.env in tarball`. Reply REL-R1 only.",
          expect: { exact: "REL-R1" },
        },
        {
          prompt:
            "Round 2 of 3. Distractor: the launch channel is stable and the owner is build-cop. Do not repeat the checklist. Reply REL-R2 only.",
          expect: { exact: "REL-R2" },
        },
        {
          prompt:
            "Round 3 of 3. What release checklist command, required artifact, and blocker did I give you? Reply as three short lines.",
          expect: {
            contains: ["npm run pack:check", "dist/main.js", ".env", "tarball"],
          },
        },
      ],
    },
    {
      name: "realistic_customer_migration",
      kind: "realistic customer migration",
      description: "Retain structured migration fields across planning turns.",
      rounds: [
        {
          prompt:
            "Round 1 of 3. Preserve migration record: customer=Northwind-Labs; window=2026-05-02 02:00-03:30 UTC; rollback=restore-snapshot-r42. Reply MIG-R1 only.",
          expect: { exact: "MIG-R1" },
        },
        {
          prompt:
            "Round 2 of 3. Add validation query id `check-invoice-count-v7` to that same migration. Reply MIG-R2 only.",
          expect: { exact: "MIG-R2" },
        },
        {
          prompt:
            "Round 3 of 3. Return the migration record as JSON with customer, window, rollback, and validationQuery.",
          expect: {
            contains: [
              "Northwind-Labs",
              "2026-05-02 02:00-03:30 UTC",
              "restore-snapshot-r42",
              "check-invoice-count-v7",
            ],
          },
        },
      ],
    },
    {
      name: "fake_exact_values",
      kind: "fake exact values",
      description: "Preserve unrelated synthetic literals exactly.",
      rounds: [
        {
          prompt:
            "Round 1 of 3. Remember fake token ALPHA_FAKE=VX-19-ORCHID and fake token BETA_FAKE=QZ_44_MOON. Reply FAKE-R1 only.",
          expect: { exact: "FAKE-R1" },
        },
        {
          prompt:
            'Round 2 of 3. Also remember fake JSON exactly: {"route":"nebula-7","limit":42,"flag":"copper"}. Reply FAKE-R2 only.',
          expect: { exact: "FAKE-R2" },
        },
        {
          prompt:
            "Round 3 of 3. Return the two fake assignments and the fake JSON exactly, one per line.",
          expect: {
            contains: [
              "ALPHA_FAKE=VX-19-ORCHID",
              "BETA_FAKE=QZ_44_MOON",
              '{"route":"nebula-7","limit":42,"flag":"copper"}',
            ],
          },
        },
      ],
    },
    {
      name: "mixed_long_six_round",
      kind: "mixed realistic and fake long session",
      description: "Six rounds mixing realistic operational facts with synthetic exact values.",
      rounds: [
        {
          prompt:
            "Round 1 of 6. Preserve service fact: queue=mail-delivery, scaling-threshold=depth>9000. Reply MIX-R1 only.",
          expect: { exact: "MIX-R1" },
        },
        {
          prompt:
            "Round 2 of 6. Preserve fake rule OMEGA_RULE=never-drop-cobalt-17. Reply MIX-R2 only.",
          expect: { exact: "MIX-R2" },
        },
        {
          prompt:
            "Round 3 of 6. Add runbook path `/runbooks/mail/queue-drain.md`. Reply MIX-R3 only.",
          expect: { exact: "MIX-R3" },
        },
        {
          prompt:
            "Round 4 of 6. Preserve fake sequence SIGMA_SEQ=[red-02,green-05,blue-08]. Reply MIX-R4 only.",
          expect: { exact: "MIX-R4" },
        },
        {
          prompt: "Round 5 of 6. Add escalation owner `sre-mail-primary`. Reply MIX-R5 only.",
          expect: { exact: "MIX-R5" },
        },
        {
          prompt:
            "Round 6 of 6. Combine all remembered realistic and fake facts in concise bullets.",
          expect: {
            contains: [
              "mail-delivery",
              "depth",
              "9000",
              "OMEGA_RULE=never-drop-cobalt-17",
              "/runbooks/mail/queue-drain.md",
              "SIGMA_SEQ=[red-02,green-05,blue-08]",
              "sre-mail-primary",
            ],
          },
        },
      ],
    },
  ];
}

function config(stateDir: string, logFile: string): ProxyConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    upstreamBaseUrl: "auto",
    apiKey: null,
    smallStructuredModel: DEFAULT_SMALL_STRUCTURED_MODEL,
    overflowStructuredModel: DEFAULT_OVERFLOW_STRUCTURED_MODEL,
    smallStructuredContextWindow: DEFAULT_SMALL_STRUCTURED_CONTEXT_WINDOW,
    overflowStructuredContextWindow: DEFAULT_OVERFLOW_STRUCTURED_CONTEXT_WINDOW,
    modelTimeoutMs: 60_000,
    stateDir,
    memoryEnabled: true,
    logFile,
    codexAutoCompactTokenLimit: 280_000,
  };
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

function assertExpectation(output: string, expectation: Expectation, label: string): void {
  if (expectation.exact !== undefined && !matchesExactOrMarkerVariant(output, expectation.exact)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expectation.exact)}, got ${JSON.stringify(output)}`,
    );
  }
  for (const value of expectation.contains ?? []) {
    if (!output.includes(value)) {
      throw new Error(
        `${label}: expected output to contain ${JSON.stringify(value)}, got ${
          JSON.stringify(output)
        }`,
      );
    }
  }
  if (expectation.regex && !expectation.regex.test(output)) {
    throw new Error(`${label}: expected ${expectation.regex}, got ${JSON.stringify(output)}`);
  }
  for (const value of expectation.rejects ?? []) {
    if (output.includes(value)) {
      throw new Error(`${label}: output unexpectedly contained ${JSON.stringify(value)}`);
    }
  }
}

function matchesExactOrMarkerVariant(output: string, expected: string): boolean {
  return output === expected || output === `${expected} only` || output === `${expected} only.` ||
    output.startsWith(`${expected}:`);
}

async function readLogs(path: string, sessionKey: string): Promise<Array<Record<string, unknown>>> {
  try {
    return (await Deno.readTextFile(path))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.sessionKey === sessionKey);
  } catch {
    return [];
  }
}

function sumNumber(entries: Array<Record<string, unknown>>, field: string): number {
  return entries.reduce((sum, entry) => {
    const value = entry[field];
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
}

function renderMarkdown(started: Date, records: ScenarioRecord[]): string {
  const totalRounds = records.reduce((sum, record) => sum + record.rounds.length, 0);
  const totalRoundComplete = records.reduce((sum, record) => sum + record.roundCompleteCount, 0);
  const totalMemoryErrors = records.reduce((sum, record) => sum + record.memoryErrors, 0);
  const totalArchiveRecalls = records.reduce((sum, record) => sum + record.archiveRecalls, 0);
  const totalAllInTokens = records.reduce((sum, record) => sum + record.allInTokens, 0);
  const totalManagerTokens = records.reduce((sum, record) => sum + record.managerTokens, 0);

  const lines = [
    `# Live E2E Release Suite - ${started.toISOString().slice(0, 10)}`,
    "",
    "Manual live backend suite run before npm republish.",
    "",
    `- Model: \`${MODEL}\``,
    `- Started: \`${started.toISOString()}\``,
    `- Total scenarios: \`${records.length}\``,
    `- Total live rounds: \`${totalRounds}\``,
    `- Proxy round_complete records: \`${totalRoundComplete}\``,
    `- Memory errors: \`${totalMemoryErrors}\``,
    `- Archive recalls: \`${totalArchiveRecalls}\``,
    `- All-in tokens: \`${totalAllInTokens.toLocaleString()}\``,
    `- Manager tokens: \`${totalManagerTokens.toLocaleString()}\``,
    "",
    "| Test | Kind | Rounds | Memory errors | Archive recalls | All-in tokens | Manager tokens |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: |",
    ...records.map((record) =>
      `| \`${record.name}\` | ${record.kind} | ${record.rounds.length} | ${record.memoryErrors} | ${record.archiveRecalls} | ${record.allInTokens.toLocaleString()} | ${record.managerTokens.toLocaleString()} |`
    ),
    "",
  ];

  for (const record of records) {
    lines.push(`## ${record.name}`, "");
    lines.push(record.description, "");
    lines.push(`- Session: \`${record.sessionKey}\``);
    lines.push(`- Temp artifacts: \`${record.tempDir}\``);
    lines.push("");
    for (const round of record.rounds) {
      lines.push(`### Round ${round.index}`, "");
      lines.push("Prompt:");
      lines.push("");
      lines.push("```text");
      lines.push(round.prompt);
      lines.push("```");
      lines.push("");
      lines.push("Output:");
      lines.push("");
      lines.push("```text");
      lines.push(round.output);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Conclusion", "");
  lines.push("- All five live scenarios passed.");
  lines.push("- Each scenario had at least three live rounds.");
  lines.push("- The mixed long scenario had six live rounds.");
  lines.push(
    "- No `memory_update_failed` or `round_complete.memoryUpdateError` records were observed.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  await main();
}
