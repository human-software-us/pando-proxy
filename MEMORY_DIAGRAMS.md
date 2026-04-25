# Memory Manager Diagrams

Diagrams for the **target** groups-based design (per `CONTEXT_MEMORY_DESIGN.md`,
`DESIGN_PRINCIPLES.md`, `MEMORY_OPERATIONS.md`, `ACTIVE_MEMORY_REDESIGN_PLAN.md`).
Implementation may not be fully aligned yet.

The word *agent* below = the Codex/main model. *Manager* = the small structured-output
LLM that the proxy calls for semantic decisions. *Local* = deterministic proxy code,
no LLM.

---

## 1. Pipeline by content type — input → extract → chunk → classify → store

What goes through which stage, and *why*. The split between manager and local is the
load-bearing distinction: any semantic verdict comes from a manager call.

```
                         END-OF-ROUND PIPELINE
                         =====================

  ┌────────────────────────────────────────────────────────────────────┐
  │                          NEW ROUND SOURCES                         │
  │                  (skip ids in processedSourceIds)                  │
  └────────────────────────────────────────────────────────────────────┘
       │                          │                              │
       │ user msg                 │ assistant msg                │ tool output
       │ (intent / instruction)   │ (model reasoning, output)    │ (often huge)
       ▼                          ▼                              ▼
  ┌─────────────┐          ┌─────────────────────────────────────────────┐
  │  no chunk   │          │           source_chunk_batch                │
  │  (whole)    │          │       MANAGER LLM call, batched             │
  │             │          │  in: all new assistant + tool sources       │
  │ user text   │          │ out: [{sourceId, selectors[]}]              │
  │ is small    │          │ selector ∈ {whole | line_range | object_path}
  │ and is the  │          │ structural fallback: malformed → whole      │
  │ control     │          └─────────────────────────────────────────────┘
  │ signal for  │                              │
  │ groups      │                              ▼
  └─────────────┘             ┌─────────────────────────────┐
       │                      │ materialize exact pieces    │
       │                      │ (LOCAL, deterministic)      │
       │                      │ apply selectors to original │
       │                      │ payload, spill big payloads │
       │                      │ to payloadRef               │
       │                      └─────────────────────────────┘
       │                                      │
       ▼                                      ▼
  ┌──────────────────────┐       ┌───────────────────────────┐
  │   group_intent       │       │     new MemoryPieces      │
  │   MANAGER LLM call   │       │  (assistant + tool)       │
  │                      │       └───────────────────────────┘
  │ in : existing groups │                  │
  │      + new user      │                  │
  │      piece previews  │                  │
  │ out: groupsAfter,    │                  │
  │      closedGroupIds, │                  │
  │      replacedGroupIds│                  │
  │                      │                  │
  │ runs in parallel     │                  │
  │ with source_chunk    │                  │
  └──────────────────────┘                  │
              │                             │
              └──────────────┬──────────────┘
                             ▼
              ┌───────────────────────────────┐
              │   piece_retention_batch       │
              │      MANAGER LLM call         │
              │ in : groupsAfter,             │
              │      all new pieces,          │
              │      bounded anchor previews  │
              │      from existing kept       │
              │      pieces by group          │
              │ out: per-piece                │
              │      { keep, groupId,         │
              │        supersedesPieceIds,    │
              │        visibility }           │
              └───────────────────────────────┘
                             │
                             ▼
              ┌───────────────────────────────┐
              │ apply decisions (LOCAL)       │
              │ - drop pieces in              │
              │   closed/replaced groups      │
              │ - drop superseded pieces      │
              │ - keep new pieces keep=true   │
              │ - assign groupId verbatim     │
              └───────────────────────────────┘
                             │
                             ▼
              ┌───────────────────────────────┐
              │     prompt_projection         │
              │      MANAGER LLM call         │
              │ in : active groups,           │
              │      retained piece previews, │
              │      maxInlinePieces          │
              │ out: inlinePieceIds           │
              └───────────────────────────────┘
                             │
                             ▼
              ┌───────────────────────────────┐
              │ persist (LOCAL)               │
              │ groups, pieces,               │
              │ inlinePieceIds,               │
              │ processedSourceIds            │
              └───────────────────────────────┘
```

### Per content type — when, why, how

| Content type | When extracted | Chunked? | Why | Classified by | Stored as |
|---|---|---|---|---|---|
| **User message** | end of round | no — `whole` | it's the intent that drives group lifecycle; small | `group_intent` (lifecycle) + `piece_retention_batch` (keep/drop, group, visibility) | `MemoryPiece` with `sourceKind=user`, `selector={kind:'whole'}` |
| **Assistant message** | end of round | yes — manager picks selectors | reasoning may carry exact facts to retain (e.g. a token, a path); rest is noise | `source_chunk_batch` (selectors) → `piece_retention_batch` | one `MemoryPiece` per selector, `sourceKind=assistant` |
| **Tool output** | end of round | yes — usually `line_range` or `object_path` | raw outputs blow up the prompt; only specific lines/fields are evidence | `source_chunk_batch` → `piece_retention_batch` | one `MemoryPiece` per selector, `sourceKind=tool`, large payloads → `payloadRef` |
| **Already-processed source** | n/a | n/a | skipped via `processedSourceIds` | n/a | n/a |

Reasoning split, restated:

- **Local code**: persistence, materializing chunks from selectors, payload spill,
  paging `context_get`, applying manager outputs, structural fallbacks (malformed →
  `whole`).
- **Manager LLM**: every semantic verdict — group lifecycle, chunk selectors,
  keep/drop, supersession, visibility, inline projection.

---

## 2. Flowchart — the round, end to end

This is the request lifecycle as a control-flow chart. Diamond = decision; rectangle
= step; double border = LLM call; dashed = local fallback path.

```
                          ┌──────────────────────────────┐
                          │ POST /v1/responses arrives   │
                          └───────────────┬──────────────┘
                                          ▼
                        ┌────────────────────────────────────┐
                        │ load state for sessionKey          │
                        │  groups, pieces, inlinePieceIds,   │
                        │  processedSourceIds                │
                        └───────────────┬────────────────────┘
                                        ▼
                        ┌────────────────────────────────────┐
                        │ rewrite request (LOCAL)            │
                        │  keep: leading instructions,       │
                        │        current-round tail          │
                        │  insert: <pando_group_memory>      │
                        │          with active groups +      │
                        │          inline pieces (chosen     │
                        │          last round by manager)    │
                        └───────────────┬────────────────────┘
                                        ▼
                        ┌────────────────────────────────────┐
                        │ omitted retained pieces exist?     │
                        └─────┬───────────────────────┬──────┘
                              │ yes                   │ no
                              ▼                       ▼
                  ┌──────────────────────┐   (skip context_get tool)
                  │ inject context_get   │
                  │ tool definition      │
                  └──────────────────────┘
                              │
                              ▼
                        ┌────────────────────────────────────┐
                        │ run upstream loop                  │
                        └────────────┬───────────────────────┘
                                     ▼
                        ┌────────────────────────────────────┐
                        │ assistant emits context_get(...)?  │
                        └─────┬─────────────────────────┬────┘
                              │ yes                     │ no
                              ▼                         │
                ┌─────────────────────────────┐         │
                │ LOCAL fetch (no LLM)        │         │
                │  - by pieceIds: lookup      │         │
                │  - by offset/limit:         │         │
                │    chronological page of    │         │
                │    omitted retained pieces  │         │
                │  - skip pieces already in   │         │
                │    prompt or already        │         │
                │    returned this round      │         │
                └──────────────┬──────────────┘         │
                               │                        │
                               └──────────┬─────────────┘
                                          ▼
                               (loop continues until done)
                                          │
                                          ▼
                        ┌────────────────────────────────────┐
                        │ collect new round sources          │
                        │  user / assistant / tool           │
                        │  minus processedSourceIds          │
                        └────────────┬───────────────────────┘
                                     ▼
                       ┌─────────────────────────────────────┐
                       │       END-OF-ROUND PIPELINE         │
                       │  see §1 — group_intent ‖            │
                       │  source_chunk_batch →               │
                       │  piece_retention_batch →            │
                       │  prompt_projection                  │
                       └─────────────┬───────────────────────┘
                                     ▼
                        ┌────────────────────────────────────┐
                        │ any manager call invalid twice?    │
                        └─────┬────────────────────────┬─────┘
                              │ yes                    │ no
                              ▼                        ▼
                  ┌──────────────────────┐  ┌────────────────────────┐
                  │ KEEP PRIOR MEMORY    │  │ persist new state      │
                  │ log failed call+why  │  │ groups, pieces,        │
                  │ no semantic fallback │  │ inlinePieceIds,        │
                  │                      │  │ processedSourceIds     │
                  └──────────────────────┘  └────────────────────────┘
                                     │
                                     ▼
                        ┌────────────────────────────────────┐
                        │ return upstream response to caller │
                        └────────────────────────────────────┘
```

---

## 3. Sequence diagram (the "request back-and-forth" one) — agent ↔ proxy ↔ manager ↔ upstream

You're thinking of a **sequence diagram** (sometimes "swimlane" if you draw the lanes
as parallel timelines). Time flows top to bottom; arrows are messages between
participants.

```
 Codex/agent       Proxy (local)        Manager LLM        Upstream model
 (main model)      (deterministic)      (small, struct.)   (big model)
      │                  │                   │                   │
      │ POST             │                   │                   │
      │ /v1/responses    │                   │                   │
      │─────────────────►│                   │                   │
      │                  │ load state        │                   │
      │                  │ (groups, pieces,  │                   │
      │                  │  inlineIds)       │                   │
      │                  │                   │                   │
      │                  │ rewrite request   │                   │
      │                  │ inject memory     │                   │
      │                  │ block + maybe     │                   │
      │                  │ context_get tool  │                   │
      │                  │                   │                   │
      │                  │ ───── upstream call (rewritten) ────► │
      │                  │                   │                   │ stream
      │                  │ ◄──── tool call: context_get(...) ─── │
      │                  │ LOCAL fetch       │                   │
      │                  │ exact pieces by   │                   │
      │                  │ id or page        │                   │
      │                  │ ───── tool result (exact payload) ──► │
      │                  │                   │                   │ continues
      │                  │ ◄──── final assistant response ────── │
      │ ◄─── response ───│                   │                   │
      │                  │                   │                   │
      │                  │  ─── END OF ROUND ───                 │
      │                  │ collect new sources                   │
      │                  │ (user/asst/tool)                      │
      │                  │                   │                   │
      │                  │ ── group_intent ─►│  (user previews)  │
      │                  │ ── source_chunk_batch ──► (asst+tool) │
      │                  │   (the two run in parallel)           │
      │                  │ ◄── groupsAfter, closedIds, replaced  │
      │                  │ ◄── chunk selectors per source        │
      │                  │                   │                   │
      │                  │ materialize       │                   │
      │                  │ exact pieces      │                   │
      │                  │ (apply selectors) │                   │
      │                  │                   │                   │
      │                  │ ── piece_retention_batch ──►          │
      │                  │ ◄── per-piece keep/group/             │
      │                  │     supersede/visibility              │
      │                  │                   │                   │
      │                  │ apply decisions   │                   │
      │                  │ (drop closed/     │                   │
      │                  │  replaced/        │                   │
      │                  │  superseded)      │                   │
      │                  │                   │                   │
      │                  │ ── prompt_projection ──►              │
      │                  │ ◄── inlinePieceIds                    │
      │                  │                   │                   │
      │                  │ persist state     │                   │
      │                  │                   │                   │
      │                  │ (next round will  │                   │
      │                  │  start with these │                   │
      │                  │  inlinePieceIds)  │                   │
```

Failure paths (not drawn) collapse the manager arrow into one retry, then "fail the
memory update, keep prior state, log it." There is no semantic local fallback.

---

## 4. Data-flow diagram — what state mutates and where

Boxes = stores. Arrows = data flow. Manager calls are pure functions (no state
mutation); only local code writes to the persisted store.

```
                     ┌─────────────────────────────────┐
                     │     PERSISTED MemoryState       │
                     │   (per session, on disk)        │
                     │                                 │
                     │  roundSeq                       │
                     │  groups  : MemoryGroup[]        │
                     │  pieces  : MemoryPiece[]        │
                     │  inlinePieceIds : string[]      │
                     │  processedSourceIds : string[]  │
                     └─────────────────────────────────┘
                       ▲                            │
                       │ write (LOCAL only)         │ read
                       │                            ▼
                  ┌──────────────────┐     ┌─────────────────────┐
                  │ apply decisions  │     │ rewrite request     │
                  │ (LOCAL)          │     │ (LOCAL)             │
                  └──────────────────┘     │ → adds              │
                       ▲                   │   <pando_group_     │
                       │ decisions         │    memory> with     │
                       │                   │   groups + inline   │
                  ┌──────────────────────┐ │   pieces +          │
                  │ piece_retention_batch│ │   context_get tool  │
                  │ MANAGER (pure)       │ └─────────────────────┘
                  │ in : pieces + groups │
                  │ out: per-piece verd. │
                  └──────────────────────┘
                       ▲
                       │ pieces
                       │
                  ┌──────────────────────┐         ┌─────────────────────┐
                  │ materialize pieces   │ ◄────── │  source_chunk_batch │
                  │ (LOCAL)              │selectors│  MANAGER (pure)     │
                  │ apply selectors;     │         │  in : asst+tool srcs│
                  │ inline small,        │         │  out: selectors[]   │
                  │ payloadRef large     │         └─────────────────────┘
                  └──────────────────────┘
                       ▲
                       │ raw sources
                       │
                  ┌──────────────────────┐
                  │ collect round sources│
                  │ (LOCAL)              │  ─── new user previews ───►  group_intent (MANAGER, pure)
                  │ user / asst / tool   │  ◄── groupsAfter, closed, replaced ───
                  └──────────────────────┘

                  ┌──────────────────────┐
                  │ prompt_projection    │  reads: groups + retained piece previews
                  │ MANAGER (pure)       │  writes (via local apply): inlinePieceIds
                  │ out: inlinePieceIds  │
                  └──────────────────────┘
```

Key invariants the data-flow enforces:

1. The agent never sees a summary — only exact pieces.
2. The persisted store only changes through *local* code; the manager produces
   verdicts, local code is the one that mutates state.
3. `processedSourceIds` makes the pipeline idempotent across rounds (skip what was
   already chunked/classified).
4. `inlinePieceIds` is decided **at end of round N** and consumed **at start of round
   N+1** during rewrite — that's why prompt projection is the last manager call.

---

## 5. State machine — group lifecycle

Groups are the control plane. Their transitions are decided exclusively by
`group_intent`.

```
                ┌──────────────────────────┐
                │     (no group yet)       │
                └────────────┬─────────────┘
                             │ group_intent: start new
                             ▼
        ┌───────────────────────────────────────────┐
        │                  ACTIVE                   │◄──── group_intent: continue
        │  routingLabel, summary, lastTouchedSeq    │      group_intent: redirect
        └─┬──────────────┬─────────────────────┬────┘      (relabel/resummarize)
          │              │                     │
          │ closed       │ replaced            │
          │ (group_intent)│ (group_intent)     │
          ▼              ▼                     │
   ┌───────────┐   ┌────────────────┐          │
   │  CLOSED   │   │   REPLACED     │          │
   │           │   │  (by new id)   │          │
   └───────────┘   └────────────────┘          │
        │                  │                   │
        └──────────┬───────┘                   │
                   ▼                           │
        ┌──────────────────────────────┐       │
        │ LOCAL: drop all pieces       │       │
        │ assigned to closed/replaced  │       │
        │ groups                       │       │
        └──────────────────────────────┘       │
                                               │
                  pieces remain through        │
                  piece_retention_batch        │
                  (per-piece keep/drop,        │
                  supersession, visibility)    ◄┘
```

Pieces have a parallel, simpler lifecycle: created by materialization, then per
round either kept, dropped, superseded, or marked `inline`/`omittable` — all by
manager verdict.

---

## Cheat sheet: the four manager calls

| Call | Runs when | Input | Output | Decides |
|---|---|---|---|---|
| `group_intent` | end of round, parallel with `source_chunk_batch` | existing groups + new user-piece previews | `groupsAfter`, `closedGroupIds`, `replacedGroupIds` | group lifecycle |
| `source_chunk_batch` | end of round, parallel with `group_intent` | all new assistant/tool sources | `[{sourceId, selectors[]}]` | chunk shape (whole / line_range / object_path) |
| `piece_retention_batch` | after pieces materialized | `groupsAfter` + new pieces + anchor previews | per-piece `{keep, groupId, supersedesPieceIds, visibility}` | keep/drop, group assignment, supersession |
| `prompt_projection` | last, on retained set | active groups + retained piece previews + `maxInlinePieces` | `inlinePieceIds` | which pieces are inline next round |

All four are strict-schema, one-shot, retry-once, fail-closed (keep prior memory) on
second invalid response.
