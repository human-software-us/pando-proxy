#!/usr/bin/env python3

import argparse
import json
import re
from pathlib import Path
from statistics import mean, median
from datetime import datetime


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Summarize replay completion and no-proxy baseline context metrics "
            "from bin/replay.ts stats files."
        ),
    )
    parser.add_argument("--stats-dir", required=True, help="Directory containing replay stats JSON files")
    parser.add_argument("--suffix", required=True, help="Stats suffix, e.g. __real-llm__stats.json")
    parser.add_argument("--expected", type=int, help="Expected number of rollout files for completion rate")
    parser.add_argument("--rollout-dir", help="Directory containing expected rollout JSONL files")
    parser.add_argument("--log-file", help="Batch log path. Defaults to <stats-dir>/batch.log")
    parser.add_argument("--out", help="Optional path to write the summary JSON")
    return parser.parse_args()


def avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def series(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {
            "count": 0,
            "mean": None,
            "median": None,
            "min": None,
            "max": None,
        }
    return {
        "count": len(values),
        "mean": round(mean(values)),
        "median": round(median(values)),
        "min": min(values),
        "max": max(values),
    }


def pct(numerator: float, denominator: float) -> float | None:
    if denominator == 0:
        return None
    return round(100 * numerator / denominator, 1)


def parse_iso(value: str) -> datetime | None:
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def read_statuses(stats_dir: Path, suffix: str) -> list[dict[str, object]]:
    status_suffix = suffix.replace("__stats.json", "__status.json")
    statuses: list[dict[str, object]] = []
    for path in sorted(stats_dir.glob(f"*{status_suffix}")):
        try:
            status = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(status, dict):
            status["_path"] = str(path)
            statuses.append(status)
    return statuses


def summarize_statuses(statuses: list[dict[str, object]]) -> dict[str, object]:
    counts: dict[str, int] = {}
    elapsed: list[float] = []
    failures: list[dict[str, object]] = []
    running: list[dict[str, object]] = []
    for status in statuses:
        state = str(status.get("status", "unknown"))
        counts[state] = counts.get(state, 0) + 1
        elapsed_s = status.get("elapsed_s")
        if isinstance(elapsed_s, (int, float)) and state in {"succeeded", "failed"}:
            elapsed.append(float(elapsed_s))
        if state == "failed":
            failures.append({
                "rollout": status.get("rollout"),
                "returncode": status.get("returncode"),
                "outputTail": status.get("output_tail"),
            })
        if state == "running":
            running.append({
                "rollout": status.get("rollout"),
                "worker": status.get("worker"),
                "startedAt": status.get("started_at"),
            })
    return {
        "statusFiles": len(statuses),
        "counts": counts,
        "elapsedSecondsPerFinishedReplay": series(elapsed),
        "running": running,
        "failureTails": failures[:10],
    }


def summarize_log(log_file: Path, completed_total: int, expected: int) -> dict[str, object]:
    if not log_file.exists():
        return {"path": str(log_file), "exists": False}

    lines = log_file.read_text(encoding="utf-8", errors="replace").splitlines()
    batch_start: datetime | None = None
    last_event: datetime | None = None
    last_heartbeat: str | None = None
    done_events = 0
    completed_this_run: int | None = None
    queued: int | None = None
    active: int | None = None
    failures: int | None = None

    for line in lines:
        if not line:
            continue
        timestamp = parse_iso(line.split(" ", 1)[0])
        if timestamp is not None:
            last_event = timestamp
            if " batch_start " in line:
                batch_start = timestamp
                last_heartbeat = None
                done_events = 0
                completed_this_run = None
                queued = None
                active = None
                failures = None
                continue
        if batch_start is None:
            continue
        if " done [" in line:
            done_events += 1
        if " heartbeat " in line:
            last_heartbeat = line
            for key, pattern in {
                "completed_this_run": r"completed_this_run=(\d+)/",
                "queued": r"queued=(\d+)",
                "active": r"active=(\d+)",
                "failures": r"failures=(\d+)",
            }.items():
                match = re.search(pattern, line)
                if not match:
                    continue
                value = int(match.group(1))
                if key == "completed_this_run":
                    completed_this_run = value
                elif key == "queued":
                    queued = value
                elif key == "active":
                    active = value
                elif key == "failures":
                    failures = value

    elapsed_s: float | None = None
    throughput_per_hour: float | None = None
    eta_hours: float | None = None
    if batch_start is not None and last_event is not None:
        elapsed_s = max((last_event - batch_start).total_seconds(), 0.0)
        finished_this_run = completed_this_run if completed_this_run is not None else done_events
        if elapsed_s > 0 and finished_this_run > 0:
            throughput_per_hour = round(3600 * finished_this_run / elapsed_s, 2)
            remaining_total = max(expected - completed_total, 0)
            eta_hours = round(remaining_total / throughput_per_hour, 2) if throughput_per_hour > 0 else None

    return {
        "path": str(log_file),
        "exists": True,
        "lines": len(lines),
        "batchStartedAt": batch_start.isoformat() if batch_start else None,
        "lastEventAt": last_event.isoformat() if last_event else None,
        "lastHeartbeat": last_heartbeat,
        "completedThisRun": completed_this_run,
        "doneEventsThisRun": done_events,
        "active": active,
        "queued": queued,
        "failures": failures,
        "elapsedSeconds": round(elapsed_s, 1) if elapsed_s is not None else None,
        "throughputRolloutsPerHour": throughput_per_hour,
        "etaHoursAtCurrentThroughput": eta_hours,
    }


def main() -> int:
    args = parse_args()
    stats_dir = Path(args.stats_dir)
    files = sorted(stats_dir.glob(f"*{args.suffix}"))
    rows = [json.loads(path.read_text(encoding="utf-8")) for path in files]
    if not rows:
        raise SystemExit(f"No stats files matched {args.suffix} in {stats_dir}")

    rounds = [row["rounds"] for row in rows]
    nonempty_rows = [row for row in rows if row["rounds"] > 0]

    baseline_avg = [row["baseline"]["avg"] for row in nonempty_rows]
    baseline_max = [row["baseline"]["max"] for row in nonempty_rows]
    pando_avg = [row["pando"]["avg"] for row in nonempty_rows]
    pando_max = [row["pando"]["max"] for row in nonempty_rows]

    if args.expected is not None:
        expected = args.expected
    elif args.rollout_dir:
        expected = len(list(Path(args.rollout_dir).glob("*.jsonl")))
    else:
        expected = len(rows)
    completed = len(rows)
    avg_baseline_avg = avg(baseline_avg)
    avg_pando_avg = avg(pando_avg)
    avg_baseline_max = avg(baseline_max)
    avg_pando_max = avg(pando_max)

    out = {
        "statsDir": str(stats_dir),
        "suffix": args.suffix,
        "expectedRollouts": expected,
        "completedStatsFiles": completed,
        "statsFileCompletionRatePct": pct(completed, expected),
        "nonemptyReplayRollouts": len(nonempty_rows),
        "nonemptyReplayRatePct": pct(len(nonempty_rows), expected),
        "zeroRoundStatsFiles": completed - len(nonempty_rows),
        "totalRounds": sum(rounds),
        "roundsPerRollout": series(rounds),
        "roundsPerNonemptyRollout": series([row["rounds"] for row in nonempty_rows]),
        "noProxyBaselineApproxInputTokens": {
            "avgPerRolloutAverageTurn": series(baseline_avg),
            "avgPerRolloutMaxTurn": series(baseline_max),
        },
        "proxyRewrittenApproxInputTokens": {
            "avgPerRolloutAverageTurn": series(pando_avg),
            "avgPerRolloutMaxTurn": series(pando_max),
        },
        "aggregateReductionPct": {
            "averageTurn": pct(avg_baseline_avg - avg_pando_avg, avg_baseline_avg),
            "maxTurn": pct(avg_baseline_max - avg_pando_max, avg_baseline_max),
        },
        "status": summarize_statuses(read_statuses(stats_dir, args.suffix)),
        "batchLog": summarize_log(
            Path(args.log_file) if args.log_file else stats_dir / "batch.log",
            completed,
            expected,
        ),
        "evaluationCriteria": [
            "Replay completion: every rollout has a final stats JSON and a succeeded status JSON.",
            "Operational reliability: failed status tails are triaged, resume skips completed stats, and stopped runs leave enough status to continue.",
            "Context size: compare no-proxy baseline average/max turn input tokens with proxy-rewritten average/max turn input tokens.",
            "Speed: track elapsed seconds per replay, rollouts per hour, and ETA from batch status/log events.",
            "Correctness: this replay measures request rewriting and model-call completion only; task success needs fresh agent runs plus repository-specific grading.",
        ],
        "note": (
            "This is replay completion and context-size accounting only. It is not task success; "
            "task success requires fresh no-proxy agent runs plus repository-specific grading."
        ),
    }

    if args.out:
        Path(args.out).write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
