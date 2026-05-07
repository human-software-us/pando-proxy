# Memory Diagrams

These diagrams describe the current shipped design.

## 1. End-of-round sieve

```text
new round sources
    |
    +--> source_chunk_batch
    |      - assistant talk+reasoning / tool-result sources
    |      - returns verbatim chunks whose joined text exactly equals the source
    |      - user messages are one whole piece per message
    |      - failed, malformed, omitted, or oversized sources are kept whole
    |      - tool calls are whole-piece structural sources
    |
    +--> task_route
    |      - same_task, new_task, or revive_task(-N)
    |      - sees active task title, full active pieces, full new user messages
    |      - sees at most five archived task titles per newest-first page
    |
    +--> materialize exact new pieces
    |
    +--> deterministic filters
    |      - same-task duplicate content hashes become duplicate source markers before prune
    |      - on new_task, old/new duplicates wait until after prune so old chunks can be rescued
    |
    +--> piece_drop_batch over full-payload batches
    |      - batch includes shared user context + manifest + evaluated payloads
    |      - drop only with accepted concrete reason
    |      - malformed, oversized, missing, or uncertain means keep
    |      - non-structural drops cannot collapse non-assistant evidence to assistant-only output
    |
    +--> post-prune duplicate collapse
    |      - exact duplicate survivors become duplicate source markers
    |      - new_task old/new duplicates prefer the new piece as canonical
    |
    +--> persist activeTask + surviving exact pieces
           - stored pieces == next prompt pieces
```

## 2. Request path

```text
incoming request
    |
    +--> load state
    +--> materialize active piece payloads for prompt rendering
    +--> inject <pando_task_memory>
    +--> inject recall tool only if archived sources exist outside active memory
    +--> forward upstream
    +--> if model calls recall:
            - resolve archive sources locally
            - return exact archive payloads
            - allow any requested per-call item count
            - cap at 3 recall calls in that round
    +--> finalize memory after response
```

## 2a. Request/response sequence

```text
Codex client          pando-proxy                       Upstream (Responses)
     |                     |                                     |
     |---- Responses ----->|                                     |
     |                     | load session state                  |
     |                     | materialize active pieces           |
     |                     | inject <pando_task_memory> block    |
     |                     |---- rewritten Responses ----------->|
     |                     |<--- SSE stream ---------------------|
     |                     | tee SSE to client; observe sources  |
     |<-- SSE stream ------|                                     |
     |                     |                                     |
     |       (model may call recall mid-stream)                  |
     |                     | resolve archived sources locally    |
     |                     |                                     |
     | end of round:       |                                     |
     |                     | source_chunk_batch + task_route     |
     |                     |       (in parallel)                 |
     |                     | apply route, build candidates       |
     |                     | piece_drop_batch (one or more)      |
     |                     | apply sanity guard, collapse dups   |
     |                     | persist active state + archive raw  |
```

## 3. Active memory vs archive

```text
ACTIVE MEMORY
  - one activeTask
  - exact surviving pieces
  - duplicate source markers on canonical duplicate content, rendered at the duplicate's timeline spot
  - always shown next round

ARCHIVE
  - raw original sources on disk
  - not shown normally
  - reachable only through recall({offset,limit})
  - no per-call item cap
  - recovery only, not a second active-memory tier
```

## 3a. Prune batch sizing

```text
small structured window  --|                              |-- overflow structured window
                           |                              |
                           v                              v
  0 ============================================================================
                  ^                            ^
                  |                            |
       pruneBatchTokenLimit         pruneSingleBatchTokenLimit
       = floor((small - reserve)    = overflow - reserve
                * 0.70)             (reserve = OUTPUT_TOKEN_RESERVE = 4_096)

 multi-piece batches ---------|
 packed under 70% of small    |
                              v
 single-piece batches ---------------------------------|
 a piece that exceeds tokenLimit but fits              |
 singleBatchTokenLimit is flushed and sent alone       v
 (chooseStructuredModel routes it to overflow model)

 single piece that does not fit singleBatchTokenLimit ---> kept unevaluated
 (entire batch including shared header + manifest must fit)
```

## 4. Recall path

```text
assistant decides exact older material is missing
    |
    +--> recall({offset, limit})
    |
    +--> proxy resolves archived source ids not currently active
    |
    +--> proxy returns:
           - source: archive
           - requestedOffset
           - requestedLimit
           - returnedCount
           - remainingArchivedSourceCount
           - exact archived source payloads
```

## 5. Key invariants

- one active task only
- no groups
- no projection layer
- no hidden omitted-piece set
- no summaries as source material
- active stored pieces == active prompt pieces
- archive is separate from active memory
- semantic dropping requires full payload and concrete reason
- semantic dropping also passes the assistant-only-collapse sanity guard
