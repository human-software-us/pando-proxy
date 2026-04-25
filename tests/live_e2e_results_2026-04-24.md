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

## Summary So Far

Completed manual live runs recorded here: `7`

Overall:

- no proxy runtime failures
- no `memory_update_failed`
- no non-null `round_complete.memoryUpdateError`
- no archive recall was needed in these seven short scenarios
- no immediate product bug found in these completed runs

Notes:

- two early ad hoc harness attempts failed before the product was exercised:
  - wrong temp-script import path
  - shell interpolation corrupting temp-script source
- those were harness mistakes, not proxy bugs
