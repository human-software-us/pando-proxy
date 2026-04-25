# Live E2E Results: Span-Based Lossless Chunking

Validation policy for this batch:
- live backend only
- actual tokens/auth
- no unit tests
- manual one-by-one sessions with log/state inspection after each run

Fixes made during this batch:
- persisted pieces were incorrectly saving transient draft `content`; fixed by storing selector metadata only
- prune only operated on old pieces, so transient current-turn output-shape requests could survive; fixed by widening the prune pass to all currently kept pieces
- chunker instructions were tightened for delimited blocks, JSON-shaped output requests, and binary-like/base64/hex-like content

## Test 1: Fake Poem Block
- Rounds: `3`
- Session: `live-test1-poem`
- Final answer:
  - exact poem body with original stanza breaks
- Checks:
  - `memoryUpdateError = null` on every round
  - final round used `archiveRecallCount = 1`
  - final persisted memory was selector-only and contained no copied transient draft payload
- Notes:
  - active memory ended on the exact returned poem answer, which is acceptable under the sieve model

## Test 2: Fake Exact Snippets JSON
- Rounds: `4`
- Session: `live-test2-snips-rerun3`
- Final answer:
  - `{"a":"alpha line 1\nalpha line 2","c":"charlie line 1\ncharlie line 2"}`
- Checks:
  - `memoryUpdateError = null` on every round
  - final round used `archiveRecallCount = 1`
  - per-field verbatim checker passed for fields `a` and `c`
  - final persisted memory dropped the transient JSON-shape request and retained only the exact answer
- Bug found and fixed:
  - before the prune widening, the manager retained the current-turn JSON wrapper request as durable memory

## Test 3: Realistic JSON Configs
- Rounds: `7`
- Session: `live-test3-json-configs-rerun`
- Final answer:
  - `{"alpha_token":"ALPHA-7741","beta_port":9443,"beta_flag_1":"sync"}`
- Checks:
  - `memoryUpdateError = null` on every round
  - no live runtime failures
  - one of the rounds previously exposed the same transient-output-shape retention bug; the rerun after prompt/prune fixes completed cleanly
- Notes:
  - this was the 6+ round realistic session for the batch

## Test 4: Realistic Binary-Like Executable Manifest
- Rounds: `5`
- Session: `live-test4-binary-manifest`
- Final answers:
  - round 3: `{"sha256":"8b7f4d3a9c1188aa77bbccddeeff00112233445566778899aabbccddeeff1020","entry_hex":"4d5a90000300000004000000ffff0000"}`
  - round 5: `TVqQAAMAAAAEAAAA//8A`
- Checks:
  - `memoryUpdateError = null` on every round
  - `archiveRecallCount = 0` on every round
  - local verbatim checker passed for:
    - `sha256`
    - `entry_hex`
    - `base64Prefix`
- Notes:
  - this specifically exercised binary-like/base64/hex-like content handling

## Test 5: Realistic Photo Metadata
- Rounds: `4`
- Session: `live-test5-photo-meta`
- Final answers:
  - round 3: `{"file":"receipt.jpg","mime":"image/jpeg","ocr":"TOTAL 84.73","thumb":"/9j/4AAQSkZJRgABAQAAAQABAAD"}`
  - round 4: `iPhone15,2`
- Checks:
  - `memoryUpdateError = null` on every round
  - round 3 used `archiveRecallCount = 1`
  - local verbatim checker passed for:
    - `receipt.jpg`
    - `image/jpeg`
    - `TOTAL 84.73`
    - `/9j/4AAQSkZJRgABAQAAAQABAAD`
    - `iPhone15,2`
- Notes:
  - this exercised photo/image-style metadata plus base64-like thumbnail data
