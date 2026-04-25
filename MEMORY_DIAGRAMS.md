# Memory Diagrams

These diagrams describe the current shipped design.

## 1. End-of-round sieve

```text
new round sources
    |
    +--> source_chunk_batch
    |      - user / assistant / tool sources
    |      - Pando tool outputs may still split deterministically
    |
    +--> materialize exact new pieces
    |
    +--> group_intent
    |      - decide active/closed/replaced groups
    |
    +--> piece_retention_batch
    |      - keep/drop new pieces
    |      - assign group ids
    |      - mark superseded old pieces
    |
    +--> retained_piece_prune
           - prune obsolete old kept pieces
           - preview/anchor based, not full old payload based
    |
    +--> persist surviving exact pieces
           - stored pieces == next prompt pieces
```

## 2. Request path

```text
incoming request
    |
    +--> load state
    +--> materialize active piece payloads for prompt rendering
    +--> inject <pando_group_memory>
    +--> inject recall tool only if archived sources exist outside active memory
    +--> forward upstream
    +--> if model calls recall:
            - resolve archive sources locally
            - return exact archive payloads
            - cap at 3 recall calls in that round
    +--> finalize memory after response
```

## 3. Active memory vs archive

```text
ACTIVE MEMORY
  - groups
  - exact surviving pieces
  - always shown next round

ARCHIVE
  - raw original sources on disk
  - not shown normally
  - reachable only through recall({offset,limit})
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

- one active memory tier only
- no projection layer
- no hidden omitted-piece set
- active stored pieces == active prompt pieces
- archive is separate from active memory
- semantic decisions come from structured manager calls, not local heuristics
