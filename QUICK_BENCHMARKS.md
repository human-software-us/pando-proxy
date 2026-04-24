# Quick Benchmarks

This is the short version of the benchmark note. Full details, tables, and methodology live in [`BENCHMARKS.md`](./BENCHMARKS.md).

## Headline numbers

Replay command used for measured runs:

```sh
deno run --allow-read --allow-write --allow-env --allow-net \
  bin/replay.ts --rollout <path.jsonl> --real-llm --auth-from-codex
```

`without proxy` below means replay baseline. `with proxy` means the rewritten Pando prompt.

| Case | Avg reduction | Max reduction | Avg without proxy | Avg with proxy | Max without proxy | Max with proxy | Rounds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Local `exec` one-off | 32.3% | 41.1% | 7,674 | 5,195 | 13,231 | 7,788 | 8 |
| Local `cli` one-off | 68.8% | 69.4% | 193,840 | 60,407 | 286,898 | 87,877 | 9 |
| Public open log one-off | 31.5% | 27.8% | 1,292 | 885 | 1,502 | 1,084 | 2 |
| SWE-PolyBench `iswe_agent` editing | 46.4% | 26.5% | 8,331 | 4,464 | 10,046 | 7,385 | 69 |

## Public sources used

- Public GitHub Gist rollout: <https://gist.github.com/cirosantilli/82333ce34952926f5e4aea57dd0e4604>
- SWE-PolyBench submission branch: <https://github.com/amazon-science/SWE-PolyBench/tree/submission>
- SWE-PolyBench `PBVerified/20260201_iswe_agent` submission folder:
  <https://github.com/amazon-science/SWE-PolyBench/tree/submission/evaluation/PBVerified/20260201_iswe_agent>

## Notes

- The GitHub Gist case is a public `exec` rollout JSONL and was replayed directly.
- The SWE-PolyBench traces are public YAML trajectories, not native Codex rollout JSONL. They were converted with `scripts/convert_swe_polybench_iswe_agent_rollouts.py` and then replayed through the same `bin/replay.ts --real-llm` path.
- The long local-log table in [`BENCHMARKS.md`](./BENCHMARKS.md) is a recorded-token view from raw local Codex logs, not a full replay of those largest sessions.
