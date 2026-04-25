# Live E2E Accounting Suite - 2026-04-25

Manual live backend suite run after the proxy accounting output change.

Artifacts:

- Base dir: `/tmp/pando-live-e2e-suite-20260425-v2`
- Per-test logs: `/tmp/pando-live-e2e-suite-20260425-v2/<test>/proxy.jsonl`
- Per-round transcripts: `/tmp/pando-live-e2e-suite-20260425-v2/<test>/round<N>.txt`
- Per-round wrapper/Codex stderr: `/tmp/pando-live-e2e-suite-20260425-v2/<test>/round<N>.stderr`

## Summary

| Test              | Kind                              | Thread                                 | Codex rounds | Proxy `round_complete` records | Memory errors | Archive recalls | All-in tokens | Manager tokens |
| ----------------- | --------------------------------- | -------------------------------------- | -----------: | -----------------------------: | ------------: | --------------: | ------------: | -------------: |
| `real-repo-a`     | realistic repo inspection         | `019dc654-98a0-7553-af2d-2cc8534f05ad` |            3 |                              8 |             0 |               1 |       178,412 |         24,252 |
| `fake-values-b`   | fake exact values                 | `019dc656-8f9b-7e91-a3ff-dbe090d1c299` |            3 |                              3 |             0 |               0 |        63,937 |         10,227 |
| `real-usage-c`    | realistic usage-code inspection   | `019dc657-61f5-73d0-aac3-2d5f5cb68bff` |            3 |                              8 |             0 |               0 |       179,611 |         23,938 |
| `fake-snippets-d` | fake exact snippets               | `019dc658-9bb2-7781-9b8f-bf979218082b` |            3 |                              3 |             0 |               1 |        64,978 |         11,292 |
| `mixed-long-e`    | mixed realistic/fake long session | `019dc659-5c9d-7d81-95f5-d0e5d2ec53e7` |            6 |                             12 |             0 |               1 |       265,889 |         38,656 |

Total live Codex rounds: `18`.

Total proxy request finalizations: `34`.

Health checks:

- Every `round_complete.memoryUpdateError` was `null`.
- Wrapper stderr did not contain `Pando Proxy context bytes`.
- Wrapper stderr did not contain duplicate `pando-proxy: resume with` or
  `pando-proxy: last Codex session id` lines.
- Every round printed token-first proxy accounting: `tokens without proxy`,
  `tokens with proxy, billed all-in`, and `proxy overhead`.

## Test Details

### `real-repo-a`

Rounds:

1. Inspect `README.md` and `src/config.ts`.
2. Inspect `src/wrapper.ts` for token-vs-byte shutdown summary behavior.
3. Recall the earlier facts.

Final answer excerpt:

```text
REAL-A-R3

README fact: `pando-proxy` is a local Codex wrapper that rewrites each Responses request through a strict active-memory sieve.

`DEFAULT_PORT`: `8787`

Wrapper summary conclusion: shutdown/session summary does call `printTokenUsageSummary`, and byte-summary helpers no longer remain in `src/wrapper.ts`.
```

Result: passed. The session used one archive recall in the final round and recovered the requested
facts.

### `fake-values-b`

Rounds:

1. Preserve `ALPHA_KEY=VX-19-ORCHID` and `BETA_TOKEN=QZ_44_MOON`.
2. Preserve `{"route":"nebula-7","limit":42,"flag":"copper"}`.
3. Return all exact fake values.

Final answer:

```text
FAKE-B-R3

ALPHA_KEY=VX-19-ORCHID
BETA_TOKEN=QZ_44_MOON
{"route":"nebula-7","limit":42,"flag":"copper"}
```

Result: passed. Exact fake values were preserved with no archive recall.

### `real-usage-c`

Rounds:

1. Inspect `src/metrics.ts` for accepted usage token field names.
2. Inspect `src/structured_model.ts` for structured usage parsing functions.
3. Summarize the usage accounting path.

Answer excerpts:

```text
REAL-C-R1

Input: `input_tokens`, `prompt_tokens`
Cached input: `cached_input_tokens`, or nested `cached_tokens` inside `input_tokens_details` / `prompt_tokens_details`
Output: `output_tokens`, `completion_tokens`
Total: `total_tokens`
```

```text
REAL-C-R2

The structured response usage parsing functions in `src/structured_model.ts` are:

- `extractUsageMetricsFromStructuredResponse`
- `extractUsageMetricsFromSseText`
```

Result: passed for live proxy behavior. The round 3 natural-language summary used the old label
`UsageAccumulator.add` instead of the current `TokenUsageTracker.add`; that is an answer-quality
issue from the child agent, not a proxy accounting or memory-finalization failure.

### `fake-snippets-d`

Rounds:

1. Preserve `SNIP-D1::alpha=7|bravo=SKY-THREAD|charlie=end`.
2. Preserve `SNIP-D2::{left:[3,1,4],right:'teal-window',ok:true}`.
3. Return both exact snippets.

Final answer:

```text
FAKE-D-R3
SNIP-D1::alpha=7|bravo=SKY-THREAD|charlie=end
SNIP-D2::{left:[3,1,4],right:'teal-window',ok:true}
```

Result: passed. The final round used one bounded archive recall and returned both snippets exactly.

### `mixed-long-e`

Rounds:

1. Inspect `deno.json` for the `check` task.
2. Preserve `OMEGA_RULE=never-drop-cobalt-17`.
3. Inspect `LIVE_E2E.md` for validation rules.
4. Preserve `SIGMA_SEQ=[red-02,green-05,blue-08]`.
5. Inspect `src/upstream.ts` for streamed `responseForClient` behavior.
6. Combine all prior real facts and fake values.

Final answer excerpt:

```text
MIX-E-R6

- `check` task: runs `deno fmt --check`, then `deno lint`, then `deno check src/main.ts`, then `deno test` with net/read/write/env/run permissions.
- `LIVE_E2E` rules:
  - Every resumed live round must use the exact thread id printed by the wrapper.
  - Each round must inspect logs and persisted state before judging memory behavior.
- `responseForClient` streamed behavior: emits synthetic SSE events, adding and completing each output item, then sends a final `response.completed` event with the full body and ends with `data: [DONE]`.
- `OMEGA_RULE=never-drop-cobalt-17`
- `SIGMA_SEQ=[red-02,green-05,blue-08]`
```

Result: passed. Round 3 had a child-agent behavior oddity: it tried to patch `LIVE_E2E.md` despite
the prompt asking it to report two rules. The read-only sandbox rejected the write, the answer still
contained the requested rules, and the final six-round recall combined the required real facts and
fake values.

## Exit Output Check

Negative grep over all saved wrapper stderr found no matches for:

```text
Pando Proxy context bytes
pando-proxy: resume with
pando-proxy: last Codex session id
```

Representative token-first lines appeared in every round:

```text
Pando Proxy tokens without proxy, estimated input (...): min ..., avg ..., max ..., total ...
Pando Proxy tokens with proxy, billed all-in (...): total min ..., avg ..., max ..., total ..., input total ..., cached total ..., output total ..., main total ..., overhead total ...
Pando Proxy proxy overhead (...): total ..., input ..., cached ..., output ..., retries ..., skipped ..., duration ...ms
```

## Conclusion

The accounting and exit-output behavior passed live E2E validation:

- Baseline no-proxy input estimates are visible.
- With-proxy all-in billed totals include exact manager overhead.
- Manager overhead is visible separately.
- The default wrapper exit summary is token-only and substantially less noisy.
- No live run exposed a proxy code issue requiring a fix.
