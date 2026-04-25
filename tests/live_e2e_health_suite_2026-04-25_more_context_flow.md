# Live E2E Health Suite - More Context Flow - 2026-04-25

These were live backend E2E runs through `deno run -A src/main.ts ... exec` using actual Codex/OpenAI calls. Unit tests were intentionally skipped. Logs and state were written under `/tmp/pando-live-health2-*`.

## Summary

| Test | Thread | User rounds | Data exercised | Result |
| --- | --- | ---: | --- | --- |
| 1 | `019dc6aa-cf64-7f12-9f09-bbfca5c2a098` | 5 | pando-proxy docs/source, Downloads JPG/PDF metadata, Flask repo searches | Passed after one archive recall for old README bullet |
| 2 | `019dc6ae-8d89-7690-b261-0d46111c3a86` | 5 | Downloads JPG/WAV/EXE, tiny JSON, large SRT, CSV and pipe-delimited text | Passed after one archive recall for older WAV fact |
| 3 | `019dc6b1-2191-78a2-9e3e-b8c918ba5f1e` | 5 plus one retry | pando-extension metadata, large search output, PNG/SVG/TTF metadata, source searches | Passed; one outer Codex tool-loop stall was killed and retried |
| 4 | `019dc6ba-ccda-7d53-832a-34fe165d3fae` | 5 plus retries | gemini-cli metadata/search, dotnet-runtime metadata/search | Passed after fixes; no memory update errors in clean rerun |
| 5 | `019dc6be-aa3b-7652-a1f7-1e1180ec1694` | 12 including corrective rounds | pando-proxy, Downloads binaries/images, Flask, pando-extension, large tables, dotnet-runtime, gemini-cli | Passed after fixing new-piece prune; final no-tool exact copy succeeded |

## Aggregate Log Stats

| Test | `round_complete` events | Memory errors | Recall rounds | Max active pieces | Manager tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 10 | 0 | 1 | 4 | 46,849 |
| 2 | 10 | 0 | 1 | 6 | 40,028 |
| 3 | 12 | 0 | 1 | 5 | 46,004 |
| 4 clean rerun | 14 | 0 | 1 | 2 | 45,114 |
| 5 | 30 | 0 | 2 | 3 | 83,049 |

## Issues Found And Fixed

- `Structured model response did not include text` appeared once in the first Test 4 attempt. The fix makes parallel chunk/group calls wait for both branches to settle before reporting failure, and applies the documented single retry to structured invocation failures as well as schema-validation failures.
- In Test 5, `retained_piece_prune` dropped a newly kept assistant result, so a no-tool follow-up produced incorrect EXE/HEIC byte facts after recall missed the newer source. The fix restores the intended old-piece-prune invariant: retention decides new pieces; prune can only drop old pieces.

## Final Output Checks

- Test 1 final recovered `- active memory is the exact kept piece set` and current Flask facts.
- Test 2 final retained large table first lines and recalled the older WAV byte size `220544`.
- Test 3 final retained source facts and media byte facts; the killed stuck round did not produce a memory error.
- Test 4 clean final returned dotnet counts `Invariant=6270`, `Globalization=4574`, SDK `11.0.100-preview.1.26104.118`, and Gemini version `0.25.0-nightly.20260107.59a18e710`.
- Test 5 final no-tool response copied the corrected binary facts exactly: EXE bytes `24639640`, HEIC bytes `3088881`, EXE first16 `4d5a90000300000004000000ffff0000`, HEIC first16 `00000034667479706865696300000000`.

## Verification

- `deno check src/main.ts src/replay.ts bin/replay.ts scripts/verbatim_check.ts` passed after code changes.
- Unit tests were not run.
