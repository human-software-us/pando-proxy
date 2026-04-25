#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
// CLI entry for replaying a Codex rollout through the Pando memory pipeline.
//
// Usage:
//   deno run --allow-read --allow-write --allow-env --allow-net \
//     bin/replay.ts --rollout <path.jsonl> [--policy drop-tools|retain-all|retain-recent]
//     [--max-rounds N] [--out-dir tmp/replay/<name>]
//     [--real-llm --auth-from-codex]

import { parseArgs } from "@std/cli/parse-args";
import { replayRollout, type ReplayTurnResult, type StubPolicy } from "../src/replay.ts";
import type { StructuredModelUsage } from "../src/structured_model.ts";

type CliArgs = {
  rollout?: string;
  policy?: StubPolicy;
  "max-rounds"?: number;
  "out-dir"?: string;
  verbose?: boolean;
  "real-llm"?: boolean;
  "auth-from-codex"?: boolean;
  "request-model"?: string;
};

async function resolveAuthFromCodex(): Promise<string> {
  const home = Deno.env.get("HOME") ?? "";
  const path = `${home}/.codex/auth.json`;
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    throw new Error(`failed to read ${path}: ${(err as Error).message}`);
  }
  const d = JSON.parse(text) as Record<string, unknown>;
  const tokens = (d.tokens ?? {}) as Record<string, unknown>;
  const apiKey = typeof d.OPENAI_API_KEY === "string" ? d.OPENAI_API_KEY.trim() : "";
  if (apiKey) return `Bearer ${apiKey}`;
  const access = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  if (!access) {
    throw new Error("no OPENAI_API_KEY or tokens.access_token in ~/.codex/auth.json");
  }
  return `Bearer ${access}`;
}

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["rollout", "policy", "out-dir", "request-model"],
    boolean: ["verbose", "real-llm", "auth-from-codex"],
    alias: { v: "verbose" },
    default: {
      policy: "drop-tools",
      "out-dir": "tmp/replay",
      "request-model": "gpt-5.4",
    },
  }) as unknown as CliArgs;

  if (!args.rollout) {
    console.error(
      "usage: replay.ts --rollout <path> [--policy ...] [--max-rounds N] [--out-dir DIR]\n" +
        "       [--real-llm --auth-from-codex] [--request-model gpt-5.4]",
    );
    Deno.exit(2);
  }

  const maxRounds = typeof args["max-rounds"] === "string"
    ? Number(args["max-rounds"])
    : (args["max-rounds"] ?? undefined);

  const policy = (args.policy ?? "drop-tools") as StubPolicy;
  const allowed = ["retain-all", "retain-recent", "drop-tools", "keep-none", "cap-bytes"];
  if (!allowed.includes(policy)) {
    console.error(`unknown policy: ${policy}; allowed: ${allowed.join(", ")}`);
    Deno.exit(2);
  }

  const outDir = args["out-dir"] ?? "tmp/replay";
  await Deno.mkdir(outDir, { recursive: true });

  const realLlm = Boolean(args["real-llm"]);
  let authHeader: string | undefined;
  if (realLlm) {
    authHeader = args["auth-from-codex"] ? await resolveAuthFromCodex() : (() => {
      const k = Deno.env.get("OPENAI_API_KEY") ?? "";
      if (!k) {
        console.error(
          "--real-llm requires --auth-from-codex or OPENAI_API_KEY in env",
        );
        Deno.exit(2);
      }
      return `Bearer ${k}`;
    })();
  }

  const label = realLlm ? `real-llm` : `policy=${policy}`;
  console.error(`replaying ${args.rollout} with ${label}...`);

  const base = args.rollout.split("/").pop()!.replace(/\.jsonl$/, "");
  const tag = realLlm ? "real-llm" : policy;
  const progressPath = `${outDir}/${base}__${tag}__progress.jsonl`;
  const managerUsagePath = `${outDir}/${base}__${tag}__manager-usage.jsonl`;
  await Deno.writeTextFile(progressPath, "");
  if (realLlm) await Deno.writeTextFile(managerUsagePath, "");

  const onProgress = async (t: ReplayTurnResult) => {
    await Deno.writeTextFile(progressPath, JSON.stringify(t) + "\n", { append: true });
    console.error(
      `  turn ${t.turn}: baseline=${t.baselineApproxInputTokens} pando=${t.pandoApproxInputTokens} pieces=${t.pandoPieceCount} bytes=${t.pandoPieceBytes}`,
    );
  };
  const onManagerUsage = async (u: StructuredModelUsage) => {
    await Deno.writeTextFile(managerUsagePath, JSON.stringify(u) + "\n", { append: true });
  };

  const { stats, turns } = await replayRollout(args.rollout, {
    policy,
    maxRounds,
    realLlm: realLlm
      ? {
        authHeader: authHeader!,
        requestModel: args["request-model"] ?? "gpt-5.4",
        onProgress,
        onManagerUsage,
      }
      : undefined,
  });

  const perTurnPath = `${outDir}/${base}__${tag}__turns.jsonl`;
  const statsPath = `${outDir}/${base}__${tag}__stats.json`;
  const csvPath = `${outDir}/${base}__${tag}__series.csv`;

  const turnsJsonl = turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
  await Deno.writeTextFile(perTurnPath, turnsJsonl);
  await Deno.writeTextFile(statsPath, JSON.stringify(stats, null, 2) + "\n");

  const header =
    "turn,user_preview,baseline_approx,pando_approx,recorded_input,pando_pieces,pando_bytes\n";
  const rows = turns.map((t) =>
    [
      t.turn,
      JSON.stringify(t.userPreview),
      t.baselineApproxInputTokens,
      t.pandoApproxInputTokens,
      t.recordedInputTokens ?? "",
      t.pandoPieceCount,
      t.pandoPieceBytes,
    ].join(",")
  ).join("\n") + "\n";
  await Deno.writeTextFile(csvPath, header + rows);

  console.log(JSON.stringify(stats, null, 2));
  console.error(`wrote ${perTurnPath}`);
  console.error(`wrote ${statsPath}`);
  console.error(`wrote ${csvPath}`);
}

if (import.meta.main) {
  await main();
}
