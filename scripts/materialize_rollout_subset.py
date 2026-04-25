#!/usr/bin/env python3

import argparse
import json
import shutil
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Materialize a selected subset of fetched rollout files into a new directory "
            "using a selection JSON such as benchmarks/results/devstral_verified_top20_selection.json."
        ),
    )
    parser.add_argument(
        "--selection-json",
        required=True,
        help="Selection JSON containing an items array with rollout ids",
    )
    parser.add_argument(
        "--source-dir",
        required=True,
        help="Directory produced by scripts/fetch_hf_traj_json_dataset.py",
    )
    parser.add_argument(
        "--out-dir",
        required=True,
        help="Directory to write the selected raw/ and converted/ files into",
    )
    parser.add_argument(
        "--skip-raw",
        action="store_true",
        help="Only materialize converted rollout JSONL files",
    )
    parser.add_argument(
        "--symlink",
        action="store_true",
        help="Create symlinks instead of copying files",
    )
    return parser.parse_args()


def load_json(path: Path) -> object:
    return json.loads(path.read_text())


def materialize_file(source: Path, dest: Path, symlink: bool) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        dest.unlink()
    if symlink:
        dest.symlink_to(source.resolve())
    else:
        shutil.copy2(source, dest)


def main() -> int:
    args = parse_args()
    selection_path = Path(args.selection_json)
    source_dir = Path(args.source_dir)
    out_dir = Path(args.out_dir)

    selection = load_json(selection_path)
    if not isinstance(selection, dict):
        raise SystemExit(f"Expected object in {selection_path}")

    items = selection.get("items")
    if not isinstance(items, list) or not items:
        raise SystemExit(f"No selection items found in {selection_path}")

    source_converted_dir = source_dir / "converted"
    source_raw_dir = source_dir / "raw"
    out_converted_dir = out_dir / "converted"
    out_raw_dir = out_dir / "raw"
    out_converted_dir.mkdir(parents=True, exist_ok=True)
    if not args.skip_raw:
        out_raw_dir.mkdir(parents=True, exist_ok=True)

    selected_manifest: list[dict[str, object]] = []

    for item in items:
        if not isinstance(item, dict):
            raise SystemExit(f"Malformed selection entry in {selection_path}: {item!r}")
        rollout_id = item.get("id")
        if not isinstance(rollout_id, str) or not rollout_id:
            raise SystemExit(f"Selection entry missing id in {selection_path}: {item!r}")

        converted_source = source_converted_dir / f"{rollout_id}.jsonl"
        if not converted_source.exists():
            raise SystemExit(f"Missing converted rollout: {converted_source}")
        converted_dest = out_converted_dir / converted_source.name
        materialize_file(converted_source, converted_dest, args.symlink)

        raw_dest_path: str | None = None
        raw_source = source_raw_dir / f"{rollout_id}.json"
        if not args.skip_raw:
            if not raw_source.exists():
                raise SystemExit(f"Missing raw rollout: {raw_source}")
            raw_dest = out_raw_dir / raw_source.name
            materialize_file(raw_source, raw_dest, args.symlink)
            raw_dest_path = str(raw_dest)

        selected_manifest.append({
            **item,
            "selection_json": str(selection_path),
            "source_dir": str(source_dir),
            "raw_path": raw_dest_path,
            "converted_path": str(converted_dest),
        })
        print(converted_dest)

    manifest = {
        "selection_json": str(selection_path),
        "source_dir": str(source_dir),
        "out_dir": str(out_dir),
        "samples": len(selected_manifest),
        "items": selected_manifest,
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
