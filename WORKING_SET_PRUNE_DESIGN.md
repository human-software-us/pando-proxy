# Working Set Prune Design

## Goal

Keep the prompt context clean without making irreversible memory-loss decisions.

The proxy should aggressively remove material from active prompt memory only when that material no
longer belongs to the current working set. Removal is not deletion: raw sources remain in the
lossless archive, and prior task bundles can be revived by relative index.

The preferred failure mode is:

```text
keep too much active context
```

not:

```text
drop data the current task still needs
```

In classification terms:

```text
false positive = keep useless data      acceptable
false negative = drop needed data       unacceptable
```

## Philosophy

There are no groups, summaries, durable taxonomy labels, permanent protection tags, or forever-kept
categories.

Active memory is just:

```text
one active task
+ exact pieces that currently belong to that task
+ duplicate source markers when the same exact content appears elsewhere
```

The archive is the long-term store:

```text
raw round sources
+ exact selectors in active/archived task bundles
```

Every active piece can be pruned in a later round, including user instructions, exact values, tool
calls, tool results, errors, code, and assistant output. The only question is:

```text
Does this exact piece still belong in the active working set for the current task?
```

If yes or uncertain, keep it. If clearly no, remove it from active prompt memory.

## State

```ts
type ActiveTask = {
  id: string;
  pieceIds: string[];
  startedRound: number;
  lastRound: number;
};

type ArchivedTaskBundle = {
  id: string;
  pieces: MemoryPiece[];
  startedRound: number;
  archivedRound: number;
};

type MemoryState = {
  roundSeq: number;
  activeTask: ActiveTask | null;
  archivedTasks: ArchivedTaskBundle[];
  pieces: MemoryPiece[]; // active pieces only
  processedSourceIds: string[];
};
```

`archivedTasks` is ordered oldest to newest. Relative indexes are negative:

```text
-1 = most recent previous task
-2 = task before that
-3 = three tasks back
```

## Round Sequence

```text
1. collect new sources
2. materialize prior active/task-bundle pieces from archive for prune context
3. chunk new sources into exact pieces
4. route task
5. build candidate active set
6. prune candidate set in full-payload batches
7. archive raw new sources
8. persist active task, archived task bundles, and retained active pieces
```

`source_chunk_batch` and `task_route` can run in parallel because task routing does not require
chunk output.

## Task Route

The route call returns only a control decision:

```ts
type TaskRoute =
  | { kind: "same_task" }
  | { kind: "new_task" }
  | { kind: "revive_task"; relativeIndex: number };
```

No title, summary, objective, or durable label is created.

Route behavior:

```text
same_task:
  candidate set = old active pieces + new pieces

new_task:
  active task bundle -> archivedTasks
  create a fresh active task identity
  candidate set = old active pieces + new pieces
  old pieces that survive pruning are copied/rescued into the new active task

revive_task(-N):
  current active task bundle -> archivedTasks
  selected archived task bundle -> active
  candidate set = revived pieces + new pieces
```

If the route call fails or is uncertain, use `same_task`.

If `revive_task(-N)` points at no archived task, keep the current active task with `same_task`
instead of starting a new task.

Important distinction:

```text
task identity != piece membership
```

On `new_task`, the old task identity is never kept active. The old task is archived first. Old exact
pieces may still survive pruning and become active pieces of the fresh task if they still belong to
the new working set. The same immutable exact piece can therefore appear both in an archived task
bundle and in the current active task.

If prune fails after a confirmed `new_task`, the old task identity still stays archived. The
fail-closed behavior is only that old pieces remain active as candidates under the new task.

## Full-Payload Prune Batches

`piece_drop_batch` sees full payloads, not cards, for the pieces it is allowed to decide on.

Each batch includes shared context and counts that context against the batch budget:

```text
- activeTask
- taskRoute
- latest user pieces, full payload
- selected active user pieces, full payload
- candidate manifest for all candidate pieces
- local supersession hints
- evaluatedPieces, full payload
```

The candidate manifest includes every candidate piece id, source kind, tool name, creation order,
primary key, duplicate source markers, byte size, and whether the full payload is included in this
batch.

Hard rule:

```text
A prune batch may only drop pieces listed in evaluatedPieces.
```

Manifest-only pieces are never dropped by that batch.

After all prune batches return, the runtime applies one local sanity check:

```text
if candidates included non-assistant evidence
and accepted LLM drops would leave zero pieces or assistant-only pieces
then keep the non-structurally dropped pieces
```

Structural drops are still allowed: exact duplicates, primary-key supersession, explicit user
invalidation, confirmed old-task pieces after a task switch, and empty/invalid pieces. This prevents
the active working set from collapsing into a final assistant answer or chatter while still allowing
real task turnover.

## Batch Sizing

Each prune batch is bounded to about 70% of the small structured model context window.

Sizing algorithm:

```ts
tokenLimit = floor((smallStructuredContextWindow - outputReserve) * 0.70)

sharedHeader = route
  + latest user full payloads
  + as many active user full payloads as fit
  + full candidate manifest
  + supersession hints

payloadBudget = tokenLimit - estimate(sharedHeader)

for candidate in chronological order:
  if candidate has no materialized full payload:
    keep
  else if candidate plus sharedHeader cannot fit:
    keep
  else add to current batch

if not all active user pieces fit in the shared header:
  only evaluate user pieces whose full payload is included
  keep non-user pieces because they may depend on omitted user context
```

Any unevaluated piece is kept.

## Prune Output

No confidence field is needed.

```ts
type PruneDecisionBody = {
  drop: boolean;
  reason: DropReason | null;
};

type PruneOverride = PruneDecisionBody & {
  pieceId: string;
};

type PruneResponse = {
  defaultDecision: PruneDecisionBody;
  overrides: PruneOverride[];
};
```

`defaultDecision` lets the model keep or drop the whole batch without repeating every id.
`overrides` lists only evaluated pieces that differ from the default.

A drop is accepted only when:

```text
drop=true
+ reason is one of the allowed concrete reasons
+ the piece full payload was included in this batch
```

Allowed reasons:

```ts
type DropReason =
  | "exact_duplicate"
  | "superseded_by_newer_exact_source"
  | "explicitly_invalidated_by_user"
  | "old_task_after_confirmed_task_switch"
  | "pure_ack_or_chatter"
  | "transient_format_request_only"
  | "clearly_unrelated_to_current_work"
  | "empty_or_invalid";
```

Everything else means keep.

## Failure Rules

```text
malformed route -> same_task
unresolvable revive route -> same_task
malformed prune batch -> keep all pieces in that batch
source_chunk_batch omits a requested source -> use whole selector for that source
source_chunk_batch exceeds the overflow structured window -> use whole selectors for that batch
source_chunk_batch returns malformed ids/selectors after retry -> fail closed, prior memory unchanged
source_chunk_batch returns whole for a large text payload -> split deterministically on exact JSON
array-entry boundaries or bounded line windows before materializing active pieces; for rg output,
the prompt asks for conceptual groups first, such as rg --files path-prefix groups and rg -n
file/match groups
batch too large -> keep unevaluated pieces
missing archived payload -> keep that piece
uncertain decision -> keep
```

Manager outputs are requested with strict JSON schemas and validated again in local code before they
are applied.

The archive makes active-memory pruning reversible; conservative failure rules make accidental
active-memory loss hard.

## Duplicate Content

Exact duplicate payloads are not repeated in active memory. The first retained piece stays as the
canonical source for that content, and later duplicate pieces are represented as `duplicateSources`
markers on that canonical piece.

This keeps prompt data compact without hiding the fact that the same content appeared elsewhere.
