#!/usr/bin/env python3

import argparse
import json
from pathlib import Path
from statistics import mean, median


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Aggregate replay stats JSON files produced by bin/replay.ts.",
    )
    parser.add_argument("--stats-dir", required=True, help="Directory containing *__stats.json files")
    parser.add_argument("--suffix", required=True, help="Suffix to match, e.g. __drop-tools__stats.json")
    parser.add_argument("--out", help="Optional path to write the aggregate JSON")
    return parser.parse_args()


def avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def main() -> int:
    args = parse_args()
    stats_dir = Path(args.stats_dir)
    files = sorted(stats_dir.glob(f"*{args.suffix}"))
    rows = [json.loads(path.read_text()) for path in files]
    if not rows:
        raise SystemExit(f"No stats files matched {args.suffix} in {stats_dir}")

    baseline_min = [row["baseline"]["min"] for row in rows]
    pando_min = [row["pando"]["min"] for row in rows]
    baseline_avg = [row["baseline"]["avg"] for row in rows]
    pando_avg = [row["pando"]["avg"] for row in rows]
    baseline_max = [row["baseline"]["max"] for row in rows]
    pando_max = [row["pando"]["max"] for row in rows]
    avg_savings = [row["savingsAvgTokens"] for row in rows]
    max_savings = [row["savingsMaxTokens"] for row in rows]
    rounds = [row["rounds"] for row in rows]
    avg_reduction_pct = [
        100 * (row["baseline"]["avg"] - row["pando"]["avg"]) / row["baseline"]["avg"]
        for row in rows
        if row["baseline"]["avg"] > 0
    ]
    max_reduction_pct = [
        100 * (row["baseline"]["max"] - row["pando"]["max"]) / row["baseline"]["max"]
        for row in rows
        if row["baseline"]["max"] > 0
    ]

    out = {
        "samples": len(rows),
        "totalRounds": sum(rounds),
        "avgBaselineMin": round(avg(baseline_min)),
        "avgPandoMin": round(avg(pando_min)),
        "avgBaselineAvg": round(avg(baseline_avg)),
        "avgPandoAvg": round(avg(pando_avg)),
        "avgBaselineMax": round(avg(baseline_max)),
        "avgPandoMax": round(avg(pando_max)),
        "avgAvgSavings": round(avg(avg_savings)),
        "avgMaxSavings": round(avg(max_savings)),
        "positiveAvgSavingsRate": round(100 * sum(1 for value in avg_savings if value > 0) / len(avg_savings), 1),
        "positiveMaxSavingsRate": round(100 * sum(1 for value in max_savings if value > 0) / len(max_savings), 1),
        "aggregateAvgReductionPct": round(
            100 * (avg(baseline_avg) - avg(pando_avg)) / avg(baseline_avg),
            1,
        ),
        "aggregateMaxReductionPct": round(
            100 * (avg(baseline_max) - avg(pando_max)) / avg(baseline_max),
            1,
        ),
        "meanPerTraceAvgReductionPct": round(mean(avg_reduction_pct), 1),
        "meanPerTraceMaxReductionPct": round(mean(max_reduction_pct), 1),
        "medianPerTraceAvgReductionPct": round(median(avg_reduction_pct), 1),
        "medianPerTraceMaxReductionPct": round(median(max_reduction_pct), 1),
    }
    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=2) + "\n")
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
