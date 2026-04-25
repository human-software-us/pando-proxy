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

- first live run exposed a real bug: stale transient instructions like `reply STEP-4 only` were being treated as durable memory and overrode the real retained token
- fixed by tightening `group_intent`, `piece_retention_batch`, and `retained_piece_prune` prompts to drop one-turn control chatter and preserve durable evidence
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

- first live run exposed a real bug: `group_intent` sometimes returned a contradictory replacement result, retiring a group id and also keeping it in `groupsAfter`
- that caused `memory_update_failed`, fail-closed state retention, and a wrong final answer (`B-10-2222`)
- fixed by steering within-thread value swaps toward “continue same group, supersede old piece” instead of “retire and recreate the group”
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

- round 8: `{"ALPHA11":"red-111","BETA11":"blue-222","GAMMA11":"green-333","DELTA11":"yellow-444","EPSILON11":"purple-555"}`

Observed stats:

- `memoryUpdateErrors`: `[null, null, null, null, null, null, null, null]`
- `archiveRecallCount`: `0`
- final `pieceCount`: `0`

Commentary:

- clean pass
- the manager progressively pruned older exact pieces while carrying the exact retained facts forward in the active group summary
- no archive recall was needed in this case

## Summary So Far

Completed manual live runs recorded here: `11`

Overall:

- two real memory-manager bugs were found and fixed during the manual sweep:
  - stale transient answer instructions were being retained as durable memory
  - repeated within-thread value replacement could produce contradictory `group_intent` replacement output
- all recorded post-fix reruns are clean
- no non-null `round_complete.memoryUpdateError` remains in the recorded passing runs
- archive recall still was not needed in these eleven recorded runs

Notes:

- two early ad hoc harness attempts failed before the product was exercised:
  - wrong temp-script import path
  - shell interpolation corrupting temp-script source
- those were harness mistakes, not proxy bugs
