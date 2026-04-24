# Replay Benchmarks

Public source links, related research, and candidate next benchmark inputs are collected in
[`benchmarks/SOURCES.md`](./benchmarks/SOURCES.md).

These benchmark numbers were produced with the real replay path:

```sh
deno run --allow-read --allow-write --allow-env --allow-net \
  bin/replay.ts --rollout <path.jsonl> --real-llm --auth-from-codex --out-dir tmp/replay-real
```

That means replay used the actual structured maintenance pipeline in `src/replay.ts`:

- real `source_chunk` calls
- real `working_memory_update` calls
- normal small/overflow model selection from `src/structured_model.ts`

It did not use the deterministic stub retention policies.

## One-off benchmark set

| Set                     | Source              | Rollout                                                                  |   Avg reduction |   Max reduction | Baseline avg approx tokens | Pando avg approx tokens | Baseline max approx tokens | Pando max approx tokens | Rounds |
| ----------------------- | ------------------- | ------------------------------------------------------------------------ | --------------: | --------------: | -------------------------: | ----------------------: | -------------------------: | ----------------------: | -----: |
| Local `exec`            | local Codex session | `rollout-2026-04-22T18-14-05-019db7e6-bde6-70f1-b7c1-c21a6069e8d3.jsonl` |   2,479 (32.3%) |   5,443 (41.1%) |                      7,674 |                   5,195 |                     13,231 |                   7,788 |      8 |
| Local `cli` interactive | local Codex session | `rollout-2026-04-21T22-06-28-019db2f0-55d1-7a21-86d4-53dfbc695f99.jsonl` | 133,433 (68.8%) | 199,021 (69.4%) |                    193,840 |                  60,407 |                    286,898 |                  87,877 |      9 |
| Public open log         | GitHub Gist         | `cirosantilli-rollout-2026-02-11.jsonl`                                  |     407 (31.5%) |     418 (27.8%) |                      1,292 |                     885 |                      1,502 |                   1,084 |      2 |

## SWE-PolyBench submission replay batch

The SWE-PolyBench submission branch is public at
<https://github.com/amazon-science/SWE-PolyBench/tree/submission>.

Current submissions use multiple trace formats. For replay, the cleanest mechanically convertible
format was the YAML trajectory format from:

- `evaluation/PBVerified/20260201_iswe_agent/trajs/*.yaml`

Those traces are not native Codex rollout JSONL, so they were converted first with:

```sh
python3 scripts/convert_swe_polybench_iswe_agent_rollouts.py \
  --out-dir /tmp/swe-polybench-rollouts \
  --phase editing \
  /tmp/SWE-PolyBench-submission/evaluation/PBVerified/20260201_iswe_agent/trajs/*.yaml
```

All `69` converted `editing` traces under `evaluation/PBVerified/20260201_iswe_agent/trajs` were
replayed.

Aggregate across those 69 converted submission traces:

| Set                                | Samples | Avg baseline min | Avg pando min | Avg baseline avg | Avg pando avg | Avg baseline max | Avg pando max | Avg avg savings | Avg max savings |
| ---------------------------------- | ------: | ---------------: | ------------: | ---------------: | ------------: | ---------------: | ------------: | --------------: | --------------: |
| SWE-PolyBench `iswe_agent` editing |      69 |            6,657 |         1,756 |            8,331 |         4,464 |           10,046 |         7,385 |           3,867 |           2,661 |

The mean per-trace reduction across this full batch was 43.3% on average prompt size and 15.9% on
max prompt size.

One long trace (`apache__dubbo-5356`) hit a structured-output parse hiccup during one memory update,
but replay continued and still emitted complete turn stats.

## SWE-bench Verified devstral trajectory batch (stub replay)

To get a cheap full-corpus pass over a real public SWE-bench Verified trajectory set, I fetched all
currently exposed `.traj.json` files from:

- <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

The committed aggregate for that run lives at:

- [`benchmarks/results/devstral_verified_drop_tools_batch.json`](./benchmarks/results/devstral_verified_drop_tools_batch.json)

The raw fetched corpus was stored only locally during replay and is intentionally not checked in.

Reproduction:

```sh
python3 scripts/fetch_hf_traj_json_dataset.py \
  --dataset pankajmathur/devstral-24b-swebench-verified-traj \
  --out-dir /tmp/pando-devstral-verified-all

python3 scripts/run_replay_batch.py \
  --rollout-dir /tmp/pando-devstral-verified-all/converted \
  --out-dir tmp/replay-devstral-verified-batch \
  --workers 4 \
  --policy drop-tools

python3 scripts/aggregate_replay_stats.py \
  --stats-dir tmp/replay-devstral-verified-batch \
  --suffix __drop-tools__stats.json \
  --out benchmarks/results/devstral_verified_drop_tools_batch.json
```

This pass used the default stub maintenance policy (`drop-tools`), not `--real-llm`.

Aggregate across all `345` fetched trajectories:

| Set                                             | Samples | Rounds | Policy       | Avg baseline min | Avg pando min | Avg baseline avg | Avg pando avg | Avg baseline max | Avg pando max | Avg avg savings | Avg max savings | Aggregate avg reduction | Aggregate max reduction |
| ----------------------------------------------- | ------: | -----: | ------------ | ---------------: | ------------: | ---------------: | ------------: | ---------------: | ------------: | --------------: | --------------: | ----------------------: | ----------------------: |
| SWE-bench Verified devstral public trajectories |     345 | 21,709 | `drop-tools` |            1,402 |         1,404 |           15,199 |         7,508 |           33,636 |        14,651 |           7,690 |          18,985 |                   50.6% |                   56.4% |

Additional distribution notes:

- 71.3% of traces had positive average-token savings
- 71.3% of traces had positive max-token savings
- mean per-trace average reduction was 30.8%
- mean per-trace max reduction was 39.6%
- median per-trace average reduction was 33.2%
- median per-trace max reduction was 47.6%

## SWE-bench Verified devstral top-20 public sample (real LLM, full `gpt-5.4`)

To get a slower but higher-signal public sample on the real maintenance path, I took `20`
trajectories from the same public devstral Verified dataset using this deterministic rule:

- top `10` by replay round count
- plus top `10` additional trajectories by raw fetched transcript bytes

The committed selection and aggregate results live at:

- [`benchmarks/results/devstral_verified_top20_selection.json`](./benchmarks/results/devstral_verified_top20_selection.json)
- [`benchmarks/results/devstral_verified_top20_stub.json`](./benchmarks/results/devstral_verified_top20_stub.json)
- [`benchmarks/results/devstral_verified_top20_real_llm_gpt54.json`](./benchmarks/results/devstral_verified_top20_real_llm_gpt54.json)
- [`benchmarks/results/devstral_verified_top20_stub_vs_real_llm_gpt54.json`](./benchmarks/results/devstral_verified_top20_stub_vs_real_llm_gpt54.json)

That sample contains `3,807` total rounds.

For the real-LLM pass, both structured-model slots were pinned to `gpt-5.4`:

```sh
env \
  PANDO_PROXY_SMALL_STRUCTURED_MODEL=gpt-5.4 \
  PANDO_PROXY_OVERFLOW_STRUCTURED_MODEL=gpt-5.4 \
  python3 scripts/run_replay_batch.py \
    --rollout-dir /tmp/pando-devstral-top20/converted \
    --out-dir tmp/replay-devstral-top20-real-llm-gpt54 \
    --workers 4 \
    --real-llm
```

Replay itself does not expose a separate reasoning-effort flag. This run used the non-mini `gpt-5.4`
path with no fast model override; OpenAI's Responses API docs describe GPT-5 models before `gpt-5.1`
as defaulting to medium reasoning effort:
<https://platform.openai.com/docs/api-reference/responses/compact?api-mode=responses>

Aggregate comparison on that same top-20 selection:

| Set                                | Samples | Rounds | Mode                  | Avg baseline avg | Avg pando avg | Avg baseline max | Avg pando max | Aggregate avg reduction | Aggregate max reduction | Mean per-trace avg reduction | Mean per-trace max reduction |
| ---------------------------------- | ------: | -----: | --------------------- | ---------------: | ------------: | ---------------: | ------------: | ----------------------: | ----------------------: | ---------------------------: | ---------------------------: |
| SWE-bench Verified devstral top-20 |      20 |  3,807 | `drop-tools`          |           43,924 |        12,575 |          142,623 |        72,664 |                   71.4% |                   49.1% |                        64.2% |                        60.7% |
| SWE-bench Verified devstral top-20 |      20 |  3,807 | `real-llm`, `gpt-5.4` |           43,924 |         5,714 |          142,623 |        65,005 |                   87.0% |                   54.4% |                        85.6% |                        65.6% |

Notes:

- Both stub and real-LLM runs had positive average-token savings on all `20` selected traces.
- Both stub and real-LLM runs had positive max-token savings on all `20` selected traces.
- Median per-trace average reduction improved from 71.2% in stub replay to 89.1% on the real
  `gpt-5.4` maintenance path.
- Median per-trace max reduction improved from 79.8% in stub replay to 81.3% on the real `gpt-5.4`
  maintenance path.

## Set summary

Set-level summary across the current benchmark groups:

| Set                                | Samples | Avg baseline min | Avg pando min | Avg baseline avg | Avg pando avg | Avg baseline max | Avg pando max | Avg avg savings | Avg max savings |
| ---------------------------------- | ------: | ---------------: | ------------: | ---------------: | ------------: | ---------------: | ------------: | --------------: | --------------: |
| Local `exec` one-off               |       1 |            1,421 |         1,352 |            7,674 |         5,195 |           13,231 |         7,788 |           2,479 |           5,443 |
| Local `cli` one-off                |       1 |            2,988 |         1,842 |          193,840 |        60,407 |          286,898 |        87,877 |         133,433 |         199,021 |
| Public open one-off                |       1 |            1,081 |           686 |            1,292 |           885 |            1,502 |         1,084 |             407 |             418 |
| SWE-PolyBench `iswe_agent` editing |      69 |            6,657 |         1,756 |            8,331 |         4,464 |           10,046 |         7,385 |           3,867 |           2,661 |
| SWE-bench Verified devstral top-20 |      20 |            2,069 |           536 |           43,924 |         5,714 |          142,623 |        65,005 |          38,210 |          77,617 |

The table above is restricted to the current real-LLM replay groups. The 345-trace devstral Verified
corpus is intentionally kept separate because it used the cheap stub maintenance policy rather than
`--real-llm`.

## Largest local Codex logs plus SWE-PolyBench batch

This table is a separate "recorded token" view. For the 10 largest local Codex rollout logs, it uses
the logs' own recorded `input_tokens` series from `token_count` events, rather than replay, because
these sessions are very large and span dozens to hundreds of rounds. The final row appends the
public SWE-PolyBench batch aggregate from the converted `iswe_agent` submission traces.

| Row            | Kind                | Identifier                                                         | Size (MB) | Rounds | Compactions | Recorded min input tokens | Recorded avg input tokens | Max without proxy | Max with proxy |
| -------------- | ------------------- | ------------------------------------------------------------------ | --------: | -----: | ----------: | ------------------------: | ------------------------: | ----------------: | -------------: |
| 1              | local Codex log     | `rollout-2026-03-25T13-56-15-019d26c8-9f62-7a31-bb67-925623946918` |      35.7 |    563 |          27 |                    16,838 |                   155,222 |           244,640 |              - |
| 2              | local Codex log     | `rollout-2026-04-10T20-19-31-019d7a8d-4375-7b92-b93b-f5eb02021698` |      30.6 |    106 |          15 |                    17,388 |                   132,233 |           244,199 |              - |
| 3              | local Codex log     | `rollout-2026-04-10T16-16-53-019d79af-1f51-7913-bfe9-5ff93f7aab6b` |      23.9 |     94 |          11 |                    18,037 |                   136,453 |           242,866 |              - |
| 4              | local Codex log     | `rollout-2026-01-09T13-42-04-019ba4b5-9d7e-7152-8a27-940616b78647` |      23.9 |    135 |           3 |                    11,029 |                   125,984 |           214,324 |              - |
| 5              | local Codex log     | `rollout-2026-04-10T19-45-53-019d7a6e-789f-7051-8bd5-78e6cf8c6b02` |      22.8 |    167 |          12 |                    16,980 |                   137,811 |           236,113 |              - |
| 6              | local Codex log     | `rollout-2026-04-22T10-33-27-019db641-0322-7232-b96d-ac29ce5379c9` |      18.4 |    112 |           9 |                    19,216 |                   126,931 |           235,421 |              - |
| 7              | local Codex log     | `rollout-2025-11-20T13-39-37-019aa335-676f-74a2-ab00-123c46158079` |      17.2 |     55 |           0 |                     8,882 |                    97,030 |           165,320 |              - |
| 8              | local Codex log     | `rollout-2026-03-29T13-11-27-019d3b39-0a96-7b51-85f5-d4065bd2a244` |      16.1 |    115 |           9 |                    11,384 |                   127,851 |           244,053 |              - |
| 9              | local Codex log     | `rollout-2026-03-30T13-25-34-019d406c-5558-7ea0-8b24-711a726ebb51` |      14.5 |    113 |           5 |                    17,269 |                   124,656 |           240,313 |              - |
| 10             | local Codex log     | `rollout-2026-04-10T14-08-05-019d7939-33df-7b31-813d-03c11a30165e` |      14.5 |     34 |           8 |                    16,824 |                   128,041 |           244,073 |              - |
| 11             | SWE-PolyBench batch | `iswe_agent` editing aggregate (69 traces)                         |         - |      - |           - |                     7,579 |                     8,862 |            10,209 |          7,385 |
| Avg (10 local) | aggregate           | top 10 local Codex logs                                            |      21.8 |  149.4 |         9.9 |                    15,385 |                   129,221 |           231,132 |              - |
| Avg (all 11)   | aggregate           | 10 locals + SWE-PolyBench batch row                                |         - |      - |           - |                    14,675 |                   118,279 |           211,048 |          7,385 |

## Notes on interpretation

- `baseline` is the replay estimate for the usual Codex behavior: carry the accumulated request
  history forward and send it again on the next turn.
- `pando` is the replay estimate after `rewriteRequestWithMemory(...)` rebuilds the request using
  the compact objective plus exact retained chunks.
- These values are `approxInputTokens` from `src/metrics.ts`. They are the right metric for relative
  prompt-size comparisons inside this repo.
- `recorded.input_tokens` from raw Codex logs can be much larger than replay's
  `baselineApproxInputTokens` because Codex's own accounting includes extra provider-side/system
  scaffolding that replay intentionally does not try to reconstruct exactly. Use the replay baseline
  vs replay pando delta for the apples-to-apples comparison.
- The public open log we found is a good large-payload stress case, but it is an `exec` log rather
  than a long public interactive transcript.
- The SWE-PolyBench batch above uses converted `editing` trajectories from a public submission, not
  native Codex rollouts. The conversion preserves role/content order and the submission's per-turn
  token records, then feeds the synthetic rollout through the same replay path.
- The 345-trace devstral Verified batch above uses direct public `.traj.json` files from a public
  SWE-bench Verified run dataset, fetched and converted locally before replay. Only the aggregate
  result JSON is checked in.
- That full-corpus pass used the default stub maintenance policy (`drop-tools`) to keep the run
  cheap and fast. It should not be compared directly to the real-LLM rows above as if the
  maintenance method were the same.
- The top-20 devstral sample above uses the same public dataset, but on a deterministic
  high-round/high-byte selection with the real maintenance path pinned to full `gpt-5.4`.

## Artifact files

The runs above emitted:

- `tmp/replay-real/*__stats.json`
- `tmp/replay-real/*__turns.jsonl`
- `tmp/replay-real/*__series.csv`
- `tmp/replay-real/*__manager-usage.jsonl`

Those files let you audit both the per-turn prompt estimates and the maintenance-model usage for
each replay.

Committed aggregate result files used by the benchmark docs live under
[`benchmarks/results`](./benchmarks/results).

## Public benchmark sources and related datasets

Current public inputs used or referenced here:

- Public GitHub Gist rollout:
  <https://gist.github.com/cirosantilli/82333ce34952926f5e4aea57dd0e4604>
- SWE-PolyBench submission branch: <https://github.com/amazon-science/SWE-PolyBench/tree/submission>
- SWE-PolyBench `PBVerified/20260201_iswe_agent` submission folder:
  <https://github.com/amazon-science/SWE-PolyBench/tree/submission/evaluation/PBVerified/20260201_iswe_agent>
- SWE-bench Verified devstral public trajectory dataset:
  <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

Additional public benchmark sources that look promising for future replay batches:

- SWE-bench datasets guide: <https://www.swebench.com/SWE-bench/guides/datasets/>
- SWE-bench Verified dataset: <https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified>
- SWE-smith trajectories dataset: <https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories>
- SWE-agent trajectory docs: <https://swe-agent.com/0.7/usage/trajectories/>
- Public SWE-agent trajectories: <https://huggingface.co/datasets/nebius/SWE-agent-trajectories>

## What the research shows and does not show about this approach

Several papers support the general premise that smaller, cleaner prompts can help long-context model
behavior:

- Nelson F. Liu et al., "Lost in the Middle: How Language Models Use Long Contexts" found that
  models degrade when relevant information is buried inside long inputs:
  <https://arxiv.org/abs/2307.03172>
- Freda Shi et al., "Large Language Models Can Be Easily Distracted by Irrelevant Context" found
  that irrelevant context can distract model predictions:
  <https://proceedings.mlr.press/v202/shi23a.html>
- Chroma's "Context Rot" report found that reliability drops as input length grows even before the
  formal context window is exhausted: <https://www.trychroma.com/research/context-rot>
- Di Wu et al., "LongMemEval" is relevant because it evaluates long-term memory across sustained
  user-assistant chat histories rather than only single-shot retrieval:
  <https://arxiv.org/abs/2410.10813>
- Ali Modarressi et al., "NoLiMa" extends the long-context failure story beyond literal string
  matching: <https://arxiv.org/abs/2502.05167>
- Gabriele Berton et al., "CompLLM" supports the narrower idea that compressed context can
  outperform uncompressed context at long lengths, though the mechanism is different from this repo:
  <https://arxiv.org/abs/2509.19228>

Important caveats:

- These papers do not evaluate `pando-proxy` specifically.
- The current repo benchmarks measure prompt-size reduction, not task success rate.
- The Chroma report is useful and directly relevant, but it comes from a company that sells
  retrieval infrastructure, so it should be cited with that commercial stake made explicit.

The defensible claim is narrow: the research supports the motivation for reducing prompt bloat and
irrelevant context. It does not yet validate that `pando-proxy` improves task accuracy on coding
benchmarks.

## Why smaller working context should help

This repo's claim is narrow: smaller effective prompt state should reduce prompt bloat, token cost,
and the amount of irrelevant context the model has to sift through. That expectation is consistent
with prior work:

- Nelson F. Liu et al., "Lost in the Middle: How Language Models Use Long Contexts" found that
  long-context models can degrade substantially when relevant information is buried inside long
  inputs. <https://arxiv.org/abs/2307.03172>
- Freda Shi et al., "Large Language Models Can Be Easily Distracted by Irrelevant Context" showed
  that irrelevant context can distract model predictions.
  <https://proceedings.mlr.press/v202/shi23a>
- Kelly Hong et al., "Context Rot: How Increasing Input Tokens Impacts LLM Performance" found
  degradation before formal context-window limits are reached, though it should be read with the
  caveat that it was published by a company with a commercial stake in retrieval infrastructure.
  <https://www.trychroma.com/research/context-rot>
- Di Wu et al., "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory" is
  useful because it evaluates sustained chat histories rather than only document retrieval.
  <https://arxiv.org/abs/2410.10813>
- Ali Modarressi et al., "NoLiMa: Long-Context Evaluation Beyond Literal Matching" showed that
  performance can drop sharply when long-context retrieval depends on latent associations rather
  than literal overlap. <https://arxiv.org/abs/2502.05167>
- Gabriele Berton et al., "CompLLM: Compression for Long Context Q&A" reported that at a 2x
  compression rate, compressed context can match or outperform uncompressed context on very long
  sequences, though the mechanism differs from this repo's exact-chunk memory design.
  <https://arxiv.org/abs/2509.19228>
- Guangxuan Xiao et al., "Efficient Streaming Language Models with Attention Sinks" showed that
  bounded-context streaming approaches can recover quality while improving efficiency, with up to
  22.2x speedup over a sliding-window recomputation baseline in their setting.
  <https://arxiv.org/abs/2309.17453>
- Vaswani et al., "Attention Is All You Need" is still the core reference for why longer sequences
  are expensive in standard transformer attention. <https://arxiv.org/abs/1706.03762>

Those papers do not evaluate `pando-proxy` specifically. They are included only to ground the
general claim that prompt growth, irrelevant context, and long-sequence handling matter for both
quality and cost.

## Best next benchmark source to add

If we add one more public benchmark family, the best next source is public SWE-bench-style
trajectories rather than raw issue instances alone.

The strongest candidate I found is:

- `SWE-bench/SWE-smith-trajectories`:
  <https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories>

Why this looks useful:

- it is already published as trajectories, not just tasks
- it is closer to the multi-turn coding-agent histories that `bin/replay.ts` is designed to replay
- it is large enough to produce a meaningful public batch benchmark

I would describe it carefully as a public software-engineering trajectory dataset, not as official
SWE-bench Verified results. If we want something closer to Verified specifically, the public
trajectory datasets under `nebius/SWE-agent-trajectories` and
`pankajmathur/devstral-24b-swebench-verified-traj` are also viable starting points.
