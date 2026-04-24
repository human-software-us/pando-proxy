# Public Transcript Corpora

This folder is documentation-only. Public trajectories used for replay experiments are fetched and
converted locally, but the raw transcript payloads are intentionally not checked into the repo.

Current fetch/convert helper:

```sh
python3 scripts/fetch_hf_traj_json_dataset.py \
  --dataset pankajmathur/devstral-24b-swebench-verified-traj \
  --out-dir /tmp/pando-devstral-verified-all
```

Typical local outputs:

- `raw/`: downloaded `.traj.json` payloads
- `converted/`: replayable rollout JSONL files
- `manifest.json`: provenance for every converted rollout

Committed benchmark summaries live under [`benchmarks/results`](../results).
