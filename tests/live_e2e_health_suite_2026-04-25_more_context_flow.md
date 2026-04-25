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

## Log And State Locations

| Test | Proxy log | State dir | Output files |
| --- | --- | --- | --- |
| 1 | `/tmp/pando-live-health2-t1/proxy.jsonl` | `/tmp/pando-live-health2-t1/state` | `/tmp/pando-live-health2-t1/r1.txt` through `r5.txt` |
| 2 | `/tmp/pando-live-health2-t2/proxy.jsonl` | `/tmp/pando-live-health2-t2/state` | `/tmp/pando-live-health2-t2/r1.txt` through `r5.txt` |
| 3 | `/tmp/pando-live-health2-t3/proxy.jsonl` | `/tmp/pando-live-health2-t3/state` | `/tmp/pando-live-health2-t3/r1.txt`, `r2.txt`, `r3b.txt`, `r4.txt`, `r5.txt` |
| 4 first attempt | `/tmp/pando-live-health2-t4b/proxy.jsonl` | `/tmp/pando-live-health2-t4b/state` | Used only for failure investigation |
| 4 clean rerun | `/tmp/pando-live-health2-t4c/proxy.jsonl` | `/tmp/pando-live-health2-t4c/state` | `/tmp/pando-live-health2-t4c/r1.txt`, `r2.txt`, `r2b.txt`, `r3.txt`, `r4.txt`, `r4b.txt`, `r5.txt` |
| 5 | `/tmp/pando-live-health2-t5/proxy.jsonl` | `/tmp/pando-live-health2-t5/state` | `/tmp/pando-live-health2-t5/r1.txt` through `r12.txt`, with `r8b.txt` retry |

## Transcript Details

### Test 1 - pando-proxy to Downloads to Flask

Rounds:

1. `pando-proxy` repo docs/source: package `pando-proxy@0.1.28`, README/REFERENCE active-memory invariant, selector kind `text_spans`, `export type TextSpan = {`.
2. Downloads binary metadata: `10084.jpg` as `image/jpeg`, `96878` bytes, first16 `ffd8ffe000104a464946000101000048`; `#1208.pdf` as `application/pdf`, `227256` bytes, first16 `255044462d312e360d25e2e3cfd30d0a`.
3. Flask metadata: `Flask@3.2.0.dev`, `README.md:3:# Flask`, `src/flask/app.py:109:class Flask(App):`.
4. Flask test search: `app.test_client` in `14` matching files, representative `tests/test_testing.py:120:    client = app.test_client()`, CLI entry `pyproject.toml:83:flask = "flask.cli:main"`.
5. No shell tools. Final output preserved current Flask facts and recovered old exact README bullet via one recall: `- active memory is the exact kept piece set`.

Final excerpt:

```json
{"project":{"name":"Flask","version":"3.2.0.dev"},"pandoProxyReadmeActiveMemoryBullet":"- active memory is the exact kept piece set"}
```

### Test 2 - Downloads Binary, JSON, SRT, CSV, Pipe-Delimited Data

Rounds:

1. Downloads binary metadata: JPG `207558` bytes, WAV `220544` bytes, EXE `24639640` bytes.
2. Tiny JSON file `tools-export-1738114633084.json`: byte size `2`, content `[]`, `"name"` occurrences `0`; confusing note resolved to `zebra=19`, `amber_belongs_with=WAV`.
3. Large SRT: byte size `137764`, first cue `00:00:00,000 --> 00:00:05,000`, last cue `2061`, `Frodo|Sam` line count `64`.
4. Large table files: `export-10.csv` byte size `1273879`, first-line comma count `2`; `cm 2.txt` byte size `2376157`, first-line comma count `4`.
5. No shell tools. Final output retained table first lines and used one recall to recover older WAV byte size `220544`.

Final excerpt:

```json
{"resolved_note_facts":{"zebra":19,"amber_belongs_with":"WAV"},"wav_byte_size":220544}
```

### Test 3 - pando-extension Search, Media, Source Facts

Rounds:

1. `pando-extension` metadata: package `pando-extension@0.0.14`, README heading `# pandō — VS Code Extension`, script key count `29`.
2. Large `snapshot|workspace` search in `src docs`: counts `snapshot=980`, `workspace=436`, combined `1396`, first snippets from `docs/clojure-implementation-plan.md`.
3. First media attempt stalled after one successful `panel-icon.svg` command. The wrapper process was killed after the proxy finalized safely with no memory update error. Retry `r3b.txt` used one combined command and returned `media/icon.png` `3260` bytes, `media/panel-icon.svg` `884` bytes, `media/webview-codicon.ttf` `80188` bytes.
4. Source facts: `activate` line `132:export async function activate(context: vscode.ExtensionContext) {`, `PandoService` mentions `46`, first three `workspaceRoots` lines.
5. No shell tools. Final output retained source facts, media byte facts, and package version `0.0.14`.

Final excerpt:

```json
{"round4":{"activate":"132:export async function activate(context: vscode.ExtensionContext) {","pandoServiceClassMentions":46},"round3":{"media/icon.png":{"bytes":3260},"media/webview-codicon.ttf":{"bytes":80188}},"round1":{"version":"0.0.14"}}
```

### Test 4 - gemini-cli to dotnet-runtime

First attempt:

- A live round logged `memoryUpdateError: "Structured model response did not include text"` while the session recovered later. This drove the structured invocation retry and settled parallel call fix.

Clean rerun rounds:

1. Gemini metadata: `@google/gemini-cli@0.25.0-nightly.20260107.59a18e710`, README `Gemini CLI`, core package same version.
2. Gemini search: first bad temp-file attempt failed under read-only sandbox, retry without temp files returned `authLineCount=4809`, `sandboxLineCount=722`, and sandbox docs snippets.
3. Dotnet metadata: README `# .NET Runtime`, SDK `11.0.100-preview.1.26104.118`, `String.cs` byte size `28982`.
4. Dotnet search: initial temp-file attempt returned counts but no snippets; retry without temp files returned first five `Invariant|Globalization` snippets.
5. No shell tools. Final output retained dotnet counts/snippets and recovered Gemini root version.

Final excerpt:

```json
{"dotnetCounts":{"Invariant":6270,"Globalization":4574},"dotnetGlobalSdkVersion":"11.0.100-preview.1.26104.118","geminiRootVersion":"0.25.0-nightly.20260107.59a18e710"}
```

### Test 5 - Long Mixed 12-Round Session

Rounds:

1. `pando-proxy` package `0.1.28`, README heading `# pando-proxy`, `src/chunking.ts` line count `268`.
2. Downloads JPG/PDF/WAV metadata.
3. Flask metadata and large `app.test_client` search.
4. `pando-extension` large `snapshot|workspace` search.
5. Downloads large CSV and pipe-delimited file first-line facts.
6. Dotnet-runtime metadata and very large `Invariant|Globalization` search output.
7. Gemini CLI docs search and version.
8. Initial EXE/HEIC binary round stalled after one tool call; retry `r8b.txt` returned correct EXE and HEIC facts.
9. No shell tools. The model output changed EXE/HEIC byte values, exposing that newly kept assistant facts had been pruned.
10. After fixing old-piece-only prune, reran EXE/HEIC metadata and re-established exact facts.
11. No shell tools. Exact current binary/image facts copied correctly without recall.
12. No shell tools. Final output kept current binary/image facts and recovered earlier pando-proxy and Flask versions.

Incorrect round 9 excerpt that triggered the fix:

```json
{"sourceinsight40148_7177-setup.exe":{"mime":"application/x-msdownload","bytes":7853656},"IMG_9323.HEIC":{"bytes":2877299}}
```

Corrected final excerpt:

```json
{"binaryImagePair":{"sourceinsight40148_7177-setup.exe":{"mime":"application/x-dosexec","bytes":24639640,"first16Hex":"4d5a90000300000004000000ffff0000"},"IMG_9323.HEIC":{"mime":"image/heic","bytes":3088881,"first16Hex":"00000034667479706865696300000000"}},"pandoProxyVersion":"0.1.28","flaskVersion":"3.2.0.dev"}
```

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
