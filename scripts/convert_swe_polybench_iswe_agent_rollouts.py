#!/usr/bin/env python3

import argparse
import json
from pathlib import Path
from typing import Any

import yaml


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert SWE-PolyBench iSWE-agent YAML trajectories into replayable rollout JSONL files.",
    )
    parser.add_argument("inputs", nargs="+", help="Input YAML trajectory files")
    parser.add_argument("--out-dir", required=True, help="Directory to write rollout JSONL files into")
    parser.add_argument(
        "--phase",
        choices=["editing", "localization", "both"],
        default="editing",
        help="Which trajectory block to convert",
    )
    return parser.parse_args()


def content_item(text: str) -> dict[str, Any]:
    return {"type": "input_text", "text": text}


def message_item(role: str, text: str) -> dict[str, Any]:
    normalized_role = "developer" if role == "system" else role
    return {
        "type": "message",
        "role": normalized_role,
        "content": [content_item(text)],
    }


def token_event(usage: dict[str, Any]) -> dict[str, Any]:
    last_token_usage = {
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "total_tokens": usage.get("total_tokens"),
    }
    return {
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "last_token_usage": last_token_usage,
            },
        },
    }


def iter_sections(data: dict[str, Any], phase: str) -> list[tuple[str, dict[str, Any]]]:
    if phase == "both":
        return [
            ("localization", data["localization"]),
            ("editing", data["editing"]),
        ]
    return [(phase, data[phase])]


def convert_file(path: Path, out_dir: Path, phase: str) -> Path:
    data = yaml.safe_load(path.read_text())
    sections = iter_sections(data, phase)
    instance_id = data["editing"]["instance_id"]
    events: list[dict[str, Any]] = [{
        "type": "session_meta",
        "payload": {
            "id": f"{instance_id}-{phase}",
            "source": f"swe_polybench_iswe_agent_{phase}",
            "cwd": "/tmp/SWE-PolyBench-submission",
            "model_provider": "submitted-trajectory",
        },
    }]

    for section_name, section in sections:
        trajectory = section.get("trajectory", [])
        usages = list(section.get("tokens_usage_info", []))
        assistant_index = 0

        for item in trajectory:
            role = item.get("role")
            content = item.get("content", "")
            if role not in {"system", "user", "assistant"} or not isinstance(content, str):
                continue
            events.append({"type": "response_item", "payload": message_item(role, content)})
            if role == "assistant" and assistant_index < len(usages):
                events.append(token_event(usages[assistant_index]))
                assistant_index += 1

        if section_name != sections[-1][0]:
            events.append({
                "type": "response_item",
                "payload": message_item(
                    "developer",
                    f"<swe_polybench_phase_transition>{section_name}_complete</swe_polybench_phase_transition>",
                ),
            })

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{instance_id}__{phase}.jsonl"
    out_path.write_text("".join(json.dumps(event) + "\n" for event in events))
    return out_path


def main() -> int:
    args = parse_args()
    out_dir = Path(args.out_dir)
    for raw in args.inputs:
        path = Path(raw)
        out_path = convert_file(path, out_dir, args.phase)
        print(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
