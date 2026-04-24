#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
// CLI entry for replaying a Codex rollout through the Pando memory pipeline.
//
// Usage:
//   deno run --allow-read --allow-write --allow-env --allow-net \
//     bin/replay.ts --rollout <path.jsonl> [--policy drop-tools|retain-all|retain-recent]
//     [--max-rounds N] [--out-dir tmp/replay/<name>]

import { parseArgs } from "jsr:@std/cli/parse-args";
import { replayRollout, type StubPolicy } from "../src/replay.ts";

type CliArgs = {
  rollout?: string;
  policy?: StubPolicy;
  "max-rounds"?: number;
  "out-dir"?: string;
  verbose?: boolean;
};

async function main() {
  const args = parseArgs(Deno.args, {
    string: ["rollout", "policy", "out-dir"],
    boolean: ["verbose"],
    alias: { v: "verbose" },
    default: { policy: "drop-tools", "out-dir": "tmp/replay" },
  }) as unknown as CliArgs;

  if (!args.rollout) {
    console.error("usage: replay.ts --rollout <path> [--policy ...] [--max-rounds N] [--out-dir DIR]");
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

  console.error(`replaying ${args.rollout} with policy=${policy}...`);

  const { stats, turns } = await replayRollout(args.rollout, {
    policy,
    maxRounds,
  });

  const base = args.rollout.split("/").pop()!.replace(/\.jsonl$/, "");
  const perTurnPath = `${outDir}/${base}__${policy}__turns.jsonl`;
  const statsPath = `${outDir}/${base}__${policy}__stats.json`;
  const csvPath = `${outDir}/${base}__${policy}__series.csv`;

  const turnsJsonl = turns.map((t) => JSON.stringify(t)).join("\n") + "\n";
  await Deno.writeTextFile(perTurnPath, turnsJsonl);
  await Deno.writeTextFile(statsPath, JSON.stringify(stats, null, 2) + "\n");

  const header = "turn,user_preview,baseline_approx,pando_approx,recorded_input,pando_chunks,pando_bytes\n";
  const rows = turns.map((t) =>
    [
      t.turn,
      JSON.stringify(t.userPreview),
      t.baselineApproxInputTokens,
      t.pandoApproxInputTokens,
      t.recordedInputTokens ?? "",
      t.pandoChunkCount,
      t.pandoChunkBytes,
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
