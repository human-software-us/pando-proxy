# Design Principles

## 1. Keep One Live Objective

The durable abstraction of ongoing work is one compact `objective`, not a graph of interdependent tasks.

The objective should describe the live work plainly and minimally. If the work is finished, the objective should become `null`.

## 2. Exact Chunks Only

All retained memory outside the objective is exact content:

- exact user chunks
- exact assistant chunks
- exact tool chunks

There are no previews, summaries, pointer catalogs, or prose memory digests in the durable state.

## 3. Inline Payloads Only

Every retained chunk stores its original payload directly in state.

The design does not use:

- `payloadRef`
- blob indirection
- external payload files as the primary representation

Simplicity matters more than storage optimization here.

## 4. End-Of-Round Working-Set Update

Memory updates run once per completed round.

Input to the update:

- previous objective
- previous kept chunks
- exact new content from the completed round

Output from the update:

- `objectiveAfter`
- `keepOldChunkIds`
- `keepNewChunkIds`

Everything not explicitly kept is dropped.

## 5. Minimal Working Set

The system should retain only exact evidence that still matters for continuing the work or answering likely follow-up questions.

If the model ran five searches and only one exact result mattered, the other ninety-nine chunks should be dropped immediately.

The intended bias is:

- prefer dropping chunks
- keep only exact evidence that is still useful
- clear memory completely when the work is clearly over

## 6. No Preview Index By Default

The default rewritten prompt should contain:

- the live objective
- the exact retained chunks selected for inline inclusion

It should not contain:

- preview lists
- piece indexes
- selector metadata
- pointer metadata

## 7. Fallback Memory Is Exceptional

The main path is to attach the right exact chunks up front.

An optional local `memory(offset, limit)` fallback may exist, but only as a recovery path when the default chunk selection was insufficient.

That fallback should:

- exclude chunks already in the prompt
- return exact retained chunks only
- use deterministic chronological ordering
- stay transparent to the user

## 8. Cheap By Default

The system should use cheap structured-output calls by default.

The proxy should not add extra ranking, repair, or retrieval-planning loops unless they are strictly necessary.

## 9. Clean User-Facing Finalization

The work round and the user-facing answer are different products.

The proxy may use a separate finalization pass with no tools so the user receives a clean answer shaped around their request rather than around internal fragments and tool chatter.

## 10. Observable When Enabled

When logging is enabled, the memory manager should be mechanically inspectable.

At minimum the logs should show:

- the rewritten request shape
- structured model selection
- newly observed sources
- exact chunking output
- explicit keep/drop decisions for old and new chunks
- local `memory` requests and returned ids
- end-of-round aggregate memory state
