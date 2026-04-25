# Live E2E Health Suite - More Context Flow - 2026-04-25

These were live backend E2E runs through `deno run -A src/main.ts ... exec` using actual
Codex/OpenAI calls. Unit tests were intentionally skipped. Logs and state were written under
`/tmp/pando-live-health2-*`.

## Summary

| Test | Thread                                                                                                                                              |                                                                User rounds | Data exercised                                                                                           | Result                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1    | `019dc6aa-cf64-7f12-9f09-bbfca5c2a098`                                                                                                              |                                                                          5 | pando-proxy docs/source, Downloads JPG/PDF metadata, Flask repo searches                                 | Passed after one archive recall for old README bullet                                             |
| 2    | `019dc6ae-8d89-7690-b261-0d46111c3a86`                                                                                                              |                                                                          5 | Downloads JPG/WAV/EXE, tiny JSON, large SRT, CSV and pipe-delimited text                                 | Passed after one archive recall for older WAV fact                                                |
| 3    | `019dc6b1-2191-78a2-9e3e-b8c918ba5f1e`; rerun `019dc6cc-31ab-7d23-afdd-f57cb12c11ed`; no-user-config control `019dc6d3-fb1f-7c02-a044-62ea2d37baa1` | 5 plus one retry; 5-round diagnostic rerun; 3-round no-user-config control | pando-extension metadata, large search output, PNG/SVG/TTF metadata, source searches                     | Passed; original stall reproduced as external Codex/MCP child idle, no-user-config control passed |
| 4    | `019dc6ba-ccda-7d53-832a-34fe165d3fae`                                                                                                              |                                                             5 plus retries | gemini-cli metadata/search, dotnet-runtime metadata/search                                               | Passed after fixes; no memory update errors in clean rerun                                        |
| 5    | `019dc6be-aa3b-7652-a1f7-1e1180ec1694`                                                                                                              |                                             12 including corrective rounds | pando-proxy, Downloads binaries/images, Flask, pando-extension, large tables, dotnet-runtime, gemini-cli | Passed after fixing new-piece prune; final no-tool exact copy succeeded                           |

## Aggregate Log Stats

| Test          | `round_complete` events | Memory errors | Recall rounds | Max active pieces | Manager tokens |
| ------------- | ----------------------: | ------------: | ------------: | ----------------: | -------------: |
| 1             |                      10 |             0 |             1 |                 4 |         46,849 |
| 2             |                      10 |             0 |             1 |                 6 |         40,028 |
| 3             |                      12 |             0 |             1 |                 5 |         46,004 |
| 4 clean rerun |                      14 |             0 |             1 |                 2 |         45,114 |
| 5             |                      30 |             0 |             2 |                 3 |         83,049 |

## Log And State Locations

| Test                     | Proxy log                                             | State dir                                       | Output files                                                                                       |
| ------------------------ | ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1                        | `/tmp/pando-live-health2-t1/proxy.jsonl`              | `/tmp/pando-live-health2-t1/state`              | `/tmp/pando-live-health2-t1/r1.txt` through `r5.txt`                                               |
| 2                        | `/tmp/pando-live-health2-t2/proxy.jsonl`              | `/tmp/pando-live-health2-t2/state`              | `/tmp/pando-live-health2-t2/r1.txt` through `r5.txt`                                               |
| 3                        | `/tmp/pando-live-health2-t3/proxy.jsonl`              | `/tmp/pando-live-health2-t3/state`              | `/tmp/pando-live-health2-t3/r1.txt`, `r2.txt`, `r3b.txt`, `r4.txt`, `r5.txt`                       |
| 3 diagnostic rerun       | `/tmp/pando-live-health2-t3-rerun/proxy.jsonl`        | `/tmp/pando-live-health2-t3-rerun/state`        | `/tmp/pando-live-health2-t3-rerun/r1.txt` through `r5.txt`                                         |
| 3 no-user-config control | `/tmp/pando-live-health2-t3-nomcp/proxy.jsonl`        | `/tmp/pando-live-health2-t3-nomcp/state`        | `/tmp/pando-live-health2-t3-nomcp/r1.txt` through `r3.txt`                                         |
| 3 idle capture           | `/tmp/pando-live-health2-t3-idle-capture/proxy.jsonl` | `/tmp/pando-live-health2-t3-idle-capture/state` | `/tmp/pando-live-health2-t3-idle-capture/r1.txt`; intentionally killed after idle capture          |
| 4 first attempt          | `/tmp/pando-live-health2-t4b/proxy.jsonl`             | `/tmp/pando-live-health2-t4b/state`             | Used only for failure investigation                                                                |
| 4 clean rerun            | `/tmp/pando-live-health2-t4c/proxy.jsonl`             | `/tmp/pando-live-health2-t4c/state`             | `/tmp/pando-live-health2-t4c/r1.txt`, `r2.txt`, `r2b.txt`, `r3.txt`, `r4.txt`, `r4b.txt`, `r5.txt` |
| 4 final investigation    | `/tmp/pando-live-health2-t4-investigate3/proxy.jsonl` | `/tmp/pando-live-health2-t4-investigate3/state` | `/tmp/pando-live-health2-t4-investigate3/r1.txt` through `r5.txt`                                  |
| 5                        | `/tmp/pando-live-health2-t5/proxy.jsonl`              | `/tmp/pando-live-health2-t5/state`              | `/tmp/pando-live-health2-t5/r1.txt` through `r12.txt`, with `r8b.txt` retry                        |

## Transcript Details

### Test 1 - pando-proxy to Downloads to Flask

Rounds:

1. `pando-proxy` repo docs/source: package `pando-proxy@0.1.28`, README/REFERENCE active-memory
   invariant, selector kind `text_spans`, `export type TextSpan = {`.
2. Downloads binary metadata: `10084.jpg` as `image/jpeg`, `96878` bytes, first16
   `ffd8ffe000104a464946000101000048`; `#1208.pdf` as `application/pdf`, `227256` bytes, first16
   `255044462d312e360d25e2e3cfd30d0a`.
3. Flask metadata: `Flask@3.2.0.dev`, `README.md:3:# Flask`,
   `src/flask/app.py:109:class Flask(App):`.
4. Flask test search: `app.test_client` in `14` matching files, representative
   `tests/test_testing.py:120:    client = app.test_client()`, CLI entry
   `pyproject.toml:83:flask = "flask.cli:main"`.
5. No shell tools. Final output preserved current Flask facts and recovered old exact README bullet
   via one recall: `- active memory is the exact kept piece set`.

Final excerpt:

```json
{
  "project": { "name": "Flask", "version": "3.2.0.dev" },
  "pandoProxyReadmeActiveMemoryBullet": "- active memory is the exact kept piece set"
}
```

### Test 2 - Downloads Binary, JSON, SRT, CSV, Pipe-Delimited Data

Rounds:

1. Downloads binary metadata: JPG `207558` bytes, WAV `220544` bytes, EXE `24639640` bytes.
2. Tiny JSON file `tools-export-1738114633084.json`: byte size `2`, content `[]`, `"name"`
   occurrences `0`; confusing note resolved to `zebra=19`, `amber_belongs_with=WAV`.
3. Large SRT: byte size `137764`, first cue `00:00:00,000 --> 00:00:05,000`, last cue `2061`,
   `Frodo|Sam` line count `64`.
4. Large table files: `export-10.csv` byte size `1273879`, first-line comma count `2`; `cm 2.txt`
   byte size `2376157`, first-line comma count `4`.
5. No shell tools. Final output retained table first lines and used one recall to recover older WAV
   byte size `220544`.

Final excerpt:

```json
{ "resolved_note_facts": { "zebra": 19, "amber_belongs_with": "WAV" }, "wav_byte_size": 220544 }
```

### Test 3 - pando-extension Search, Media, Source Facts

Rounds:

1. `pando-extension` metadata: package `pando-extension@0.0.14`, README heading
   `# pandō — VS Code Extension`, script key count `29`.
2. Large `snapshot|workspace` search in `src docs`: counts `snapshot=980`, `workspace=436`, combined
   `1396`, first snippets from `docs/clojure-implementation-plan.md`.
3. First media attempt stalled after one successful `panel-icon.svg` command. The wrapper process
   was killed after the proxy finalized safely with no memory update error. Retry `r3b.txt` used one
   combined command and returned `media/icon.png` `3260` bytes, `media/panel-icon.svg` `884` bytes,
   `media/webview-codicon.ttf` `80188` bytes.
4. Source facts: `activate` line
   `132:export async function activate(context: vscode.ExtensionContext) {`, `PandoService` mentions
   `46`, first three `workspaceRoots` lines.
5. No shell tools. Final output retained source facts, media byte facts, and package version
   `0.0.14`.

Final excerpt:

```json
{
  "round4": {
    "activate": "132:export async function activate(context: vscode.ExtensionContext) {",
    "pandoServiceClassMentions": 46
  },
  "round3": {
    "media/icon.png": { "bytes": 3260 },
    "media/webview-codicon.ttf": { "bytes": 80188 }
  },
  "round1": { "version": "0.0.14" }
}
```

Diagnostic rerun:

- Original stalled request ID: `52e14550-392c-4159-8f05-358bbea53387`.
- Original stalled thread: `019dc6b1-2191-78a2-9e3e-b8c918ba5f1e`.
- Original evidence: the proxy logged `incoming_request`, `rewritten_context`, successful
  `upstream_response`, one successful `codex_exec_event` for `media/panel-icon.svg`, and then
  `round_complete` with `memoryUpdateError: null` and `pieceCount: 0`.
- Original evidence: after that `round_complete`, there were no further `codex_exec_event` entries
  and no second upstream request before the wrapper was killed manually.
- Conclusion from original logs: the memory manager and proxy request path finalized cleanly; the
  failure was an outer Codex child/tool-loop stall with stdout going silent after the first command.
- Added diagnostics: `wrapper_codex_child_spawned`, `wrapper_exec_json_idle`, and `wrapper_exit` now
  report child `pid`, emitted stdout bytes, idle log count, and a bounded descendant-process
  snapshot for `exec --json` wrapper runs.
- Rerun thread: `019dc6cc-31ab-7d23-afdd-f57cb12c11ed`.
- Rerun result: all five rounds completed; no `wrapper_exec_json_idle` events fired, every
  `wrapper_exit` had `code: 0`, and every `round_complete` had `memoryUpdateError: null`.
- Rerun memory stats: final no-tool round used one archive recall, returned `4764` archive bytes,
  and preserved package version `0.0.14`, `media/icon.png` bytes `3260`, `media/webview-codicon.ttf`
  bytes `80188`, and the round 4 source facts.
- Forced idle capture: `/tmp/pando-live-health2-t3-idle-capture/proxy.jsonl` reproduced the stall
  with global Codex user config enabled. `wrapper_exec_json_idle` showed the Codex child had
  descendants `codex`,
  `node /Users/george/Documents/GitHub/pando-extension/packages/pando-cli/dist/cli.js`, and
  `watcher-process.js`.
- Root cause conclusion: the stalled runs did not send the completed tool output back to the proxy
  as a follow-up request. The proxy had already returned the upstream response and finalized memory
  cleanly. The observed hang is an outer Codex/MCP child-process stall, not an active-memory
  failure.
- No-user-config control: `--ignore-user-config` preserved auth but removed inherited Codex MCP
  config. The three-round control completed with no idle events, no memory update errors, and
  correct final no-tool output.

Diagnostic rerun final excerpt:

```json
{
  "activateLine": "132:export async function activate(context: vscode.ExtensionContext) {",
  "pandoServiceClassMentions": 46,
  "workspaceRootsFirstThree": [
    "113:    const workspaceRootsNow = this.resolveStartupWorkspaceRoots();",
    "118:      workspaceRootsNow,",
    "138:      workspaceRootsRaw: workspaceRootsNow,"
  ],
  "mediaByteSizes": { "media/icon.png": 3260, "media/webview-codicon.ttf": 80188 },
  "originalPackageVersion": "0.0.14"
}
```

No-user-config control final excerpt:

```json
{
  "media/icon.png": { "byte_size": 3260 },
  "media/webview-codicon.ttf": { "byte_size": 80188 },
  "version": "0.0.14",
  "activateExportLine": "export async function activate(context: vscode.ExtensionContext) {"
}
```

## Health3 Additional Live E2E Runs

These were additional live backend E2E runs through `deno run -A src/main.ts ... exec` using actual
Codex/OpenAI calls. Unit tests were intentionally skipped. Logs and state were written under
`/tmp/pando-live-health3-*`.

### Summary

| Test | Thread | User rounds | Data exercised | Result |
| ---- | ------ | ----------: | -------------- | ------ |
| 1 | `019dc6f7-6d4e-7011-97a7-6cea8dd1f54f` | 5 | pando-proxy metadata, Downloads JPG/CSV/JSON, Flask search, Gemini large search, no-tool recall | Passed |
| 2 | `019dc6fa-62ab-73e1-85ac-1b590654a357` | 5 | pando-extension media/font files, Downloads HEIC/PNG/PDF, dotnet-runtime, elasticsearch docs, no-tool recall | Passed |
| 3 | `019dc6fd-00f9-7f11-8348-6605a60ebf10` | 5 | Hospital CSV/JSON, SRT subtitle text, Metabase search, pando-proxy recall/retention search | Passed |
| 4 | `019dc701-51e6-76d1-969d-1f332b2b8732` | 5 | Downloads EXE/HEIC/JPG, pando-extension large search, Flask, Gemini, no-tool recall | Passed |
| 5 first attempt | `019dc705-3099-7d13-bb64-985a36ae66f5` | 4 completed plus failed round 5 | pando-proxy, binaries/images, Flask, very large dotnet search, hospital pricing retry | Abandoned after Codex stream/no-message and child idle; proxy memory updates stayed clean |
| 5B replacement | `019dc70a-fece-7172-b0a4-2e4a5712fffb` | 10 | pando-proxy, binaries/images, Flask, dotnet, hospital CSV/JSON, pando-extension media, Gemini, SRT, elasticsearch, no-tool recall | Passed |

### Aggregate Log Stats

| Test | `round_complete` events | Memory errors | Recall rounds | Max active pieces | Max active bytes | Manager tokens | Max chunk input | Max retention input | Retry attempts |
| ---- | ----------------------: | ------------: | ------------: | ----------------: | ---------------: | -------------: | --------------: | ------------------: | -------------: |
| 1 | 12 | 0 | 1 | 8 | 5,508 | 47,725 | 3,138 | 2,504 | 0 |
| 2 | 12 | 0 | 1 | 4 | 1,556 | 39,826 | 1,507 | 1,746 | 0 |
| 3 | 20 | 0 | 1 | 7 | 6,770 | 70,425 | 6,851 | 3,134 | 0 |
| 4 | 12 | 0 | 1 | 4 | 282,426 | 117,174 | 75,089 | 1,720 | 0 |
| 5B | 26 | 0 | 1 | 10 | 34,217 | 111,955 | 15,561 | 3,889 | 0 |

### Log And State Locations

| Test | Proxy log | State dir | Output files |
| ---- | --------- | --------- | ------------ |
| 1 | `/tmp/pando-live-health3-t1/proxy.jsonl` | `/tmp/pando-live-health3-t1/state` | `/tmp/pando-live-health3-t1/r1.txt` through `r5.txt` |
| 2 | `/tmp/pando-live-health3-t2/proxy.jsonl` | `/tmp/pando-live-health3-t2/state` | `/tmp/pando-live-health3-t2/r1.txt` through `r5.txt` |
| 3 | `/tmp/pando-live-health3-t3/proxy.jsonl` | `/tmp/pando-live-health3-t3/state` | `/tmp/pando-live-health3-t3/r1.txt` through `r5.txt` |
| 4 | `/tmp/pando-live-health3-t4/proxy.jsonl` | `/tmp/pando-live-health3-t4/state` | `/tmp/pando-live-health3-t4/r1.txt` through `r5.txt` |
| 5 first attempt | `/tmp/pando-live-health3-t5/proxy.jsonl` | `/tmp/pando-live-health3-t5/state` | `/tmp/pando-live-health3-t5/r1.txt` through `r5.txt`, `r5b.txt` retry |
| 5B replacement | `/tmp/pando-live-health3-t5b/proxy.jsonl` | `/tmp/pando-live-health3-t5b/state` | `/tmp/pando-live-health3-t5b/r1.txt` through `r10.txt` |

### Test 1 - pando-proxy, Downloads, Flask, Gemini

Rounds:

1. pando-proxy package and memory implementation facts: package `0.1.31`, recall mentions `44`,
   retention mentions `7`.
2. Downloads facts: `10084.jpg` first16 `ffd8ffe000104a464946000101000048`,
   `2026-04-23_payment_report.csv`, and `20250527_151257_typingmind_chats.json`.
3. Flask search: version `3.2.0.dev`, `app.test_client` count `57`, blueprint snippets.
4. Gemini large search: `mcpLineCount=5177`, `sandboxLineCount=1115`.
5. No shell tools. Final output preserved Gemini, Flask, and JPG facts.

Final excerpt:

```json
{
  "gemini": { "version": "0.25.0-nightly.20260107.59a18e710", "mcpLineCount": 5177, "sandboxLineCount": 1115 },
  "flask": { "version": "3.2.0.dev", "appTestClientCount": 57 },
  "jpgFirst16": "ffd8ffe000104a464946000101000048"
}
```

### Test 2 - Extension Media, HEIC/PNG/PDF, Dotnet, Elasticsearch

Rounds:

1. pando-extension media/font facts: `icon.png`, `panel-icon.svg`, `webview-codicon.ttf`.
2. Downloads HEIC/PNG/PDF facts: HEIC first16 `00000020667479706865696300000000`.
3. dotnet-runtime globalization search: SDK `11.0.100-preview.1.26104.118`, `Invariant=6607`.
4. elasticsearch docs search: `snapshotLineCount=11`, `securityLineCount=10`.
5. No shell tools. Final output preserved dotnet, elasticsearch, and HEIC facts.

Final excerpt:

```json
{
  "elasticsearch": { "snapshotLineCount": 11, "securityLineCount": 10 },
  "dotnet": { "sdk": "11.0.100-preview.1.26104.118", "Invariant": 6607 },
  "heicFirst16": "00000020667479706865696300000000"
}
```

### Test 3 - Hospital Pricing, SRT, Metabase, pando-proxy Search

Rounds:

1. Downloads hospital pricing CSV/JSON metadata and small slices.
2. SRT subtitle scan: `cue_count_estimate=2060`, `frodo_or_sam_line_count=62`.
3. Metabase search: `database=9586`, `driver=6500`.
4. pando-proxy recall/retention search: package `0.1.31`, `recall_count=44`, `retention_count=7`;
   `docs` path was missing and reported as such.
5. No shell tools. Final output preserved pando-proxy, Metabase, and SRT facts.

Final excerpt:

```json
{
  "pando_proxy": { "version": "0.1.31", "recall_count": 44, "retention_count": 7 },
  "metabase": { "database": 9586, "driver": 6500 },
  "srt": { "cue_count_estimate": 2060, "frodo_or_sam_line_count": 62 }
}
```

### Test 4 - Binaries, pando-extension Large Search, Flask, Gemini

Rounds:

1. Downloads EXE/HEIC/JPG metadata: `sourceinsight40148_7177-setup.exe` bytes `24639640`, first16
   `4d5a90000300000004000000ffff0000`.
2. pando-extension large `snapshot|workspace|codicon` search: `snapshot=2982`, `workspace=1083`,
   `codicon=23`.
3. Flask search: heading `# Flask`, `template=798`, `blueprint=488`.
4. Gemini search: version `0.25.0-nightly.20260107.59a18e710`, `oauth=1186`, `sandbox=1023`.
5. No shell tools. Final output recovered older EXE facts and current Gemini/Flask facts.

Final excerpt:

```json
{
  "gemini": { "oauth": 1186, "sandbox": 1023 },
  "flask": { "template": 798, "blueprint": 488 },
  "sourceinsight40148_7177-setup.exe": { "byte_size": 24639640, "first16_hex": "4d5a90000300000004000000ffff0000" }
}
```

### Test 5 First Attempt - Abandoned Long Session

The first long-session attempt intentionally pushed a very large dotnet search stream through the
proxy. Round 4 completed and the manager pruned the oversized active pieces on the next finalize,
but round 5 exposed two outer Codex behaviors:

- One run returned only `turn.started` and `turn.completed` with no assistant/tool items. The proxy
  sent a normal rewritten request and finalized memory with `memoryUpdateError: null`.
- A retry produced an initial assistant message and one shell result, then no follow-up request
  reached the proxy for more than two minutes. The wrapper emitted `wrapper_exec_json_idle`; the
  stuck process was terminated manually.

This attempt was not counted as the passing long test. It remained useful as a stress diagnostic:
the active-memory manager had zero schema/memory errors, but the outer Codex child stalled after
large prior context/tool history.

### Test 5B - Replacement 10-Round Long Session

Rounds:

1. pando-proxy package/search: version `0.1.31`, recall count `36`,
   `retained_piece_prune` count `7`.
2. Downloads binaries/images: EXE bytes `24639640`, first16
   `4d5a90000300000004000000ffff0000`; HEIC and JPG metadata.
3. Flask bounded search: heading `# Flask`, case-sensitive `blueprint=359`, `template=727`.
4. dotnet-runtime bounded search: SDK `11.0.100-preview.1.26104.118`, `Invariant=6607`,
   `Globalization=5244`.
5. Hospital pricing CSV/JSON parsing: Delta first sample gross charge `140.85`; also Montana,
   Tri-City, and SageWest JSON samples.
6. pando-extension media/font metadata: package `0.0.14`, `icon.png=3260`,
   `webview-codicon.ttf=80188`.
7. Gemini bounded docs/packages search: version `0.25.0-nightly.20260107.59a18e710`,
   `oauth=2895`, `sandbox=1409`.
8. SRT subtitle scan: cue count estimate `2061`, `Frodo|Sam` line count `62`.
9. Elasticsearch docs search: `snapshot=897`, `security=1251`.
10. No shell tools. Final output preserved facts from rounds 1, 2, 5, 7, and 9.

Final excerpt:

```json
{
  "pando_proxy": { "version": "0.1.31", "recall_count": 36 },
  "binary_exe": { "bytes": 24639640, "first16_hex": "4d5a90000300000004000000ffff0000" },
  "hospital_delta_first_sample_gross_charge": "140.85",
  "gemini_counts": { "oauth": 2895, "sandbox": 1409 },
  "elasticsearch_counts": { "snapshot": 897, "security": 1251 }
}
```

### Test 4 - gemini-cli to dotnet-runtime

First attempt:

- A live round logged `memoryUpdateError: "Structured model response did not include text"` while
  the session recovered later. This drove the structured invocation retry and settled parallel call
  fix.
- Follow-up log inspection identified the failing request as `797aed49-af57-4b53-8033-c112784e9da6`
  in `/tmp/pando-live-health2-t4b/proxy.jsonl`. The old log showed `source_chunk_batch` selected on
  a very large search payload, then `round_complete` emitted the memory error before a late
  `group_intent` usage event arrived. That confirmed the old implementation could report a parallel
  manager failure before both branches had fully settled and been attributed.
- A diagnostic rerun with `structured_model_error` logging exposed the remaining core issue:
  `piece_retention_batch` was still receiving full exact piece payloads. A large tool-output round
  pushed retention to a roughly 50k-token call and timed out once. The fix changed retention inputs
  to preview/pointer/selector/byte-size anchors only; exact payloads remain stored and rendered, but
  retention does not reread full content.
- The wrapper also now waits long enough for one manager timeout plus one retry before printing the
  final summary and shutting down, and the CLI entrypoint exits explicitly after wrapper shutdown so
  closed live runs cannot remain alive on upstream keep-alive sockets.

Clean rerun rounds:

1. Gemini metadata: `@google/gemini-cli@0.25.0-nightly.20260107.59a18e710`, README `Gemini CLI`,
   core package same version.
2. Gemini search: first bad temp-file attempt failed under read-only sandbox, retry without temp
   files returned `authLineCount=4809`, `sandboxLineCount=722`, and sandbox docs snippets.
3. Dotnet metadata: README `# .NET Runtime`, SDK `11.0.100-preview.1.26104.118`, `String.cs` byte
   size `28982`.
4. Dotnet search: initial temp-file attempt returned counts but no snippets; retry without temp
   files returned first five `Invariant|Globalization` snippets.
5. No shell tools. Final output retained dotnet counts/snippets and recovered Gemini root version.

Final excerpt:

```json
{
  "dotnetCounts": { "Invariant": 6270, "Globalization": 4574 },
  "dotnetGlobalSdkVersion": "11.0.100-preview.1.26104.118",
  "geminiRootVersion": "0.25.0-nightly.20260107.59a18e710"
}
```

Final investigation rerun:

- Thread: `019dc6f2-4e9e-7b91-91f0-2c980c2f7489`.
- Log: `/tmp/pando-live-health2-t4-investigate3/proxy.jsonl`.
- State: `/tmp/pando-live-health2-t4-investigate3/state`.
- Outputs: `/tmp/pando-live-health2-t4-investigate3/r1.txt` through `r5.txt`.
- Rounds:
  1. Gemini metadata: `@google/gemini-cli@0.25.0-nightly.20260107.59a18e710`, README `Gemini CLI`,
     core package same version. This round also unintentionally produced a large `rg --files` output
     including node_modules paths, which exercised the high-volume chunking path.
  2. Gemini search: `auth_line_count=8338`, `sandbox_line_count=1118`, first snippet
     `docs/get-started/configuration.md:760:- **\`security.auth.selectedType\`** (string):`.
  3. Dotnet metadata: README `# .NET Runtime`, SDK `11.0.100-preview.1.26104.118`, `String.cs` byte
     size `28982`.
  4. Dotnet search: `Invariant=8489`, `Globalization=5368`, first snippet
     `docs/design/mono/mono-manpage-1.md:1145:members of System.Globalization.CompareInfo class. Collation is enabled`.
  5. No shell tools. Final output preserved the round 4 counts/snippets, dotnet SDK, and Gemini root
     package version; it used one bounded archive recall.
- Log stats: `11` `round_complete` events, `0` memory errors, `1` recall round, max active pieces
  `6`, manager tokens `87,618`.
- The stress round had `source_chunk_batch.inputTokens=48,258`, but
  `piece_retention_batch.inputTokens=1,848`; this confirms the retention payload cliff is gone.
- No `structured_model_error`, `memory_update_failed`, or `wrapper_pending_finalization_timeout`
  events appeared in the final investigation rerun.

Final investigation excerpt:

```json
{
  "dotnet": {
    "counts": { "Invariant": 8489, "Globalization": 5368 },
    "global_sdk_version": "11.0.100-preview.1.26104.118"
  },
  "gemini": { "root_package_version": "0.25.0-nightly.20260107.59a18e710" }
}
```

### Test 5 - Long Mixed 12-Round Session

Rounds:

1. `pando-proxy` package `0.1.28`, README heading `# pando-proxy`, `src/chunking.ts` line count
   `268`.
2. Downloads JPG/PDF/WAV metadata.
3. Flask metadata and large `app.test_client` search.
4. `pando-extension` large `snapshot|workspace` search.
5. Downloads large CSV and pipe-delimited file first-line facts.
6. Dotnet-runtime metadata and very large `Invariant|Globalization` search output.
7. Gemini CLI docs search and version.
8. Initial EXE/HEIC binary round stalled after one tool call; retry `r8b.txt` returned correct EXE
   and HEIC facts.
9. No shell tools. The model output changed EXE/HEIC byte values, exposing that newly kept assistant
   facts had been pruned.
10. After fixing old-piece-only prune, reran EXE/HEIC metadata and re-established exact facts.
11. No shell tools. Exact current binary/image facts copied correctly without recall.
12. No shell tools. Final output kept current binary/image facts and recovered earlier pando-proxy
    and Flask versions.

Incorrect round 9 excerpt that triggered the fix:

```json
{
  "sourceinsight40148_7177-setup.exe": { "mime": "application/x-msdownload", "bytes": 7853656 },
  "IMG_9323.HEIC": { "bytes": 2877299 }
}
```

Corrected final excerpt:

```json
{
  "binaryImagePair": {
    "sourceinsight40148_7177-setup.exe": {
      "mime": "application/x-dosexec",
      "bytes": 24639640,
      "first16Hex": "4d5a90000300000004000000ffff0000"
    },
    "IMG_9323.HEIC": {
      "mime": "image/heic",
      "bytes": 3088881,
      "first16Hex": "00000034667479706865696300000000"
    }
  },
  "pandoProxyVersion": "0.1.28",
  "flaskVersion": "3.2.0.dev"
}
```

## Issues Found And Fixed

- `Structured model response did not include text` appeared once in the first Test 4 attempt. The
  fix makes parallel chunk/group calls wait for both branches to settle before reporting failure,
  and applies the documented single retry to structured invocation failures as well as
  schema-validation failures.
- Test 4 reinvestigation found that `piece_retention_batch` still included full new-piece content,
  making retention scale with large tool payloads. The fix makes retention preview/anchor-based:
  `previewText`, `byteSize`, `selector`, and pointer metadata only.
- Test 4 reinvestigation also found closed wrapper processes could stay alive after proxy shutdown
  because upstream keep-alive sockets remained open. The fix makes the CLI entrypoint call
  `Deno.exit` after `main()` resolves.
- In Test 5, `retained_piece_prune` dropped a newly kept assistant result, so a no-tool follow-up
  produced incorrect EXE/HEIC byte facts after recall missed the newer source. The fix restores the
  intended old-piece-prune invariant: retention decides new pieces; prune can only drop old pieces.

## Final Output Checks

- Test 1 final recovered `- active memory is the exact kept piece set` and current Flask facts.
- Test 2 final retained large table first lines and recalled the older WAV byte size `220544`.
- Test 3 final retained source facts and media byte facts; the killed stuck round did not produce a
  memory error.
- Test 4 clean final returned dotnet counts `Invariant=6270`, `Globalization=4574`, SDK
  `11.0.100-preview.1.26104.118`, and Gemini version `0.25.0-nightly.20260107.59a18e710`.
- Test 5 final no-tool response copied the corrected binary facts exactly: EXE bytes `24639640`,
  HEIC bytes `3088881`, EXE first16 `4d5a90000300000004000000ffff0000`, HEIC first16
  `00000034667479706865696300000000`.

## Verification

- `deno check src/main.ts src/replay.ts bin/replay.ts scripts/verbatim_check.ts` passed after code
  changes.
- Unit tests were not run.
