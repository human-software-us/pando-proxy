# Live Accounting Results - 2026-04-25

Manual live backend runs against the current proxy implementation.

## Scope

- Verify proxy-visible accounting fields:
  - `withoutProxy`: estimated no-proxy input tokens from the original request body before rewrite.
  - `withProxy`: actual billed all-in tokens from main model usage plus internal manager usage.
  - `proxy overhead`: exact manager usage parsed from OpenAI/Responses usage objects for structured
    calls.
- Verify wrapper exit output is token-first and no longer prints byte context summaries or duplicate
  resume lines.
- Log file: `/tmp/pando-accounting-live-1.jsonl`
- State dir: `/tmp/pando-accounting-live-state`
- Thread: `019dc64e-1819-7681-b72b-c09d0b123bbf`

## Commands

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-accounting-live-1.jsonl \
  --proxy-state-dir /tmp/pando-accounting-live-state \
  exec \
  --sandbox read-only \
  -o /tmp/pando-accounting-live-r1.txt \
  "Live accounting probe round 1. Reply exactly ACCOUNTING-R1. Do not run tools."
```

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-accounting-live-1.jsonl \
  --proxy-state-dir /tmp/pando-accounting-live-state \
  exec resume 019dc64e-1819-7681-b72b-c09d0b123bbf \
  --sandbox read-only \
  -o /tmp/pando-accounting-live-r2.txt \
  "Live accounting probe round 2. Reply exactly ACCOUNTING-R2. Do not run tools."
```

## User-Visible Output

Round 1 answered `ACCOUNTING-R1`.

Wrapper accounting excerpt:

```text
Pando Proxy tokens without proxy, estimated input (019dc64e-1819-7681-b72b-c09d0b123bbf): min 20,301, avg 20,301, max 20,301, total 20,301
Pando Proxy tokens with proxy, billed all-in (019dc64e-1819-7681-b72b-c09d0b123bbf): total min 19,854, avg 19,854, max 19,854, total 19,854, input total 19,567, cached total 6,528, output total 287, main total 17,364, overhead total 2,490
Pando Proxy proxy overhead (019dc64e-1819-7681-b72b-c09d0b123bbf): total 2,490, input 2,224, cached 0, output 266, retries 0, skipped 0, duration 3,504ms
```

Round 2 answered `ACCOUNTING-R2`.

Wrapper accounting excerpt:

```text
Pando Proxy tokens without proxy, estimated input (019dc64e-1819-7681-b72b-c09d0b123bbf): min 20,630, avg 20,630, max 20,630, total 20,630
Pando Proxy tokens with proxy, billed all-in (019dc64e-1819-7681-b72b-c09d0b123bbf): total min 20,684, avg 20,684, max 20,684, total 20,684, input total 20,358, cached total 6,528, output total 326, main total 17,903, overhead total 2,781
Pando Proxy proxy overhead (019dc64e-1819-7681-b72b-c09d0b123bbf): total 2,781, input 2,476, cached 0, output 305, retries 0, skipped 0, duration 4,229ms
```

Exit output no longer included:

- `pando-proxy: resume with: ...`
- `pando-proxy: last Codex session id: ...`
- `Pando Proxy context bytes without proxy: ...`
- `Pando Proxy context bytes with proxy: ...`
- per-classifier manager lines

Codex itself still printed its own `turn.completed.usage` and one rollout recording warning:

```text
failed to record rollout items: thread 019dc64e-1819-7681-b72b-c09d0b123bbf not found
```

That warning did not prevent proxy finalization or state persistence.

## JSONL Accounting

Extracted with:

```sh
jq -c 'select(.event=="incoming_request" or .event=="round_complete") | if .event=="incoming_request" then {event, sessionKey, approxInputTokens, approxInputBytes} else {event, sessionKey, memoryUpdateError, archiveRecallCount, inputTokens, cachedInputTokens, outputTokens, totalTokens, internalManagerInputTokens, internalManagerOutputTokens, internalManagerTotalTokens, allInInputTokens, allInCachedInputTokens, allInOutputTokens, allInTotalTokens} end' /tmp/pando-accounting-live-1.jsonl
```

Output:

```json
{"event":"incoming_request","sessionKey":"019dc64e-1819-7681-b72b-c09d0b123bbf","approxInputTokens":20301,"approxInputBytes":81214}
{"event":"round_complete","sessionKey":"019dc64e-1819-7681-b72b-c09d0b123bbf","memoryUpdateError":null,"archiveRecallCount":0,"inputTokens":17343,"cachedInputTokens":6528,"outputTokens":21,"totalTokens":17364,"internalManagerInputTokens":2224,"internalManagerOutputTokens":266,"internalManagerTotalTokens":2490,"allInInputTokens":19567,"allInCachedInputTokens":6528,"allInOutputTokens":287,"allInTotalTokens":19854}
{"event":"incoming_request","sessionKey":"019dc64e-1819-7681-b72b-c09d0b123bbf","approxInputTokens":20630,"approxInputBytes":82531}
{"event":"round_complete","sessionKey":"019dc64e-1819-7681-b72b-c09d0b123bbf","memoryUpdateError":null,"archiveRecallCount":0,"inputTokens":17882,"cachedInputTokens":6528,"outputTokens":21,"totalTokens":17903,"internalManagerInputTokens":2476,"internalManagerOutputTokens":305,"internalManagerTotalTokens":2781,"allInInputTokens":20358,"allInCachedInputTokens":6528,"allInOutputTokens":326,"allInTotalTokens":20684}
```

Arithmetic checked:

- Round 1 total: `17,364 main + 2,490 overhead = 19,854 all-in`.
- Round 1 input: `17,343 main + 2,224 overhead = 19,567 all-in`.
- Round 1 output: `21 main + 266 overhead = 287 all-in`.
- Round 2 total: `17,903 main + 2,781 overhead = 20,684 all-in`.
- Round 2 input: `17,882 main + 2,476 overhead = 20,358 all-in`.
- Round 2 output: `21 main + 305 overhead = 326 all-in`.

## State Check

Persisted state after round 2:

```json
{
  "roundSeq": 2,
  "groupCount": 1,
  "pieceCount": 1,
  "activePiecePreview": "ACCOUNTING-R2",
  "processedSourceCount": 4
}
```

The manager dropped the obsolete round 1 assistant piece and kept the round 2 exact answer. Both
rounds had `archiveRecallCount: 0` and `memoryUpdateError: null`.

## Result

Passed for proxy accounting and exit-output noise reduction:

- Baseline no-proxy input estimate is visible in wrapper output and logged as
  `incoming_request.approxInputTokens`.
- Exact manager overhead is visible as `proxy overhead` in wrapper output and as
  `internalManager*Tokens` in `round_complete`.
- All-in with-proxy billed totals are visible in wrapper output and as `allIn*Tokens` in
  `round_complete`.
- Default wrapper exit output is token-only for proxy summaries.

Known limitation:

- The standard Codex-facing `response.completed.response.usage` still reflects the main upstream
  response, not all-in proxy-inclusive usage. In wrapper mode, exact manager overhead is only known
  after async memory finalization, which happens after Codex has already received and processed the
  response. Rewriting that standard usage field to exact all-in totals would require moving or
  splitting finalization.
