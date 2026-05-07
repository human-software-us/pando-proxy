#!/usr/bin/env python3

import argparse
import collections
import datetime as dt
import json
import os
import queue
import subprocess
import threading
import time
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run the Metabase backend functional test suite against each generated "
            "Metabase #42434 benchmark task repo."
        ),
    )
    parser.add_argument("--run-root", required=True, help="Metabase #42434 benchmark run root")
    parser.add_argument("--out-dir", required=True, help="Directory for test logs and summary")
    parser.add_argument("--workers", type=int, default=1, help="Parallel test workers")
    parser.add_argument("--timeout-seconds", type=int, default=7200, help="Timeout per task repo")
    parser.add_argument("--progress-seconds", type=int, default=30, help="Seconds between live progress log lines")
    parser.add_argument(
        "--base-jetty-port",
        type=int,
        help="When set, assign each worker a distinct mb.jetty.port starting at this value.",
    )
    parser.add_argument("--resume", action="store_true", help="Skip repos with a finished status JSON")
    parser.add_argument(
        "--command",
        nargs=argparse.REMAINDER,
        help="Command to run inside each repo. Defaults to bin/test-agent.",
    )
    return parser.parse_args()


def now() -> str:
    return dt.datetime.now(dt.UTC).astimezone().isoformat(timespec="seconds")


class Logger:
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


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def compact_line(line: str, max_len: int = 220) -> str:
    text = " ".join(line.strip().split())
    if len(text) <= max_len:
        return text
    return text[: max_len - 3] + "..."


def command_with_jetty_port(command: list[str], port: int | None) -> list[str]:
    if port is None:
        return command
    effective = list(command)
    if effective and Path(effective[0]).name == "clojure" and not any(
        arg.startswith("-J-Dmb.jetty.port=") for arg in effective
    ):
        effective.insert(1, f"-J-Dmb.jetty.port={port}")
    return effective


def task_id(task_dir: Path) -> str:
    return task_dir.name


def condition_for(task_dir: Path, run_root: Path) -> str:
    return task_dir.relative_to(run_root).parts[0]


def status_path(out_dir: Path, condition: str, task_name: str) -> Path:
    return out_dir / condition / task_name / "status.json"


def stdout_path(out_dir: Path, condition: str, task_name: str) -> Path:
    return out_dir / condition / task_name / "suite.log"


def discover_tasks(run_root: Path) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for condition in ("no-proxy", "with-pando-proxy"):
        for summary_path in sorted((run_root / condition / "tasks").glob("*/summary.json")):
            summary = read_json(summary_path)
            repo = summary_path.parent / "repo"
            tasks.append({
                "condition": condition,
                "taskName": task_id(summary_path.parent),
                "taskNumber": summary.get("task_number"),
                "taskTitle": summary.get("task_title"),
                "repo": str(repo),
                "summaryPath": str(summary_path),
            })
    return tasks


def already_finished(path: Path) -> bool:
    if not path.exists():
        return False
    try:
        status = read_json(path)
    except (OSError, json.JSONDecodeError):
        return False
    return status.get("status") in {"passed", "failed", "timeout", "error"}


def run_one(
    task: dict[str, Any],
    out_dir: Path,
    command: list[str],
    timeout_seconds: int,
    progress_seconds: int,
    worker_id: int,
    jetty_port: int | None,
    logger: Logger,
) -> dict[str, Any]:
    condition = str(task["condition"])
    name = str(task["taskName"])
    repo = Path(str(task["repo"]))
    log_path = stdout_path(out_dir, condition, name)
    stat_path = status_path(out_dir, condition, name)
    effective_command = command_with_jetty_port(command, jetty_port)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    status: dict[str, Any] = {
        **task,
        "status": "running",
        "command": effective_command,
        "startedAt": now(),
        "logPath": str(log_path),
        "timeoutSeconds": timeout_seconds,
        "workerId": worker_id,
        "jettyPort": jetty_port,
    }
    write_json(stat_path, status)
    logger.log(f"start condition={condition} task={task.get('taskNumber')} repo={repo}")
    start = time.monotonic()
    env = os.environ.copy()
    env.setdefault("HAWK_MODE", "cli/ci")
    env.setdefault("MB_COLORIZE_LOGS", "false")
    if jetty_port is not None:
        env["MB_JETTY_PORT"] = str(jetty_port)
    try:
        with log_path.open("w", encoding="utf-8", errors="replace") as log:
            log.write(f"$ {' '.join(effective_command)}\n")
            log.flush()
            proc = subprocess.Popen(
                effective_command,
                cwd=repo,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=1,
                universal_newlines=True,
                text=True,
            )
            status.update({"pid": proc.pid})
            write_json(stat_path, status)
            logger.log(
                f"spawned condition={condition} task={task.get('taskNumber')} "
                f"pid={proc.pid} log={log_path}"
            )

            sentinel = object()
            output_queue: queue.Queue[str | object] = queue.Queue()

            def read_output() -> None:
                assert proc.stdout is not None
                try:
                    for line in proc.stdout:
                        output_queue.put(line)
                finally:
                    output_queue.put(sentinel)

            reader = threading.Thread(target=read_output, daemon=True)
            reader.start()
            last_line = ""
            last_output_at: str | None = None
            next_progress = time.monotonic() + max(progress_seconds, 1)
            recent = collections.deque(maxlen=5)
            while True:
                try:
                    line = output_queue.get(timeout=1)
                except queue.Empty:
                    line = None
                if line is sentinel:
                    if proc.poll() is not None and output_queue.empty():
                        break
                elif isinstance(line, str):
                    log.write(line)
                    log.flush()
                    clean = compact_line(line)
                    if clean:
                        last_line = clean
                        last_output_at = now()
                        recent.append(clean)
                        if (
                            clean.startswith("FAIL in ")
                            or clean.startswith("ERROR in ")
                            or clean.startswith("LONG TEST in ")
                            or clean.startswith("Testing ")
                            or " tests, " in clean
                        ):
                            logger.log(
                                f"event condition={condition} task={task.get('taskNumber')} "
                                f"elapsed_s={round(time.monotonic() - start, 1)} output={json.dumps(clean)}"
                            )
                elapsed = time.monotonic() - start
                current = time.monotonic()
                if current >= next_progress:
                    status.update({
                        "elapsedSeconds": round(elapsed, 1),
                        "lastOutputAt": last_output_at,
                        "lastOutputLine": last_line,
                        "logBytes": log_path.stat().st_size if log_path.exists() else None,
                    })
                    write_json(stat_path, status)
                    logger.log(
                        f"progress condition={condition} task={task.get('taskNumber')} "
                        f"pid={proc.pid} elapsed_s={round(elapsed, 1)} "
                        f"log_bytes={status.get('logBytes')} "
                        f"last_output={json.dumps(last_line or '<no output yet>')}"
                    )
                    next_progress = current + max(progress_seconds, 1)
                if elapsed > timeout_seconds:
                    proc.kill()
                    raise subprocess.TimeoutExpired(effective_command, timeout_seconds)

            returncode = proc.wait()
            reader.join(timeout=5)
            result = subprocess.CompletedProcess(
                effective_command,
                returncode,
                stdout=None,
                stderr=None,
            )
        elapsed = time.monotonic() - start
        status.update({
            "status": "passed" if result.returncode == 0 else "failed",
            "returncode": result.returncode,
            "elapsedSeconds": round(elapsed, 1),
            "finishedAt": now(),
            "lastOutputLine": last_line,
            "lastOutputAt": last_output_at,
            "logBytes": log_path.stat().st_size if log_path.exists() else None,
        })
    except subprocess.TimeoutExpired:
        elapsed = time.monotonic() - start
        with log_path.open("a", encoding="utf-8", errors="replace") as log:
            log.write(f"\nTIMEOUT after {timeout_seconds} seconds\n")
        status.update({
            "status": "timeout",
            "returncode": None,
            "elapsedSeconds": round(elapsed, 1),
            "finishedAt": now(),
        })
    except Exception as exc:  # noqa: BLE001 - status JSON should preserve unexpected failures.
        elapsed = time.monotonic() - start
        with log_path.open("a", encoding="utf-8", errors="replace") as log:
            log.write(f"\nERROR: {exc!r}\n")
        status.update({
            "status": "error",
            "error": repr(exc),
            "returncode": None,
            "elapsedSeconds": round(elapsed, 1),
            "finishedAt": now(),
        })
    write_json(stat_path, status)
    logger.log(
        f"done condition={condition} task={task.get('taskNumber')} "
        f"status={status['status']} elapsed_s={status.get('elapsedSeconds')}"
    )
    return status


def main() -> int:
    args = parse_args()
    run_root = Path(args.run_root)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    logger = Logger(out_dir / "functional-test-batch.log")
    command = args.command if args.command else ["./bin/test-agent"]
    if command and command[0] == "--":
        command = command[1:]

    tasks = discover_tasks(run_root)
    if not tasks:
        raise SystemExit(f"No task summaries found under {run_root}")

    work: queue.Queue[dict[str, Any]] = queue.Queue()
    skipped = 0
    for task in tasks:
        stat_path = status_path(out_dir, str(task["condition"]), str(task["taskName"]))
        if args.resume and already_finished(stat_path):
            skipped += 1
            continue
        work.put(task)

    logger.log(
        f"batch_start tasks={len(tasks)} queued={work.qsize()} skipped={skipped} "
        f"workers={args.workers} command={' '.join(command)}"
    )
    results: list[dict[str, Any]] = []
    results_lock = threading.Lock()

    def worker(worker_id: int) -> None:
        while True:
            try:
                task = work.get_nowait()
            except queue.Empty:
                return
            logger.log(f"worker={worker_id} picked condition={task['condition']} task={task['taskNumber']}")
            jetty_port = args.base_jetty_port + worker_id - 1 if args.base_jetty_port else None
            status = run_one(
                task,
                out_dir,
                command,
                args.timeout_seconds,
                args.progress_seconds,
                worker_id,
                jetty_port,
                logger,
            )
            with results_lock:
                results.append(status)
            work.task_done()

    threads = [
        threading.Thread(target=worker, args=(i + 1,), daemon=False)
        for i in range(min(max(args.workers, 1), max(work.qsize(), 1)))
    ]
    for thread in threads:
        thread.start()
    while any(thread.is_alive() for thread in threads):
        time.sleep(30)
        logger.log(f"heartbeat queued={work.qsize()} finished_this_run={len(results)}")
    for thread in threads:
        thread.join()

    all_statuses = []
    for path in sorted(out_dir.glob("*/*/status.json")):
        all_statuses.append(read_json(path))
    counts: dict[str, int] = {}
    for status in all_statuses:
        state = str(status.get("status", "unknown"))
        counts[state] = counts.get(state, 0) + 1
    summary = {
        "runRoot": str(run_root),
        "outDir": str(out_dir),
        "command": command,
        "timeoutSeconds": args.timeout_seconds,
        "taskRepos": len(tasks),
        "statusCounts": counts,
        "statuses": all_statuses,
        "finishedAt": now(),
    }
    write_json(out_dir / "summary.json", summary)
    logger.log(f"batch_complete counts={counts}")
    print(json.dumps(summary, indent=2))
    return 0 if counts.get("failed", 0) == 0 and counts.get("timeout", 0) == 0 and counts.get("error", 0) == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
