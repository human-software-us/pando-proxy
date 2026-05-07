# Replay Benchmarks

Public source links, related research, and candidate next benchmark inputs are collected in
[`benchmarks/SOURCES.md`](./benchmarks/SOURCES.md).

This file describes benchmark runs for the current shipped active-task working-set runtime.

There are three benchmark classes here:

- deterministic public replay, which is cheap and reproducible but uses stub keep/drop decisions
- real-LLM public replay, which exercises the live structured-model memory manager
- live agent task runs, which are the only rows that say anything about task-level behavior

## Latest Results Summary

| Benchmark                                          | Date                    | Mode                                                | Workload                                             | Main result                                                                                                                                  | Correctness / completion signal                                                                                           |
| -------------------------------------------------- | ----------------------- | --------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| SWE-bench Verified devstral real-LLM replay sample | 2026-05-07              | `--real-llm`, `gpt-5.4-mini` manager                | 10 public trajectories, 273 replay turns             | avg context `8,115.7 -> 4,378.5` tokens (`46.0%` lower); median `7,618 -> 3,926` (`48.5%` lower); max `17,831 -> 13,296` (`25.4%` lower)     | 10/10 replay jobs succeeded; 749 manager calls; 0 manager errors                                                          |
| Metabase #42434 long-session task run              | 2026-05-07              | live Codex `gpt-5.4`, one long thread per condition | 7 Metabase PR tasks, sequential in one session       | proxy-estimated request context total `156,193,363 -> 29,797,331` tokens (`80.9%` lower); max request `1,015,243 -> 198,311` (`80.5%` lower) | both conditions had 7/7 Codex exits and 7/7 clean `git diff --check`; oracle file overlap was `31` baseline vs `63` proxy |
| SWE-bench Verified devstral full corpus            | current shipped runtime | deterministic `drop-tools` replay                   | 345 public trajectories, 21,709 replay rounds        | avg context `15,199 -> 1,093` tokens (`92.8%` lower); peak `33,636 -> 7,212` (`78.6%` lower)                                                 | replay accounting only; not task success                                                                                  |
| SWE-bench Verified devstral top-20 sample          | current shipped runtime | deterministic `drop-tools` replay                   | 20 selected public trajectories, 3,807 replay rounds | avg context `43,924 -> 2,069` tokens (`95.3%` lower); peak `142,623 -> 60,772` (`57.4%` lower)                                               | replay accounting only; not task success                                                                                  |

Interpret the headline narrowly:

- The real-LLM replay row is the best current evidence for live proxy memory behavior on public
  trajectory logs. It shows a smaller rewritten context window with live manager calls, but it does
  not evaluate whether the original SWE-bench tasks were solved.
- The Metabase row is the best current task-level evidence. On the available correctness proxies the
  proxy maintained or improved results versus baseline, but this was not a full Metabase test suite
  run.
- In the Metabase run, pando-proxy reduced the per-request context it forwarded, but billed Codex
  input tokens and elapsed time were higher because the proxy condition took more/larger live model
  turns plus manager overhead.
- The deterministic replay rows are useful regression benchmarks for prompt-size accounting. They
  should not be described as live structured-model pruning quality.

## SWE-bench Verified devstral real-LLM replay sample

This run used public `.traj.json` files exposed by:

- <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

Committed artifact:

- [`benchmarks/results/devstral_verified_real_llm_10.json`](./benchmarks/results/devstral_verified_real_llm_10.json)

The selected set contains `10` small but nontrivial public trajectories from the dataset tree:

- `sphinx-doc__sphinx-10435`
- `scikit-learn__scikit-learn-14141`
- `django__django-16569`
- `django__django-16527`
- `pydata__xarray-4629`
- `psf__requests-1766`
- `pytest-dev__pytest-7982`
- `scikit-learn__scikit-learn-14496`
- `pytest-dev__pytest-8399`
- `scikit-learn__scikit-learn-13779`

Reproduction:

```sh
python3 scripts/fetch_hf_traj_json_dataset.py \
  --dataset pankajmathur/devstral-24b-swebench-verified-traj \
  --paths-file <newline-delimited-traj-paths.txt> \
  --out-dir /tmp/pando-devstral-real-llm-10

PATH=/home/george/.deno/bin:$PATH python3 scripts/run_replay_batch.py \
  --rollout-dir /tmp/pando-devstral-real-llm-10/converted \
  --out-dir tmp/replay-devstral-real-llm-10 \
  --workers 2 \
  --real-llm \
  --request-model gpt-5.4-mini \
  --log-file tmp/replay-devstral-real-llm-10/batch.log \
  --heartbeat-seconds 20

python3 scripts/summarize_replay_turn_context.py \
  --turns-dir tmp/replay-devstral-real-llm-10 \
  --suffix __real-llm__turns.jsonl \
  --out tmp/replay-devstral-real-llm-10/turn_context_summary.json \
  --csv-out tmp/replay-devstral-real-llm-10/turn_context_by_rollout.csv
```

Per-turn approximate input tokens across `273` replay turns:

| Mode                   |   Min |     Avg | Median |    Max |     Total |
| ---------------------- | ----: | ------: | -----: | -----: | --------: |
| Without proxy baseline | 1,458 | 8,115.7 |  7,618 | 17,831 | 2,215,574 |
| With pando-proxy       |   416 | 4,378.5 |  3,926 | 13,296 | 1,195,342 |

Reduction:

- average context window: `46.0%`
- median context window: `48.5%`
- max observed context window: `25.4%`
- total replay input context: `46.0%`

Operational proof:

- 10/10 replay jobs completed
- 273 `source_chunk_batch` calls
- 273 `piece_drop_batch` calls
- 203 `task_route` calls
- 749 live manager calls total
- 0 manager errors

## Metabase #42434 long-session task benchmark

This run executed seven Metabase modularization PR tasks sequentially in one long Codex thread per
condition:

- no proxy
- with pando-proxy

Committed artifact:

- [`benchmarks/results/metabase_42434_proxy_long_session_20260507.json`](./benchmarks/results/metabase_42434_proxy_long_session_20260507.json)

The run used live Codex `gpt-5.4` and the local Metabase #42434 task manifest. It did not run the
full Metabase test suite; the correctness signals are Codex exit status, `git diff --check`, and
oracle patch file overlap/Jaccard.

| Condition        | Tasks | Codex exits | Clean diff checks | Oracle file overlap total | Model files total | Elapsed seconds | Codex input tokens |
| ---------------- | ----: | ----------: | ----------------: | ------------------------: | ----------------: | --------------: | -----------------: |
| No proxy         |     7 |         7/7 |               7/7 |                        31 |                57 |       1,813.908 |         52,848,294 |
| With pando-proxy |     7 |         7/7 |               7/7 |                        63 |                75 |       6,341.987 |         93,877,654 |

Proxy request-context accounting inside the proxy condition:

| Estimate               | Count |    Min |         Avg |       Max |       Total |
| ---------------------- | ----: | -----: | ----------: | --------: | ----------: |
| Without proxy estimate |   300 | 10,915 | 520,644.543 | 1,015,243 | 156,193,363 |
| With pando-proxy       |   300 | 10,850 |  99,324.437 |   198,311 |  29,797,331 |

Proxy-specific operational checks:

- max request-context reduction: `80.467%`
- total request-context reduction: `80.923%`
- manager overhead: `879,385` total tokens
- structured-model errors: `0`
- memory update failures: `0`
- recoverability audit: passed

Interpretation:

- On the available task-level signals, proxy use maintained or improved behavior versus baseline:
  both conditions completed every task cleanly, and oracle file overlap was higher with proxy.
- The proxy sharply reduced the request context it forwarded to the model.
- The proxy did not reduce end-to-end billed Codex input tokens in this run. The proxy condition was
  slower and used more Codex input/output tokens overall, so the current claim is context-window
  reduction, not cost or latency reduction.

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
| SWE-bench Verified devstral full corpus |     345 |            1,402 |           631 |           15,199 |         1,093 |           33,636 |         7,212 |          14,105 |          26,424 |
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
