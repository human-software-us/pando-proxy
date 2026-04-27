# Quick Benchmarks

This is the short version of the benchmark note. Full details, tables, and methodology live in
[`BENCHMARKS.md`](./BENCHMARKS.md). Public source links and candidate next benchmark inputs are
collected in [`benchmarks/SOURCES.md`](./benchmarks/SOURCES.md).

## Headline numbers

Current rerun command used for the public deterministic benchmark passes:

```sh
python3 scripts/run_replay_batch.py \
  --rollout-dir <dir-of-rollout-jsonl-files> \
  --out-dir <out-dir> \
  --workers 4 \
  --policy drop-tools
```

`without proxy` below means replay baseline. `with proxy` means the rewritten Pando prompt.

| Case                                             | Avg reduction | Peak reduction | Avg without proxy | Avg with proxy | Peak without proxy | Peak with proxy | Rounds |
| ------------------------------------------------ | ------------: | -------------: | ----------------: | -------------: | -----------------: | --------------: | -----: |
| SWE-bench Verified devstral full corpus (345)    |         92.8% |          78.6% |            15,199 |          1,093 |             33,636 |           7,212 | 21,709 |
| SWE-bench Verified devstral top-20 public sample |         95.3% |          57.4% |            43,924 |          2,069 |            142,623 |          60,772 |  3,807 |

## Public sources used

- Public GitHub Gist rollout:
  <https://gist.github.com/cirosantilli/82333ce34952926f5e4aea57dd0e4604>
- SWE-PolyBench submission branch: <https://github.com/amazon-science/SWE-PolyBench/tree/submission>
- SWE-PolyBench `PBVerified/20260201_iswe_agent` submission folder:
  <https://github.com/amazon-science/SWE-PolyBench/tree/submission/evaluation/PBVerified/20260201_iswe_agent>
- SWE-bench datasets guide: <https://www.swebench.com/SWE-bench/guides/datasets/>
- SWE-smith trajectories dataset: <https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories>
- SWE-agent trajectory format docs: <https://swe-agent.com/0.7/usage/trajectories/>

## Research links

- Lost in the Middle: <https://arxiv.org/abs/2307.03172>
- Large Language Models Can Be Easily Distracted by Irrelevant Context:
  <https://proceedings.mlr.press/v202/shi23a.html>
- Context Rot: <https://www.trychroma.com/research/context-rot>
- LongMemEval: <https://arxiv.org/abs/2410.10813>
- NoLiMa: <https://arxiv.org/abs/2502.05167>
- CompLLM: <https://arxiv.org/abs/2509.19228>

## Notes

- The current public benchmark numbers above were rerun on the shipped task-and-piece memory
  manager, not the older objective-and-chunk design.
- The full-corpus and top-20 public reruns both used deterministic stub replay
  (`--policy
  drop-tools`), which makes them cheap to reproduce locally.
- The long local-log table in [`BENCHMARKS.md`](./BENCHMARKS.md) is still a recorded-token view from
  raw local Codex logs, not a rerun of those sessions on the current implementation.
- Older real-LLM public numbers are kept in the full benchmark note as historical reference only
  until they are rerun on the lossless memory manager.
- The research links above support the motivation for reducing prompt bloat. They do not measure
  `pando-proxy` itself.

## Cheap Full-Corpus Stub Run

I fetched and converted all `345` currently exposed `.traj.json` files from the public SWE-bench
Verified run dataset:

- <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

Committed aggregate:

- [`benchmarks/results/devstral_verified_drop_tools_batch.json`](./benchmarks/results/devstral_verified_drop_tools_batch.json)

Current aggregate on the shipped lossless task/piece manager:

| Set                                             | Samples | Rounds | Avg without proxy | Avg with proxy | Peak without proxy | Peak with proxy | Aggregate avg reduction | Aggregate peak reduction |
| ----------------------------------------------- | ------: | -----: | ----------------: | -------------: | -----------------: | --------------: | ----------------------: | -----------------------: |
| SWE-bench Verified devstral public trajectories |     345 | 21,709 |            15,199 |          1,093 |             33,636 |           7,212 |                   92.8% |                    78.6% |

Current local rerun commands for the full-corpus stub pass:

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

## Public Top-20 Stub Sample

I also reran the public `20`-trace sample from that same devstral Verified dataset, selecting:

- top `10` traces by round count
- plus top `10` additional traces by raw transcript bytes

Committed result files:

- [`benchmarks/results/devstral_verified_top20_selection.json`](./benchmarks/results/devstral_verified_top20_selection.json)
- [`benchmarks/results/devstral_verified_top20_stub.json`](./benchmarks/results/devstral_verified_top20_stub.json)

Current aggregate on the shipped lossless task/piece manager:

| Set                                | Samples | Rounds | Mode         | Avg without proxy | Avg with proxy | Peak without proxy | Peak with proxy | Aggregate avg reduction | Aggregate peak reduction |
| ---------------------------------- | ------: | -----: | ------------ | ----------------: | -------------: | -----------------: | --------------: | ----------------------: | -----------------------: |
| SWE-bench Verified devstral top-20 |      20 |  3,807 | `drop-tools` |            43,924 |          2,069 |            142,623 |          60,772 |                   95.3% |                    57.4% |

Naive replay for the exact same top-20 selection reproduces with:

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
  --out-dir tmp/replay-devstral-top20-stub \
  --workers 4 \
  --policy drop-tools
```

To write the aggregate locally instead of updating the committed benchmark artifact:

```sh
python3 scripts/aggregate_replay_stats.py \
  --stats-dir tmp/replay-devstral-top20-stub \
  --suffix __drop-tools__stats.json \
  --out tmp/replay-devstral-top20-stub.aggregate.json
```

## Historical note

The older top-20 real-LLM `gpt-5.4` replay numbers were produced before the lossless memory-manager
rewrite. They are still preserved in [`BENCHMARKS.md`](./BENCHMARKS.md) and the corresponding JSON
artifacts, but they are not current-implementation numbers and should not be treated as directly
comparable to the stub reruns above.

## Best next public benchmark source

If we add one more public benchmark family, public SWE-bench-style trajectories are the best next
step.

The strongest candidate I found is `SWE-bench/SWE-smith-trajectories`:

- it is a public trajectory dataset rather than a static issue dataset
- it is much closer to replayable coding-agent history than raw SWE-bench instances
- it is large enough to produce a meaningful batch benchmark

That should be described as a public trajectory dataset for software-engineering agents, not as
official SWE-bench Verified results.
