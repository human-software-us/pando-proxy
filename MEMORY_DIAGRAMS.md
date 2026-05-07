# Memory Diagrams

These diagrams describe the current shipped design.

## 1. End-of-round sieve

```text
new round sources
    |
    +--> source_chunk_batch
    |      - user / assistant talk+reasoning / tool-result sources
    |      - returns exact selectors only
    |      - failed, malformed, omitted, or oversized sources are kept whole
    |      - tool calls are whole-piece structural sources
    |
    +--> task_route
    |      - same_task, new_task, or revive_task(-N)
    |      - no groups, statuses, or durable taxonomy
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
