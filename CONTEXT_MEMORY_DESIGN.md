# Context Memory Design

## Overview

The proxy keeps context memory as:

- one live `objective`
- exact retained chunks that still matter to that objective

It does not use preview catalogs or task-index indirection.

## Prompt-Side Representation

The rewritten upstream prompt contains a deterministic memory block:

```xml
<pando_working_memory>
<objective>
Find the exact deployment facts and answer the user's follow-up questions.
</objective>
<exact_chunks>
<chunk id="chunk_17">
deploy_port=9091
</chunk>
<chunk id="chunk_18">
admin_email=ops@example.com
</chunk>
</exact_chunks>
<memory_fallback>
If the attached exact chunks are insufficient, call memory(offset, limit).
This returns additional exact retained chunks not already included above.
</memory_fallback>
</pando_working_memory>
```

This block is not a summary. It is the compact live working set.

## Why This Shape

The prior design made correctness harder to reason about because the system had multiple overlapping abstractions:

- raw history replay
- live task lists
- piece indexes with previews
- exact-fetch by id

The current design removes those layers from the default path.

## End-Of-Round Update

After a round completes, the proxy:

1. extracts newly observed content from that round
2. chunks that content into exact chunks
3. runs `working_memory_update`
4. stores only explicitly kept old and new chunks
5. clears memory completely when the objective ends

This means retention decisions are based on the full finished round, including assistant output, rather than on a partial pre-response guess.

## Fallback Memory

If the default inline working set is insufficient, the model may issue:

```json
{ "offset": 0, "limit": 10 }
```

The proxy intercepts `memory` locally and returns the next chronological slice of exact retained chunks that:

- are still live
- were not already included in the prompt

This is a recovery path, not the main retrieval mechanism.

## Finalization

The model that does the work is not required to emit the final user-facing answer directly.

The recommended flow is:

1. work round
2. working-memory update
3. final no-tool answer pass based on the exact work results

That keeps user-facing output aligned with the request rather than with internal memory fragments.

## Observability

When logging is enabled, the memory flow around this design should make it obvious:

- which new sources were observed
- how they were chunked into exact chunks
- which old and new chunks were explicitly kept or dropped
- what the current objective became
- which exact ids were fetched through `memory`
- what the aggregate stored memory looked like at round end
