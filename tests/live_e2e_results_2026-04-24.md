# Live E2E Results 2026-04-24

These are manual live backend runs against the current proxy implementation.

- Real backend calls
- Real auth from local Codex auth or `OPENAI_API_KEY`
- Logs inspected via `proxy.jsonl`
- Persisted state inspected via `SessionStore`
- Unit tests intentionally not used as a correctness signal

Only completed runs are listed here. Interrupted or harness-bug runs are excluded.

## Test 1: Keep Exact Token Across 3 Rounds

Goal:

- verify a simple retained exact token survives to round 3
- verify no archive recall is needed

Rounds:

1. store exact token, expect `READY-1`
2. distraction, expect `READY-2`
3. ask for exact token

Observed outputs:

- round 1: `READY-1`
- round 2: `READY-2`
- round 3: `BLUE-MANUAL-01-7319`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null]`
- `pieceCounts`: `[2, 2, 2]`
- `processedSourceCounts`: `[2, 4, 6]`
- `archiveRecallCount`: `0`
- `structured_model_skipped`: `0`

Commentary:

- clean pass
- exact token survived
- working set stayed bounded

## Test 2: Replace Old Token With New Token

Goal:

- verify a new unrelated task replaces old exact state

Rounds:

1. store old token
2. explicitly replace with new token
3. ask for current token

Observed outputs:

- round 1: `OLD-STORED`
- round 2: `NEW-STORED`
- round 3: `AMBER-MANUAL-02-4826`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null]`
- `pieceCounts`: `[1, 1, 1]`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- old token was dropped
- final active memory collapsed to one exact piece

## Test 3: Explicit Close Clears Memory

Goal:

- verify explicit close empties active memory
- verify later lookup does not revive old token

Rounds:

1. store token
2. explicit close / clear memory
3. ask for old token, expect unknown

Observed outputs:

- round 1: `STORED`
- round 2: `CLOSED`
- round 3: `UNKNOWN`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null]`
- `pieceCounts`: `[1, 0, 2]`
- `groupCounts`: `[1, 0, 1]`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- round 2 truly zeroed active state
- round 3 started a new minimal state around the `UNKNOWN` answer, which is acceptable

## Test 4: Multi-Value Exact Recall Without Recall Tool

Goal:

- verify multiple exact literals survive a short distraction

Rounds:

1. store `alpha`, `beta`, `gamma`
2. distraction
3. ask for all three as exact JSON

Observed outputs:

- round 1: `BOTH-STORED`
- round 2: `DISTRACT`
- round 3: `{"alpha":"ALPHA-04-7319","beta":"BETA-04-4826","gamma":"GAMMA-04-9153"}`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null]`
- `pieceCounts`: `[1, 0, 1]`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- distraction round was fully pruned
- exact values still answered correctly

## Test 5: Large User Blob Exact Lookup

Goal:

- verify user-message chunking / retention works on a larger pasted blob
- verify exact lookup later succeeds

Rounds:

1. store a multi-line pseudo file with target line `LINE_13`
2. transient arithmetic distraction
3. ask for exact `LINE_13` value

Observed outputs:

- round 1: `FILE-STORED`
- round 2: `17`
- round 3: `VALUE-LINE-13-05-7319`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null]`
- `pieceCounts`: `[1, 1, 2]`
- `archiveRecallCount`: `0`
- `archiveRecallReturnedBytes`: `[0, 0, 0]`
- `structured_model_skipped`: `0`

Commentary:

- clean pass
- large pasted user content remained usable for exact lookup
- no fallback recall needed

## Test 6: Fully Transient 3-Round Session

Goal:

- verify obviously transient rounds leave active memory empty

Rounds:

1. `2 + 2`
2. `3 + 5`
3. `10 - 3`

Observed outputs:

- round 1: `4`
- round 2: `8`
- round 3: `7`

Observed state after each round:

- after round 1: `groupCount=0`, `pieceCount=0`
- after round 2: `groupCount=0`, `pieceCount=0`
- after round 3: `groupCount=0`, `pieceCount=0`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null]`
- `pieceCounts`: `[0, 0, 0]`
- `groupCounts`: `[0, 0, 0]`
- `archiveRecallCount`: `0`

Commentary:

- strong clean pass
- this is what the sieve should do for purely transient interaction

## Test 7: Close And Restart In Same Session

Goal:

- verify close + new-task restart keeps only new exact state

Rounds:

1. store token A
2. clear old token and start new task with token B
3. ask for current token

Observed outputs:

- round 1: `FIRST`
- round 2: `SECOND`
- round 3: `AMBER-MANUAL-07-4826`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null]`
- `pieceCounts`: `[1, 2, 3]`
- `groupCounts`: `[1, 1, 1]`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- old token stayed dead
- new token survived and answered correctly

## Test 8: Five-Round Retention Drift

Goal:

- verify transient one-turn answer instructions do not overwrite durable retained facts
- verify the same exact token survives across several distraction rounds

Rounds:

1. store exact token, expect `STEP-1`
2. transient answer instruction, expect `STEP-2`
3. transient answer instruction, expect `STEP-3`
4. transient answer instruction, expect `STEP-4`
5. ask for exact token

Observed outputs after fix:

- round 1: `STEP-1`
- round 2: `STEP-2`
- round 3: `STEP-3`
- round 4: `STEP-4`
- round 5: `BLUE-MANUAL-08-7319`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null, null, null]`
- `archiveRecallCount`: `0`

Commentary:

- first live run exposed a real bug: stale transient instructions like `reply STEP-4 only` were
  being treated as durable memory and overrode the real retained token
- fixed by tightening `group_intent`, `piece_retention_batch`, and `retained_piece_prune` prompts to
  drop one-turn control chatter and preserve durable evidence
- rerun passed cleanly

## Test 9: Six-Round Large Blob Lookup

Goal:

- verify an exact value inside a larger stored blob survives several later rounds

Rounds:

1. store pseudo file with `KEY_A`, `KEY_B`, `KEY_C`
2. transient arithmetic
3. transient arithmetic
4. transient arithmetic
5. transient arithmetic
6. ask for `KEY_B`

Observed outputs:

- round 1: `FILE-STORED`
- round 6: `BETA-09-4826`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null, null, null, null]`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- later transient rounds did not break exact lookup

## Test 10: Six-Round Replacement Chain

Goal:

- verify repeated exact-value replacement inside one ongoing thread does not corrupt group state

Rounds:

1. remember token A
2. replace with token B
3. replace with token C
4. hold
5. hold
6. ask for current token

Observed outputs after fix:

- round 1: `A1`
- round 2: `B2`
- round 3: `C3`
- round 4: `HOLD-4`
- round 5: `HOLD-5`
- round 6: `C-10-3333`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null, null, null, null]`
- `archiveRecallCount`: `0`
- active group id stayed stable as `group_1`

Commentary:

- first live run exposed a real bug: `group_intent` sometimes returned a contradictory replacement
  result, retiring a group id and also keeping it in `groupsAfter`
- that caused `memory_update_failed`, fail-closed state retention, and a wrong final answer
  (`B-10-2222`)
- fixed by steering within-thread value swaps toward “continue same group, supersede old piece”
  instead of “retire and recreate the group”
- rerun passed cleanly with no retry failure

## Test 11: Eight-Round Multi-Fact Retention

Goal:

- verify multiple exact facts remain answerable after several later rounds
- inspect whether archive recall is needed

Rounds:

1. remember `ALPHA11=red-111`
2. remember `BETA11=blue-222`
3. remember `GAMMA11=green-333`
4. remember `DELTA11=yellow-444`
5. remember `EPSILON11=purple-555`
6. transient round
7. transient round
8. ask for all five as exact JSON

Observed outputs:

- round 8:
  `{"ALPHA11":"red-111","BETA11":"blue-222","GAMMA11":"green-333","DELTA11":"yellow-444","EPSILON11":"purple-555"}`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null, null, null, null, null, null]`
- `archiveRecallCount`: `0`
- final `pieceCount`: `0`

Commentary:

- clean pass
- the manager progressively pruned older exact pieces while carrying the exact retained facts
  forward in the active group summary
- no archive recall was needed in this case

## Test 12: Nine-Round Seven-Fact Accumulation

Goal:

- verify a longer single-thread fact accumulation still answers exact values correctly

Observed outputs:

- rounds 1-8: expected short acknowledgements
- round 9: exact JSON for `A12` through `G12`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`
- final `pieceCount`: `2`

Commentary:

- clean pass
- no archive recall used
- the manager started pruning raw pieces while carrying exact facts in the active group summary

## Test 13: Twelve-Round Ten-Fact Accumulation

Goal:

- push the same single-thread fact pattern farther to see whether exact values drift

Observed outputs:

- round 12: exact JSON for `A13` through `J13`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`
- final `pieceCount`: `1`

Commentary:

- clean pass
- exact values remained correct across 12 rounds
- again, no recall usage; summaries carried most of the durable exact material

## Test 14: Twenty-Round Eighteen-Fact Stress Case

Goal:

- verify exact retention still works in a materially longer session
- check whether archive recall appears naturally

Observed outputs:

- rounds 1-19: expected short acknowledgements / hold
- round 20: exact JSON for `A20` through `R20`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`
- final `pieceCount`: `1`

Commentary:

- clean pass over 20 rounds
- no archive recall triggered
- the main thing visible in logs was increasing manager prompt size, not correctness failure

## Test 15: Multi-Blob Exact Lookup

Goal:

- verify multiple large remembered blocks can be queried later by exact field

Observed outputs:

- rounds 1-8: expected block acknowledgements / holds
- round 9:
  `{"B":"bravo15-222","H":"hotel15-888","N":"november15-1414","T":"tango15-2020","Z":"zulu15-2626","FF":"foxtrotfoxtrot15-3232"}`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`
- final `groupCount`: `6`

Commentary:

- clean pass
- six lookup blocks stayed separated as distinct groups
- no recall needed; exact values were recoverable from active group state

## Test 16: Overlapping Field Names Across Groups

Goal:

- verify similarly-shaped groups do not collapse into one latest-value memory

Observed outputs:

- exact per-round answers for red/blue/green values
- final round returned exact JSON with the correct red, blue, and green fields

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`
- final `groupCount`: `3`

Commentary:

- clean pass
- same field names like `STATUS` and `TOKEN` stayed correctly scoped per group

## Test 17: Selective Close With Other Groups Preserved

Goal:

- verify one group can be explicitly closed without damaging the others

Observed outputs:

- closed blue thread
- later red and green exact lookups were correct
- final round returned
  `{"red_token":"RED17-111","blue_token":"UNKNOWN","green_note":"green-note-17"}`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`

Commentary:

- memory behavior was correct
- one surface wording blemish remained on the immediate blue-lookup round: the model answered
  `I don’t know.` instead of the requested exact literal `UNKNOWN`
- that looks like main-model instruction following, not a memory-state corruption

## Test 18: Partial Supersession In One Config Thread

Goal:

- verify updating one field does not lose untouched fields

Observed outputs:

- exact later answers: `host18-a`, `1802`, `45s`
- final round returned `{"host":"host18-a","port":1802,"mode":"dev18","timeout":"45s"}`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- partial update semantics behaved correctly: old `PORT=1801` was replaced, while `HOST` and `MODE`
  survived

## Test 19: Dual Parallel Configs With Independent Updates

Goal:

- verify two evolving configs do not interfere with each other

Observed outputs:

- later exact answers: `1902` and `blue-key-19b`
- final round returned
  `{"red_host":"red-host-19","red_port":1902,"blue_host":"blue-host-19","blue_port":2901,"blue_key":"blue-key-19b"}`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- independent updates stayed scoped to the intended service

## Test 20: Interleaved Multi-Thread Retrievals

Goal:

- verify repeated thread switching does not corrupt current exact values

Observed outputs:

- exact intermediate answers for A, B, and C threads
- final round returned
  `{"a_token":"alpha-20x-v2","a_note":"a-note-20x","b_token":"bravo-20x","b_note":"b-note-20x","c_token":"charlie-20x","c_note":"c-note-20x"}`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- after `THREAD_A` was updated, later retrievals consistently returned the v2 token rather than the
  old one

## Test 21: Reopen Same Label After Close

Goal:

- verify closing a thread and starting it again with the same label does not resurrect the old exact
  value

Observed outputs:

- later exact answer for `TASK_ALPHA` was `alpha-new-21`
- later exact answer for `TASK_BETA` note was `beta-note-21`
- final round returned
  `{"alpha_token":"alpha-new-21","alpha_note":"new-note-21","beta_token":"beta-21","beta_note":"beta-note-21"}`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`

Commentary:

- clean pass
- the reopened alpha thread used the new value only; the old closed alpha value did not leak back

## Test 22: Verbatim Old Block Without Recall

Goal:

- verify a simpler old verbatim block can still be reproduced exactly after later rounds

Observed outputs:

- final round returned: `BLOCK22-A` `{` `header: "alpha-23",` `items: [` `"first",` `"second",`
  `"third"` `],` `` `note: "two  spaces  inside",` `marker: "[keep]{exact}(23)!"` `}`

Observed stats:

- `memoryUpdateErrors`: all `null`
- `archiveRecallCount`: `0`
- final `pieceCount`: `1`

Commentary:

- clean pass
- this one succeeded directly from active memory without archive recall

## Test 23: Byte-Sensitive Weird Block Reproduction

Goal:

- verify formatting-sensitive raw block reproduction works after later rounds
- specifically exercise archive recall and exact block chunking

Observed outputs after fix:

- final round returned the exact original `BLOCK23-A` text, including the label line, braces,
  indentation, punctuation, and double spaces

Observed stats:

- `memoryUpdateErrors`: all `null`
- total `archiveRecallCount`: `1`
- `archiveRecallReturnedBytes`: `[1503]`

Commentary:

- first live run exposed a real bug: the manager/archive path let the model reconstruct a lossy
  version of the block from summary text
- first fix made the model call `recall`, but the recalled source was still the whole wrapper
  message, so the answer still omitted the `BLOCK23-A` label line
- final fix tightened chunking so wrapper instructions are split away from clearly delimited exact
  blocks, and tightened retention/prompt guidance for formatting-sensitive raw sources
- rerun passed cleanly with one archive recall

## Test 24: Two Older Verbatim Blocks In JSON

Goal:

- verify the model can return two older exact blocks in one structured answer

Observed outputs:

- final round returned exact JSON with:
  - `block_a` = full original `BLOCK24-A`
  - `block_b` = full original `BLOCK24-B`

Observed stats:

- `memoryUpdateErrors`: all `null`
- total `archiveRecallCount`: `1`
- `archiveRecallReturnedBytes`: `[1738]`

Commentary:

- clean pass
- archive recall was used once and returned enough coverage for both requested exact blocks

## Test 25: Close And Reopen Formatting-Sensitive Block

Goal:

- verify a closed block stays dead after reopening the same label with a new exact block

Observed outputs:

- later exact answer for current `ALPHA25` block was: `ALPHA25`
  `{ old: false, token: "alpha-new-25" }`
- later exact answer for `BETA25` block was: `BETA25` `<beta token="beta-25">` `keep` `</beta>`

Observed stats:

- `memoryUpdateErrors`: all `null` on the clean rerun
- `archiveRecallCount`: `0`

Commentary:

- the first run of this scenario hit a transient upstream `503` during post-response memory
  finalization, so it was rerun from scratch
- the rerun was clean
- old closed alpha content did not leak back; only the reopened alpha block survived

## Test 26: Older Exact Snippets In Final JSON

Goal:

- verify the model can return older exact snippets inside a compact final JSON object
- specifically check that it does not collapse exact snippets down to only their inner values

Observed outputs after fix:

- final round returned exact JSON with:
  - `snippet_a` = full original `SNIP26-A`
  - `snippet_c` = full original `SNIP26-C`

Observed stats:

- `memoryUpdateErrors`: all `null`
- total `archiveRecallCount`: `1`
- `archiveRecallReturnedBytes`: `[3070]`

Commentary:

- first live run exposed a real bug: the model returned only `alpha-26` / `charlie-26` instead of
  the full original snippets
- active memory only contained summary information, but the model still did not call `recall`
- fixed by making the prompt memory text and the `recall` tool description more explicit: if the
  user asks for exact original raw text and that raw text is not visibly present in
  `<exact_pieces>`, the model must use `recall`
- rerun passed cleanly with one archive recall

## Summary So Far

Completed manual live runs recorded here: `26`

Overall:

- four real memory-manager / active-memory-path bugs were found and fixed during the manual sweep:
  - stale transient answer instructions were being retained as durable memory
  - repeated within-thread value replacement could produce contradictory `group_intent` replacement
    output
- formatting-sensitive raw blocks could be reconstructed lossily from summaries instead of
  preserved/recalled exactly
- the model could skip `recall` and answer exact-original-snippet requests from summaries, yielding
  only inner values instead of the requested raw snippets
- all recorded post-fix reruns are clean
- no non-null `round_complete.memoryUpdateError` remains in the recorded passing runs
- archive recall is now exercised in the recorded suite and works in passing runs
- the current design still relies heavily on active group summaries carrying exact values after many
  raw pieces are pruned

Notes:

- two early ad hoc harness attempts failed before the product was exercised:
  - wrong temp-script import path
  - shell interpolation corrupting temp-script source
- those were harness mistakes, not proxy bugs
