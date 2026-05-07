# Replay Benchmarks

Public source links, related research, and candidate next benchmark inputs are collected in
[`benchmarks/SOURCES.md`](./benchmarks/SOURCES.md).

This file describes benchmark runs for the current shipped active-task working-set runtime.

The public reruns below use the deterministic stub replay path. Run these without `--real-llm`; they
measure request rewriting and replay accounting, not live model keep/drop quality:

```sh
python3 scripts/run_replay_batch.py \
  --rollout-dir <dir-of-rollout-jsonl-files> \
  --out-dir <out-dir> \
  --workers 4 \
  --policy drop-tools
```

## SWE-bench Verified devstral full corpus

The full-corpus pass used all `.traj.json` files exposed by:

- <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

Committed artifacts:

- [`benchmarks/results/devstral_verified_full_selection.json`](./benchmarks/results/devstral_verified_full_selection.json)
- [`benchmarks/results/devstral_verified_drop_tools_batch.json`](./benchmarks/results/devstral_verified_drop_tools_batch.json)

Reproduction:

```sh
python3 scripts/fetch_hf_traj_json_dataset.py \
  --dataset pankajmathur/devstral-24b-swebench-verified-traj \
  --out-dir /tmp/pando-devstral-verified-all

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

Aggregate across all `345` fetched trajectories:

| Set                                             | Samples | Rounds | Policy       | Avg baseline min | Avg pando min | Avg baseline avg | Avg pando avg | Avg baseline max | Avg pando max | Avg avg savings | Avg max savings | Aggregate avg reduction | Aggregate peak reduction |
| ----------------------------------------------- | ------: | -----: | ------------ | ---------------: | ------------: | ---------------: | ------------: | ---------------: | ------------: | --------------: | --------------: | ----------------------: | -----------------------: |
| SWE-bench Verified devstral public trajectories |     345 | 21,709 | `drop-tools` |            1,402 |           631 |           15,199 |         1,093 |           33,636 |         7,212 |          14,105 |          26,424 |                   92.8% |                    78.6% |

Additional distribution notes:

- 71.6% of traces had positive average-token savings
- 71.3% of traces had positive peak-token savings
- mean per-trace average reduction was 90.9%
- mean per-trace peak reduction was 83.5%
- median per-trace average reduction was 91.6%
- median per-trace peak reduction was 86.5%

## SWE-bench Verified devstral top-20 sample

This is a small comparison sample from the same dataset, not the full benchmark set. It selects:

- top `10` traces by replay round count
- plus top `10` additional trajectories by raw fetched transcript bytes

Committed artifacts:

- [`benchmarks/results/devstral_verified_top20_selection.json`](./benchmarks/results/devstral_verified_top20_selection.json)
- [`benchmarks/results/devstral_verified_top20_stub.json`](./benchmarks/results/devstral_verified_top20_stub.json)

Reproduction:

```sh
python3 scripts/fetch_hf_traj_json_dataset.py \
  --dataset pankajmathur/devstral-24b-swebench-verified-traj \
  --out-dir /tmp/pando-devstral-verified-all

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

Aggregate across that selected top-20 set:

| Set                                | Samples | Rounds | Mode         | Avg baseline avg | Avg pando avg | Avg baseline max | Avg pando max | Aggregate avg reduction | Aggregate peak reduction | Mean per-trace avg reduction | Mean per-trace peak reduction |
| ---------------------------------- | ------: | -----: | ------------ | ---------------: | ------------: | ---------------: | ------------: | ----------------------: | -----------------------: | ---------------------------: | ----------------------------: |
| SWE-bench Verified devstral top-20 |      20 |  3,807 | `drop-tools` |           43,924 |         2,069 |          142,623 |        60,772 |                   95.3% |                    57.4% |                        92.9% |                         69.5% |

Notes:

- All `20` selected traces had positive average-token savings.
- All `20` selected traces had positive peak-token savings.
- Median per-trace average reduction was 96.6%.
- Median per-trace peak reduction was 92.2%.

## Set Summary

| Set                                     | Samples | Avg baseline min | Avg pando min | Avg baseline avg | Avg pando avg | Avg baseline max | Avg pando max | Avg avg savings | Avg max savings |
| --------------------------------------- | ------: | ---------------: | ------------: | ---------------: | ------------: | ---------------: | ------------: | --------------: | --------------: |
| SWE-bench Verified devstral full corpus |     345 |            1,402 |           462 |           15,199 |           936 |           33,636 |         7,085 |          14,262 |          26,551 |
| SWE-bench Verified devstral top-20      |      20 |            2,069 |           713 |           43,924 |         2,069 |          142,623 |        60,772 |          41,856 |          81,851 |

## Interpretation

- `baseline` is the replay estimate for the usual Codex behavior: carry the accumulated request
  history forward and send it again on the next turn.
- `pando` is the replay estimate after `rewriteRequestWithMemory(...)` rebuilds the request using
  the current active-task working-set memory block.
- These values are `approxInputTokens` from `src/metrics.ts`. They are intended for relative
  prompt-size comparisons inside this repo.
- These benchmark rows measure prompt-size reduction. They do not measure task success rate.
- The deterministic `drop-tools` policy is cheap and reproducible. It should not be interpreted as
  live structured-model pruning quality.

## Artifact Files

The current benchmark commands emit:

- `tmp/replay-devstral-verified-batch-current/*__stats.json`
- `tmp/replay-devstral-top20-stub-current/*__stats.json`

Committed aggregate result files used by the benchmark docs live under
[`benchmarks/results`](./benchmarks/results).

## Research Context

Several papers support the general premise that smaller, cleaner prompts can help long-context model
behavior:

- Nelson F. Liu et al., "Lost in the Middle: How Language Models Use Long Contexts":
  <https://arxiv.org/abs/2307.03172>
- Freda Shi et al., "Large Language Models Can Be Easily Distracted by Irrelevant Context":
  <https://proceedings.mlr.press/v202/shi23a.html>
- Chroma's "Context Rot" report: <https://www.trychroma.com/research/context-rot>
- Di Wu et al., "LongMemEval": <https://arxiv.org/abs/2410.10813>
- Ali Modarressi et al., "NoLiMa": <https://arxiv.org/abs/2502.05167>
- Gabriele Berton et al., "CompLLM": <https://arxiv.org/abs/2509.19228>

The defensible claim is narrow: the research supports the motivation for reducing prompt bloat and
irrelevant context. It does not validate `pando-proxy` task accuracy.
