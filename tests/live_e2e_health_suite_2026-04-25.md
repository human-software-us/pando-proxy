# Live E2E Health Suite: 2026-04-25

Manual live backend runs after the span-based memory changes and same-round supersession fix.

Validation policy:

- live Codex/backend calls only
- one scenario at a time
- exact thread-id resumes
- unit tests skipped because they are out of date
- logs inspected through each scenario's `proxy.jsonl`

## Issue Found And Fixed

The first run of Test 1 exposed a real manager validation bug:

- `piece_retention_batch` returned `supersedesPieceIds` that referenced same-round new pieces.
- The validator only allowed superseding older retained pieces.
- The memory update failed closed with:
  `piece_retention_batch validation failed: piece ... supersedes unknown piece ...`

Fix:

- allow superseding retained pieces or same-round new pieces
- reject self-supersession
- drop superseded new pieces when applying the manager output
- update the manager prompt to document same-round supersession

The failing scenario was rerun from scratch and passed.

## Test 1: Pando Proxy Repo Facts

- Session: `019dc67c-147b-7692-b066-15aa5bc50305`
- Log: `/tmp/pando-live-health-20260425-t1b/proxy.jsonl`
- Rounds: `5`
- Inputs: package metadata, README, `src/source_selectors.ts`, `src/chunking.ts`, `src/prompt_view.ts`, `REFERENCE.md`
- Final output included:
  - package version `0.1.27`
  - package name `pando-proxy`
  - README first sentence
  - `TextSpan`
  - `renderTextSelection`
  - `pando_group_memory`
  - `recall`
  - `text_spans`
  - `duplicate selectors from the same source are deduped by canonical selector identity`
- Result:
  - every `round_complete.memoryUpdateError` was `null`
  - final round used `archiveRecallCount = 1`
  - final output was correct

## Test 2: Downloads Binary/Image Files

- Session: `019dc67f-84c9-77a0-8b27-a30458ec640d`
- Log: `/tmp/pando-live-health-20260425-t2/proxy.jsonl`
- Rounds: `5`
- Inputs:
  - `~/Downloads/10084.jpg`
  - `~/Downloads/#1208.pdf`
  - `~/Downloads/2024 Noe Valley House Tour - 345 Jersey St - House History.docx`
- Final output included:
  - JPEG MIME `image/jpeg`
  - JPEG size `96878`
  - JPEG first 32 bytes `ffd8ffe000104a46494600010100004800480000ffe1008c4578696600004d4d`
  - JPEG dimensions `414x505`
  - JPEG SHA-256 `c477e9a6bc5154bd1278b95a4bd39bee2418bf8a38152e7a89b489d5f21750ae`
  - PDF MIME `application/pdf`
  - PDF size `227256`
  - DOCX MIME `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
  - DOCX first 16 bytes `504b030414000600080000002100dfa4`
- Result:
  - every `round_complete.memoryUpdateError` was `null`
  - final round used `archiveRecallCount = 1`
  - final output was correct

## Test 3: Flask Repo Search Results

- Session: `019dc682-5f65-74d0-a3c4-fb2f60fc1e72`
- Log: `/tmp/pando-live-health-20260425-t3/proxy.jsonl`
- Rounds: `5`
- Inputs:
  - `../flask/pyproject.toml`
  - `../flask/README.md`
  - `../flask/src/flask/app.py`
  - `../flask/src/flask/cli.py`
  - `../flask/tests`
- Final output included:
  - project name `Flask`
  - version setting `version = "3.2.0.dev"`
  - README heading `# Flask`
  - `../flask/src/flask/app.py`
  - `class Flask(App):`
  - `flask = "flask.cli:main"`
  - `def main() -> None:`
  - `14` matching files for `app.test_client`
  - representative line `tests/test_testing.py:120:    client = app.test_client()`
- Result:
  - every `round_complete.memoryUpdateError` was `null`
  - final round used `archiveRecallCount = 1`
  - final output was correct

## Test 4: Pando Extension Repo And Media

- Session: `019dc685-00d0-7053-b06f-6501c9704463`
- Log: `/tmp/pando-live-health-20260425-t4/proxy.jsonl`
- Rounds: `5`
- Inputs:
  - `../pando-extension/package.json`
  - `../pando-extension/media`
  - `../pando-extension/src`
  - `../pando-extension/docs`
- Final output included:
  - package name `pando-extension`
  - package version `0.0.14`
  - package files `package-lock.json`, `package.json`
  - media file `../pando-extension/media/webview-codicon.ttf`
  - MIME `font/sfnt`
  - size `80188`
  - first 24 bytes `00010000000b00800003003047535542208b257a00000138`
  - first exported function line `src/extension.ts:3:export function activate(context: Parameters<typeof activateExtension>[0]) {`
  - representative docs line `README.md:17:4. Connect your agent via MCP`
- Result:
  - every `round_complete.memoryUpdateError` was `null`
  - final round used `archiveRecallCount = 1`
  - final output was correct

## Test 5: Ten-Round Mixed Stress

- Session: `019dc688-1e0e-77b3-9e0e-6d7d53829ec3`
- Log: `/tmp/pando-live-health-20260425-t5/proxy.jsonl`
- Rounds: `10`
- Inputs:
  - this repo package/README/source selector files
  - `~/Downloads/10084.jpg`
  - `~/Downloads/#1208.pdf`
  - `../flask`
  - `../pando-extension/media`
  - `../dotnet-runtime`
  - `../gemini-cli-main`
  - `../pando-extension/docs`
- Final output included:
  - `pando-proxy` `0.1.27`
  - invariant `- active memory is the exact kept piece set`
  - JPEG MIME/size/first bytes
  - PDF MIME/size/first bytes
  - Flask package/version/class path
  - Pando extension font metadata
  - `.NET Runtime` heading and top-level `.sln` count `0`
  - Gemini CLI name/version and packages count `34`
  - `TextSpan` and `renderTextSelection` source lines
  - MCP server loading docs line
- Result:
  - every `round_complete.memoryUpdateError` was `null`
  - final round used `archiveRecallCount = 2`, within the hard cap of `3`
  - final output was correct

## Summary

- Total scenarios: `5`
- Total user rounds: `30`
- One scenario had `10` user rounds.
- No post-fix `memoryUpdateError` remained.
- All final no-tool answers matched the expected facts.
- Recall was used only as bounded recovery and never exceeded the hard cap.
