#!/usr/bin/env python3

import argparse
import json
import re
import urllib.request
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch a Hugging Face dataset made of direct .traj.json files and convert each file to replayable rollout JSONL.",
    )
    parser.add_argument("--dataset", required=True, help="Dataset id, e.g. owner/name")
    parser.add_argument("--out-dir", required=True, help="Directory for raw and converted outputs")
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Optional limit on number of trajectories to fetch",
    )
    parser.add_argument(
        "--paths-file",
        help=(
            "Optional newline-delimited list of .traj.json paths to fetch. "
            "When set, --limit is applied after this list is read."
        ),
    )
    return parser.parse_args()


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


def fetch_json_page(url: str) -> tuple[Any, str | None]:
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = json.load(response)
        link = response.headers.get("Link", "")
    match = re.search(r'<([^>]+)>;\s*rel="next"', link)
    return payload, match.group(1) if match else None


def list_traj_files(dataset: str) -> list[str]:
    """Return every .traj.json path exposed by the dataset tree API."""
    url: str | None = (
        f"https://huggingface.co/api/datasets/{dataset}/tree/main"
        "?recursive=true&expand=true"
    )
    files: list[str] = []
    while url:
        payload, url = fetch_json_page(url)
        if not isinstance(payload, list):
            raise SystemExit(f"Unexpected Hugging Face tree response for {dataset}")
        for item in payload:
            path = item.get("path") if isinstance(item, dict) else None
            if isinstance(path, str) and path.endswith(".traj.json"):
                files.append(path)

    if files:
        return sorted(files)

    dataset_meta = fetch_json(f"https://huggingface.co/api/datasets/{dataset}")
    return sorted(
        sibling["rfilename"]
        for sibling in dataset_meta.get("siblings", [])
        if sibling.get("rfilename", "").endswith(".traj.json")
    )


def content_item(text: str) -> dict[str, Any]:
    return {"type": "input_text", "text": text}


def message_item(role: str, text: str) -> dict[str, Any]:
    normalized_role = "developer" if role == "system" else role
    return {
        "type": "message",
        "role": normalized_role,
        "content": [content_item(text)],
    }


def build_events(payload: dict[str, Any], dataset: str, traj_path: str) -> list[dict[str, Any]]:
    meta = {
        "type": "session_meta",
        "payload": {
            "id": traj_path.replace("/", "__").removesuffix(".traj.json"),
            "source": dataset,
            "source_url": f"https://huggingface.co/datasets/{dataset}",
            "instance_id": payload.get("instance_id"),
            "traj_id": traj_path,
            "model": payload.get("info", {}).get("config", {}).get("model", {}).get("name"),
            "format": payload.get("trajectory_format"),
        },
    }
    events = [meta]
    for message in payload.get("messages", []):
        role = message.get("role")
        text = message.get("content")
        if role not in {"system", "user", "assistant"}:
            continue
        if not isinstance(text, str) or not text.strip():
            continue
        events.append({"type": "response_item", "payload": message_item(role, text)})
    return events


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out_dir)
    raw_dir = out_dir / "raw"
    converted_dir = out_dir / "converted"
    raw_dir.mkdir(parents=True, exist_ok=True)
    converted_dir.mkdir(parents=True, exist_ok=True)

    if args.paths_file:
        traj_files = [
            line.strip()
            for line in Path(args.paths_file).read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        ]
    else:
        traj_files = list_traj_files(args.dataset)
    if args.limit > 0:
        traj_files = traj_files[:args.limit]

    manifest: list[dict[str, Any]] = []

    for traj_path in traj_files:
        payload = fetch_json(f"https://huggingface.co/datasets/{args.dataset}/resolve/main/{traj_path}")
        safe_name = traj_path.replace("/", "__").removesuffix(".traj.json")
        raw_path = raw_dir / f"{safe_name}.json"
        converted_path = converted_dir / f"{safe_name}.jsonl"
        raw_path.write_text(json.dumps(payload, indent=2) + "\n")
        events = build_events(payload, args.dataset, traj_path)
        converted_path.write_text("".join(json.dumps(event) + "\n" for event in events))
        manifest.append({
            "dataset": args.dataset,
            "instance_id": payload.get("instance_id"),
            "traj_path": traj_path,
            "raw_path": str(raw_path),
            "converted_path": str(converted_path),
            "event_count": len(events),
        })
        print(converted_path)

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
