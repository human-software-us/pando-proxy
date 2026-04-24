#!/usr/bin/env python3

import argparse
import json
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
    return parser.parse_args()


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


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

    dataset_meta = fetch_json(f"https://huggingface.co/api/datasets/{args.dataset}")
    traj_files = sorted(
        sibling["rfilename"]
        for sibling in dataset_meta.get("siblings", [])
        if sibling.get("rfilename", "").endswith(".traj.json")
    )
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
