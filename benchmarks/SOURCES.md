# Benchmark Sources

This file is the link index for benchmark inputs, related research, and likely next benchmark
sources for `pando-proxy`.

## Public sources used in the current benchmark docs

- Public GitHub Gist rollout:
  <https://gist.github.com/cirosantilli/82333ce34952926f5e4aea57dd0e4604>
- SWE-PolyBench submission branch: <https://github.com/amazon-science/SWE-PolyBench/tree/submission>
- SWE-PolyBench `PBVerified/20260201_iswe_agent` submission folder:
  <https://github.com/amazon-science/SWE-PolyBench/tree/submission/evaluation/PBVerified/20260201_iswe_agent>
- SWE-bench Verified devstral public trajectory dataset:
  <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>
- Committed aggregate result files: [`benchmarks/results`](./results)

## Research that supports the motivation, not the product claim

- Lost in the Middle: <https://arxiv.org/abs/2307.03172>
- Large Language Models Can Be Easily Distracted by Irrelevant Context:
  <https://proceedings.mlr.press/v202/shi23a.html>
- Context Rot: <https://www.trychroma.com/research/context-rot>
- LongMemEval: <https://arxiv.org/abs/2410.10813>
- LongMemEval code + dataset instructions: <https://github.com/xiaowu0162/LongMemEval>
- NoLiMa: <https://arxiv.org/abs/2502.05167>
- CompLLM: <https://arxiv.org/abs/2509.19228>
- OpenAI Responses API reasoning reference:
  <https://platform.openai.com/docs/api-reference/responses/compact?api-mode=responses>

## Candidate next benchmark sources

- SWE-bench datasets guide: <https://www.swebench.com/SWE-bench/guides/datasets/>
- SWE-bench Verified dataset: <https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified>
- SWE-smith trajectories dataset: <https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories>
- SWE-agent trajectory format and artifact docs: <https://swe-agent.com/0.7/usage/trajectories/>
- Public SWE-agent trajectories on SWE-bench Verified:
  <https://huggingface.co/datasets/nebius/SWE-agent-trajectories>
- Public SWE-bench Verified trajectories for one model run:
  <https://huggingface.co/datasets/pankajmathur/devstral-24b-swebench-verified-traj>

## Recommendation

If we want one next public benchmark family, the best fit is public SWE-bench-style trajectories
rather than raw issue statements alone.

Why:

- they are already multi-turn agent traces rather than static issue descriptions
- they are much closer to the replay format `pando-proxy` actually evaluates
- they stress long, tool-heavy coding sessions instead of only final patch quality

Best first candidate:

- `SWE-bench/SWE-smith-trajectories`

It is public, large, and explicitly distributed as trajectories. It is not the official SWE-bench
Verified benchmark itself, so it should be described as a public trajectory dataset for
software-engineering agents, not as "the SWE-bench benchmark."
