# Quick Benchmarks

This is the short version of the benchmark note. Full details, tables, and methodology live in
[`BENCHMARKS.md`](./BENCHMARKS.md). Public source links and candidate next benchmark inputs are
collected in [`benchmarks/SOURCES.md`](./benchmarks/SOURCES.md).

## Headline Numbers

The latest benchmark set has three different meanings:

- real-LLM replay: live structured-model memory decisions on public trajectory logs
- Metabase live task run: end-to-end Codex behavior on repository tasks
- deterministic replay: cheap regression accounting with stub keep/drop decisions

| Case                                             | Mode                                 | Workload                                    |                       Avg reduction | Median reduction |                    Peak reduction | Completion / correctness signal                                                                 |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------------- | ----------------------------------: | ---------------: | --------------------------------: | ----------------------------------------------------------------------------------------------- |
| SWE-bench Verified devstral real-LLM sample      | `--real-llm`, `gpt-5.4-mini` manager | 10 logs, 273 turns                          |                               46.0% |            48.5% |                             25.4% | 10/10 replay jobs, 0 manager errors                                                             |
| Metabase #42434 long-session                     | live Codex `gpt-5.4`                 | 7 PR tasks in one long thread per condition | 80.9% total proxy-estimated context |              n/a | 80.5% max proxy-estimated context | 7/7 Codex exits and clean diffs in both conditions; oracle file overlap 31 baseline vs 63 proxy |
| SWE-bench Verified devstral full corpus          | deterministic `drop-tools`           | 345 logs, 21,709 turns                      |                               92.8% |              n/a |                             78.6% | replay accounting only                                                                          |
| SWE-bench Verified devstral top-20 public sample | deterministic `drop-tools`           | 20 logs, 3,807 turns                        |                               95.3% |              n/a |                             57.4% | replay accounting only                                                                          |

Per-turn context window sizes for the latest real-LLM replay:

| Mode                   |   Min |     Avg | Median |    Max |     Total |
| ---------------------- | ----: | ------: | -----: | -----: | --------: |
| Without proxy baseline | 1,458 | 8,115.7 |  7,618 | 17,831 | 2,215,574 |
| With pando-proxy       |   416 | 4,378.5 |  3,926 | 13,296 | 1,195,342 |

Metabase long-session proxy request-context accounting:

| Estimate               | Count |    Min |         Avg |       Max |       Total |
| ---------------------- | ----: | -----: | ----------: | --------: | ----------: |
| Without proxy estimate |   300 | 10,915 | 520,644.543 | 1,015,243 | 156,193,363 |
| With pando-proxy       |   300 | 10,850 |  99,324.437 |   198,311 |  29,797,331 |

Committed latest artifacts:

- [`benchmarks/results/devstral_verified_real_llm_10.json`](./benchmarks/results/devstral_verified_real_llm_10.json)
- [`benchmarks/results/metabase_42434_proxy_long_session_20260507.json`](./benchmarks/results/metabase_42434_proxy_long_session_20260507.json)
- [`benchmarks/results/devstral_verified_drop_tools_batch.json`](./benchmarks/results/devstral_verified_drop_tools_batch.json)
- [`benchmarks/results/devstral_verified_top20_stub.json`](./benchmarks/results/devstral_verified_top20_stub.json)

## Deterministic Replay Headline Numbers

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

## Public source used

- SWE-bench Verified devstral public trajectory dataset:
  <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

## Research links

- Lost in the Middle: <https://arxiv.org/abs/2307.03172>
- Large Language Models Can Be Easily Distracted by Irrelevant Context:
  <https://proceedings.mlr.press/v202/shi23a.html>
- Context Rot: <https://www.trychroma.com/research/context-rot>
- LongMemEval: <https://arxiv.org/abs/2410.10813>
- NoLiMa: <https://arxiv.org/abs/2502.05167>
- CompLLM: <https://arxiv.org/abs/2509.19228>

## Notes

- The current public benchmark numbers above were rerun on the shipped active-task working-set
  runtime.
- The full-corpus and top-20 public reruns both used deterministic stub replay
  (`--policy
  drop-tools`), which makes them cheap to reproduce locally.
- The real-LLM replay sample uses live manager calls and is the better prompt-size signal for the
  actual proxy behavior, but it is not task success.
- The Metabase run is the best current task-level signal. It supports correctness parity or better
  on the measured proxies, but it does not prove full functional correctness because the Metabase
  test suite was not run.
- The Metabase run reduced forwarded request context, but it did not reduce total billed Codex input
  tokens or elapsed time.
- The research links above support the motivation for reducing prompt bloat. They do not measure
  `pando-proxy` itself.

## Cheap Full-Corpus Stub Run

I fetched and converted all `345` currently exposed `.traj.json` files from the public SWE-bench
Verified run dataset:

- <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

Committed aggregate:

- [`benchmarks/results/devstral_verified_drop_tools_batch.json`](./benchmarks/results/devstral_verified_drop_tools_batch.json)

Current aggregate on the shipped active-task working-set runtime:

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

Current aggregate on the shipped active-task working-set runtime:

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

## Best next public benchmark source

If we add one more public benchmark family, public SWE-bench-style trajectories are the best next
step.

The strongest candidate I found is `SWE-bench/SWE-smith-trajectories`:

- it is a public trajectory dataset rather than a static issue dataset
- it is much closer to replayable coding-agent history than raw SWE-bench instances
- it is large enough to produce a meaningful batch benchmark

That should be described as a public trajectory dataset for software-engineering agents, not as
official SWE-bench Verified results.
