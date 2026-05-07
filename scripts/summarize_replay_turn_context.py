#!/usr/bin/env python3

import argparse
import csv
import json
from pathlib import Path
from statistics import mean, median
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Summarize per-turn context window sizes from bin/replay.ts "
            "*__turns.jsonl outputs."
        ),
    )
    parser.add_argument("--turns-dir", required=True, help="Directory containing replay turns JSONL files")
    parser.add_argument("--suffix", default="__real-llm__turns.jsonl", help="Turns file suffix to match")
    parser.add_argument("--out", help="Optional path to write summary JSON")
    parser.add_argument("--csv-out", help="Optional path to write per-rollout CSV")
    return parser.parse_args()


def summarize(values: list[int]) -> dict[str, int | float | None]:
    if not values:
        return {
            "count": 0,
            "min": None,
            "avg": None,
            "median": None,
            "max": None,
            "total": 0,
        }
    return {
        "count": len(values),
        "min": min(values),
        "avg": round(mean(values), 1),
        "median": round(median(values), 1),
        "max": max(values),
        "total": sum(values),
    }


def pct_reduction(before: float | int | None, after: float | int | None) -> float | None:
    if before is None or after is None or before == 0:
        return None
    return round(100 * (float(before) - float(after)) / float(before), 1)


def load_turns(path: Path) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            if isinstance(item, dict):
                turns.append(item)
    return turns


def rollout_name(path: Path, suffix: str) -> str:
    name = path.name
    return name[: -len(suffix)] if name.endswith(suffix) else path.stem


def main() -> int:
    args = parse_args()
    turns_dir = Path(args.turns_dir)
    files = sorted(turns_dir.glob(f"*{args.suffix}"))
    if not files:
        raise SystemExit(f"No turns files matched *{args.suffix} in {turns_dir}")

    all_baseline: list[int] = []
    all_pando: list[int] = []
    per_rollout: list[dict[str, Any]] = []
    for path in files:
        turns = load_turns(path)
        baseline = [
            int(turn["baselineApproxInputTokens"])
            for turn in turns
            if isinstance(turn.get("baselineApproxInputTokens"), int)
        ]
        pando = [
            int(turn["pandoApproxInputTokens"])
            for turn in turns
            if isinstance(turn.get("pandoApproxInputTokens"), int)
        ]
        all_baseline.extend(baseline)
        all_pando.extend(pando)
        row = {
            "rollout": rollout_name(path, args.suffix),
            "turns": len(turns),
            "baseline": summarize(baseline),
            "pando": summarize(pando),
        }
        row["reductionPct"] = {
            "avg": pct_reduction(row["baseline"]["avg"], row["pando"]["avg"]),
            "median": pct_reduction(row["baseline"]["median"], row["pando"]["median"]),
            "max": pct_reduction(row["baseline"]["max"], row["pando"]["max"]),
            "total": pct_reduction(row["baseline"]["total"], row["pando"]["total"]),
        }
        per_rollout.append(row)

    baseline_summary = summarize(all_baseline)
    pando_summary = summarize(all_pando)
    out = {
        "turnsDir": str(turns_dir),
        "suffix": args.suffix,
        "rolloutCount": len(files),
        "turnCount": len(all_baseline),
        "baselineApproxInputTokens": baseline_summary,
        "proxyApproxInputTokens": pando_summary,
        "reductionPct": {
            "avg": pct_reduction(baseline_summary["avg"], pando_summary["avg"]),
            "median": pct_reduction(baseline_summary["median"], pando_summary["median"]),
            "max": pct_reduction(baseline_summary["max"], pando_summary["max"]),
            "total": pct_reduction(baseline_summary["total"], pando_summary["total"]),
        },
        "perRollout": per_rollout,
    }

    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    if args.csv_out:
        csv_path = Path(args.csv_out)
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        with csv_path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(
                f,
                fieldnames=[
                    "rollout",
                    "turns",
                    "baseline_min",
                    "baseline_avg",
                    "baseline_median",
                    "baseline_max",
                    "proxy_min",
                    "proxy_avg",
                    "proxy_median",
                    "proxy_max",
                    "avg_reduction_pct",
                    "median_reduction_pct",
                    "max_reduction_pct",
                ],
            )
            writer.writeheader()
            for row in per_rollout:
                writer.writerow({
                    "rollout": row["rollout"],
                    "turns": row["turns"],
                    "baseline_min": row["baseline"]["min"],
                    "baseline_avg": row["baseline"]["avg"],
                    "baseline_median": row["baseline"]["median"],
                    "baseline_max": row["baseline"]["max"],
                    "proxy_min": row["pando"]["min"],
                    "proxy_avg": row["pando"]["avg"],
                    "proxy_median": row["pando"]["median"],
                    "proxy_max": row["pando"]["max"],
                    "avg_reduction_pct": row["reductionPct"]["avg"],
                    "median_reduction_pct": row["reductionPct"]["median"],
                    "max_reduction_pct": row["reductionPct"]["max"],
                })
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
