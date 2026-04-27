# Public Transcript Corpora

This folder is documentation-only. Public trajectories used for replay experiments are fetched and
converted locally, but the raw transcript payloads are intentionally not checked into the repo.

Current fetch/convert helper:

```sh
python3 scripts/fetch_hf_traj_json_dataset.py \
  --dataset pankajmathur/devstral-24b-swebench-verified-traj \
  --out-dir /tmp/pando-devstral-verified-all
```

The helper enumerates the dataset's paginated Hugging Face tree API and, with no `--limit`, fetches
the complete currently exposed `.traj.json` set. The committed full list is
[`benchmarks/results/devstral_verified_full_selection.json`](../results/devstral_verified_full_selection.json).

Typical local outputs:

- `raw/`: downloaded `.traj.json` payloads
- `converted/`: replayable rollout JSONL files
- `manifest.json`: provenance for every converted rollout

To replay the full fetched devstral Verified corpus with the deterministic stub policy, omit
`--real-llm` so the run is only naive processing and measurement:

```sh
python3 scripts/run_replay_batch.py \
  --rollout-dir /tmp/pando-devstral-verified-all/converted \
  --out-dir tmp/replay-devstral-verified-batch-current \
  --workers 4 \
  --policy drop-tools

python3 scripts/aggregate_replay_stats.py \
  --stats-dir tmp/replay-devstral-verified-batch-current \
  --suffix __drop-tools__stats.json \
  --out tmp/replay-devstral-verified-batch-current.aggregate.json
```

To replay only the committed public top-20 selection, which is a small sample rather than the full
benchmark corpus:

```sh
python3 scripts/materialize_rollout_subset.py \
  --selection-json benchmarks/results/devstral_verified_top20_selection.json \
  --source-dir /tmp/pando-devstral-verified-all \
  --out-dir /tmp/pando-devstral-top20

python3 scripts/run_replay_batch.py \
  --rollout-dir /tmp/pando-devstral-top20/converted \
  --out-dir tmp/replay-devstral-top20-stub-current \
  --workers 4 \
  --policy drop-tools

python3 scripts/aggregate_replay_stats.py \
  --stats-dir tmp/replay-devstral-top20-stub-current \
  --suffix __drop-tools__stats.json \
  --out tmp/replay-devstral-top20-stub-current.aggregate.json
```

Committed benchmark summaries live under [`benchmarks/results`](../results).
