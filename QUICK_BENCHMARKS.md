# Quick Benchmarks

This is the short version of the benchmark note. Full details, tables, and methodology live in
[`BENCHMARKS.md`](./BENCHMARKS.md). Public source links and candidate next benchmark inputs are
collected in [`benchmarks/SOURCES.md`](./benchmarks/SOURCES.md).

## Headline numbers

Replay command used for measured runs:

```sh
deno run --allow-read --allow-write --allow-env --allow-net \
  bin/replay.ts --rollout <path.jsonl> --real-llm --auth-from-codex
```

`without proxy` below means replay baseline. `with proxy` means the rewritten Pando prompt.

| Case                               | Avg reduction | Max reduction | Avg without proxy | Avg with proxy | Max without proxy | Max with proxy | Rounds |
| ---------------------------------- | ------------: | ------------: | ----------------: | -------------: | ----------------: | -------------: | -----: |
| Local `exec` one-off               |         32.3% |         41.1% |             7,674 |          5,195 |            13,231 |          7,788 |      8 |
| Local `cli` one-off                |         68.8% |         69.4% |           193,840 |         60,407 |           286,898 |         87,877 |      9 |
| Public open log one-off            |         31.5% |         27.8% |             1,292 |            885 |             1,502 |          1,084 |      2 |
| SWE-PolyBench `iswe_agent` editing |         46.4% |         26.5% |             8,331 |          4,464 |            10,046 |          7,385 |     69 |

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

- The GitHub Gist case is a public `exec` rollout JSONL and was replayed directly.
- The SWE-PolyBench traces are public YAML trajectories, not native Codex rollout JSONL. They were
  converted with `scripts/convert_swe_polybench_iswe_agent_rollouts.py` and then replayed through
  the same `bin/replay.ts --real-llm` path.
- The long local-log table in [`BENCHMARKS.md`](./BENCHMARKS.md) is a recorded-token view from raw
  local Codex logs, not a full replay of those largest sessions.
- The research links above support the motivation for reducing prompt bloat. They do not measure
  `pando-proxy` itself.

## Cheap Full-Corpus Stub Run

I also fetched and converted all `345` currently exposed `.traj.json` files from the public
SWE-bench Verified run dataset:

- <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

Committed aggregate:

- [`benchmarks/results/devstral_verified_drop_tools_batch.json`](./benchmarks/results/devstral_verified_drop_tools_batch.json)

Cheap stub replay aggregate with the default `drop-tools` policy:

| Set                                             | Samples | Rounds | Avg without proxy | Avg with proxy | Max without proxy | Max with proxy | Aggregate avg reduction | Aggregate max reduction |
| ----------------------------------------------- | ------: | -----: | ----------------: | -------------: | ----------------: | -------------: | ----------------------: | ----------------------: |
| SWE-bench Verified devstral public trajectories |     345 | 21,709 |            15,199 |          7,508 |            33,636 |         14,651 |                   50.6% |                   56.4% |

This row is a stub-policy replay, not a `--real-llm` replay, so it is intentionally kept separate
from the headline real-maintenance table above.

## Public Top-20 Real-LLM Sample

I also ran a public `20`-trace sample from that same devstral Verified dataset on the real
maintenance path, selecting:

- top `10` traces by round count
- plus top `10` additional traces by raw transcript bytes

Committed result files:

- [`benchmarks/results/devstral_verified_top20_selection.json`](./benchmarks/results/devstral_verified_top20_selection.json)
- [`benchmarks/results/devstral_verified_top20_stub_vs_real_llm_gpt54.json`](./benchmarks/results/devstral_verified_top20_stub_vs_real_llm_gpt54.json)

For the real-LLM pass, both structured-model slots were pinned to full `gpt-5.4` rather than the
mini model.

| Set                                | Samples | Rounds | Mode                  | Avg without proxy | Avg with proxy | Max without proxy | Max with proxy | Aggregate avg reduction | Aggregate max reduction |
| ---------------------------------- | ------: | -----: | --------------------- | ----------------: | -------------: | ----------------: | -------------: | ----------------------: | ----------------------: |
| SWE-bench Verified devstral top-20 |      20 |  3,807 | `drop-tools`          |            43,924 |         12,575 |           142,623 |         72,664 |                   71.4% |                   49.1% |
| SWE-bench Verified devstral top-20 |      20 |  3,807 | `real-llm`, `gpt-5.4` |            43,924 |          5,714 |           142,623 |         65,005 |                   87.0% |                   54.4% |

## Best next public benchmark source

If we add one more public benchmark family, public SWE-bench-style trajectories are the best next
step.

The strongest candidate I found is `SWE-bench/SWE-smith-trajectories`:

- it is a public trajectory dataset rather than a static issue dataset
- it is much closer to replayable coding-agent history than raw SWE-bench instances
- it is large enough to produce a meaningful batch benchmark

That should be described as a public trajectory dataset for software-engineering agents, not as
official SWE-bench Verified results.
