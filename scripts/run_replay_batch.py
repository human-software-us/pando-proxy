#!/usr/bin/env python3

import argparse
import datetime as dt
import json
import queue
import signal
import subprocess
import threading
import time
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run bin/replay.ts over every rollout JSONL file in a directory.",
    )
    parser.add_argument("--rollout-dir", required=True, help="Directory containing rollout JSONL files")
    parser.add_argument("--out-dir", required=True, help="Directory where replay outputs should go")
    parser.add_argument("--workers", type=int, default=4, help="Parallel replay workers")
    parser.add_argument(
        "--policy",
        default="drop-tools",
        help="Stub policy to use for deterministic naive replay when --real-llm is omitted",
    )
    parser.add_argument(
        "--real-llm",
        action="store_true",
        help="Opt into live model calls by passing --real-llm --auth-from-codex to bin/replay.ts",
    )
    parser.add_argument(
        "--request-model",
        default="gpt-5.4",
        help="Model to pass to bin/replay.ts when --real-llm is set",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Skip rollout files that already have a non-empty final stats JSON in --out-dir",
    )
    parser.add_argument(
        "--log-file",
        help="Batch progress log path. Defaults to <out-dir>/batch.log",
    )
    parser.add_argument(
        "--heartbeat-seconds",
        type=float,
        default=30.0,
        help="How often to write batch heartbeat log lines while workers are active",
    )
    return parser.parse_args()


def output_tag(policy: str, real_llm: bool) -> str:
    return "real-llm" if real_llm else policy


def stats_path_for(path: Path, out_dir: Path, policy: str, real_llm: bool) -> Path:
    return out_dir / f"{path.stem}__{output_tag(policy, real_llm)}__stats.json"


def status_path_for(path: Path, out_dir: Path, policy: str, real_llm: bool) -> Path:
    return out_dir / f"{path.stem}__{output_tag(policy, real_llm)}__status.json"


def is_completed(path: Path, out_dir: Path, policy: str, real_llm: bool) -> bool:
    stats_path = stats_path_for(path, out_dir, policy, real_llm)
    if not stats_path.exists() or stats_path.stat().st_size == 0:
        return False
    try:
        stats = json.loads(stats_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(stats, dict) and isinstance(stats.get("rounds"), int)


def now() -> str:
    return dt.datetime.now(dt.UTC).astimezone().isoformat(timespec="seconds")


class BatchLogger:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.lock = threading.Lock()
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, message: str) -> None:
        line = f"{now()} {message}"
        with self.lock:
            print(line, flush=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
                f.flush()


def write_json_atomic(path: Path, data: dict[str, object]) -> None:
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def run_one(
    path: Path,
    out_dir: Path,
    policy: str,
    real_llm: bool,
    request_model: str,
) -> tuple[str, int, str]:
    cmd = [
        "deno",
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        "bin/replay.ts",
        "--rollout",
        str(path),
        "--out-dir",
        str(out_dir),
    ]
    if real_llm:
        cmd += ["--real-llm", "--auth-from-codex", "--request-model", request_model]
    else:
        cmd += ["--policy", policy]

    result = subprocess.run(
        cmd,
        cwd=Path(__file__).resolve().parent.parent,
        capture_output=True,
        text=True,
    )
    output = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    return path.name, result.returncode, output


def main() -> int:
    args = parse_args()
    rollout_dir = Path(args.rollout_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    log_file = Path(args.log_file) if args.log_file else out_dir / "batch.log"
    logger = BatchLogger(log_file)

    paths = sorted(rollout_dir.glob("*.jsonl"))
    if not paths:
        raise SystemExit(f"No rollout JSONL files found in {rollout_dir}")

    total_paths = len(paths)
    skipped = 0
    if args.resume:
        remaining = []
        for path in paths:
            if is_completed(path, out_dir, args.policy, args.real_llm):
                skipped += 1
            else:
                remaining.append(path)
        paths = remaining

    failures: list[tuple[str, str]] = []
    completed = 0
    active = 0
    active_lock = threading.Lock()
    failures_lock = threading.Lock()
    stop_event = threading.Event()
    work: queue.Queue[Path] = queue.Queue()
    for path in paths:
        work.put(path)

    def handle_stop(signum: int, _frame: object) -> None:
        logger.log(
            f"received signal {signum}; stopping after active replay workers finish"
        )
        stop_event.set()

    signal.signal(signal.SIGINT, handle_stop)
    signal.signal(signal.SIGTERM, handle_stop)

    logger.log(
        f"batch_start total={total_paths} skipped={skipped} queued={len(paths)} "
        f"workers={args.workers} real_llm={args.real_llm} out_dir={out_dir}"
    )

    def worker(worker_id: int) -> None:
        nonlocal active, completed
        while not stop_event.is_set():
            try:
                path = work.get_nowait()
            except queue.Empty:
                return
            with active_lock:
                active += 1
            start = time.monotonic()
            status_path = status_path_for(path, out_dir, args.policy, args.real_llm)
            write_json_atomic(
                status_path,
                {
                    "status": "running",
                    "rollout": str(path),
                    "worker": worker_id,
                    "started_at": now(),
                },
            )
            logger.log(f"worker={worker_id} start {path.name}")
            try:
                name, code, output = run_one(
                    path,
                    out_dir,
                    args.policy,
                    args.real_llm,
                    args.request_model,
                )
            except Exception as exc:  # noqa: BLE001 - surface worker failures in the batch log.
                name, code, output = path.name, 1, repr(exc)
            duration = time.monotonic() - start
            with active_lock:
                active -= 1
                completed += 1
                done = completed
                active_now = active
                queued_now = work.qsize()
            status = "succeeded" if code == 0 else "failed"
            status_data: dict[str, object] = {
                "status": status,
                "rollout": str(path),
                "worker": worker_id,
                "returncode": code,
                "elapsed_s": round(duration, 1),
                "finished_at": now(),
                "stats_path": str(stats_path_for(path, out_dir, args.policy, args.real_llm)),
            }
            if code != 0:
                output_tail = output[-4000:]
                status_data["output_tail"] = output_tail
                with failures_lock:
                    failures.append((name, output_tail))
            write_json_atomic(status_path, status_data)
            logger.log(
                f"worker={worker_id} done [{done}/{len(paths)}] active={active_now} "
                f"queued={queued_now} {name} rc={code} elapsed_s={duration:.1f}"
            )
            work.task_done()

    workers = [
        threading.Thread(target=worker, args=(i + 1,), daemon=False)
        for i in range(min(args.workers, len(paths)))
    ]
    for thread in workers:
        thread.start()

    heartbeat_seconds = max(args.heartbeat_seconds, 0.1)
    next_heartbeat = time.monotonic() + heartbeat_seconds
    while any(thread.is_alive() for thread in workers):
        time.sleep(0.5)
        if time.monotonic() >= next_heartbeat:
            with active_lock:
                active_now = active
                completed_now = completed
                queued_now = work.qsize()
            with failures_lock:
                failure_count = len(failures)
            logger.log(
                f"heartbeat completed_this_run={completed_now}/{len(paths)} "
                f"skipped={skipped} active={active_now} queued={queued_now} "
                f"failures={failure_count}"
            )
            next_heartbeat = time.monotonic() + heartbeat_seconds

    for thread in workers:
        thread.join()

    if stop_event.is_set():
        logger.log(
            f"batch_stopped completed_this_run={completed} skipped={skipped} "
            f"remaining={work.qsize()} failures={len(failures)}"
        )
        return 130

    if failures:
        logger.log("FAILURES")
        for name, output in failures[:20]:
            logger.log(f"--- {name} ---")
            logger.log(output)
        raise SystemExit(1)

    logger.log(f"batch_complete completed_this_run={completed} skipped={skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
