#!/usr/bin/env python3

import argparse
import concurrent.futures
import subprocess
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
        help="Stub policy to use when not running --real-llm",
    )
    parser.add_argument(
        "--real-llm",
        action="store_true",
        help="Run with --real-llm --auth-from-codex",
    )
    return parser.parse_args()


def run_one(path: Path, out_dir: Path, policy: str, real_llm: bool) -> tuple[str, int, str]:
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
        cmd += ["--real-llm", "--auth-from-codex"]
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
    paths = sorted(rollout_dir.glob("*.jsonl"))
    if not paths:
        raise SystemExit(f"No rollout JSONL files found in {rollout_dir}")

    failures: list[tuple[str, str]] = []
    completed = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(run_one, path, out_dir, args.policy, args.real_llm): path
            for path in paths
        }
        for future in concurrent.futures.as_completed(futures):
            name, code, output = future.result()
            completed += 1
            if code != 0:
                failures.append((name, output[-4000:]))
            print(f"[{completed}/{len(paths)}] {name} rc={code}")

    if failures:
        print("\nFAILURES")
        for name, output in failures[:20]:
            print(f"--- {name} ---")
            print(output)
        raise SystemExit(1)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
