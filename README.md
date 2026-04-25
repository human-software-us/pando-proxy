# pando-proxy

> **By [pando](https://getpando.ai).** Released under the **[MIT License](./LICENSE)**.

`pando-proxy` is a thin local wrapper around [Codex](https://github.com/openai/codex) that inserts
an OpenAI Responses-compatible proxy between Codex and the upstream model. The proxy maintains a
small, mechanical group-and-piece memory so multi-round Codex sessions stay within context without
replaying the whole history.

## Measured replay benchmarks

Current benchmark reruns are summarized in [`QUICK_BENCHMARKS.md`](./QUICK_BENCHMARKS.md) and
documented in full in [`BENCHMARKS.md`](./BENCHMARKS.md). Public source links and related research
are indexed in [`benchmarks/SOURCES.md`](./benchmarks/SOURCES.md).

`bin/replay.ts` replays a saved rollout turn by turn and compares two prompt shapes: the naive
baseline (`without proxy`), which keeps sending the accumulated conversation history each round, and
the Pando rewrite (`with proxy`), which sends the compact exact-piece memory prompt instead.

The current public reruns on the shipped lossless memory manager use deterministic stub replay
(`--policy drop-tools`), which makes them cheap to reproduce locally while still exercising the
current prompt rewrite and replay path.

| Case                                             | Avg reduction | Peak reduction | Baseline avg approx tokens | Pando avg approx tokens | Baseline peak approx tokens | Pando peak approx tokens | Rounds |
| ------------------------------------------------ | ------------: | -------------: | -------------------------: | ----------------------: | --------------------------: | -----------------------: | -----: |
| SWE-bench Verified devstral full corpus (345)    |         79.8% |          70.2% |                     15,199 |                   3,063 |                      33,636 |                   10,023 | 21,709 |
| SWE-bench Verified devstral top-20 public sample |         88.2% |          54.6% |                     43,924 |                   5,202 |                     142,623 |                   64,692 |  3,807 |

The full-corpus `345`-trace rerun is the main public “all replays” data point for the current
implementation. Historical one-off and real-LLM numbers are still preserved in
[`BENCHMARKS.md`](./BENCHMARKS.md), but the table above is the current headline view.

Artifacts from the current public reruns live under `tmp/replay-devstral-verified-batch-current/`
and `tmp/replay-devstral-top20-stub-current/` as `*_stats.json`, `*_turns.jsonl`, and
`*_series.csv`. Historical real-LLM artifacts also live under `tmp/replay-real/` as
`*_manager-usage.jsonl`.

Public benchmark expansions are also documented in [`BENCHMARKS.md`](./BENCHMARKS.md). The current
public results include:

- a cheap full-corpus stub pass over all `345` currently exposed trajectories from the public
  `pankajmathur/devstral-24b-swebench-verified-traj` dataset
- a rerun of the public top-20 sample from that same dataset, selected as top `10` by round count
  plus top `10` additional by raw transcript size

On the current full-corpus rerun, the average prompt dropped from `15,199` to `3,063` tokens and the
average peak prompt dropped from `33,636` to `10,023` tokens.

## Why this exists

Long Codex sessions blow up the prompt with raw tool output and prior rounds. `pando-proxy` replaces
that approach with:

- a small active-group list per session
- exact retained pieces in the forwarded prompt, with groups kept internal for routing and cleanup
- aggressive end-of-turn pruning of new material through `group_intent`, `piece_retention_batch`,
  and `prompt_projection`
- an optional local `context_get({pieceIds:[...]})` or `context_get({offset,limit})` retrieval path
  the model can call to pull remaining exact pieces on demand
- a separate clean finalization pass for the user-facing answer

The package is designed to be invoked with one `npx` command and is otherwise invisible to Codex.

## Quickstart

```sh
npx -y pando-proxy exec "help me with this repo"
npx -y pando-proxy exec resume <thread-id> "continue"
npx -y pando-proxy "start an interactive Codex session"
```

Requires Deno and Codex on `PATH`. Codex must already be logged in (`codex login`).

The first run offers to install a shell alias (`codex → npx -y pando-proxy`). After that, plain
`codex ...` runs through the proxy.

## How it works

When you run `pando-proxy [...args]`, the binary:

1. Starts a local HTTP proxy on a free port (default search from `40123`).
2. Injects Codex config overrides so Codex talks to that proxy instead of the upstream.
3. Spawns `codex [...args]` as a child process, forwarding stdio.
4. Intercepts `POST /v1/responses`, rewrites each request against the stored session memory, runs
   the upstream call, and updates memory at round end.

### Pseudocode: request round

```
on POST /v1/responses:
  authHeader    = headerOrFallback(request, config.apiKey)
  sessionKey    = derivedFromHeadersOrBody(request, body)
  waitForAnyPendingFinalization(sessionKey)

  record        = store.load(sessionKey)          # groups + kept pieces + processedSourceIds + inlinePieceIds
  rewritten     = rewriteRequestWithMemory(body, record.memory)
    # drops prior-round items not needed
    # inserts <pando_memory> developer block with selected exact pieces only
    # injects context_get if retained pieces were omitted from prompt

  response, fetches, assistantSources = runResponsesLoop(rewritten)
    # streams upstream; intercepts context_get(...) tool calls locally
    # context_get(offset, limit) returns the next chronological slice of retained pieces
    # that weren't already inline in the prompt

  scheduleOrRunFinalization:
    newPieces = chunkNewSources(requestBody, loopFinalBody, assistantSources)
      # user messages  -> whole piece
      # assistant/tool -> structured piece chunker (small model)
      # pando outputs  -> deterministic splitter

    groupIntent = group_intent(
      groups        = record.memory.groups,
      newUserPieces = userPieces(newPieces),
    )
    retention = piece_retention_batch(
      groups               = groupIntent.groupsAfter,
      retainedPieceAnchors = anchorPieces(record.memory.pieces),
      newPieces            = newPieces,
    )
    projection = prompt_projection(
      groups          = groupIntent.groupsAfter,
      retainedPieces  = keep(active old pieces + retained new pieces),
      maxInlinePieces = config.maxInlinePieces,
    )

    store.save(sessionKey, {
      groups:             groupIntent.groupsAfter,
      pieces:             keep(active old pieces + retained new pieces),
      processedSourceIds: record.processedSourceIds ∪ sourcesSeenThisRound,
      inlinePieceIds:     projection.inlinePieceIds,
    })

  return response
```

### Pseudocode: rewritten prompt shape

```
[ leading_instructions_from_request ]
<pando_memory>
  <exact_pieces>
    <piece pieceId=piece_17 sourceKind=tool>…exact payload…</piece>
    …
  </exact_pieces>
  <context_get>
    Use context_get({pieceIds:[...]}) when you know the needed piece ids.
    Use context_get({offset,limit}) to browse additional retained exact pieces in chronological order.
    Prefer attached exact pieces when they already contain the needed fact.
  </context_get>
</pando_memory>
[ current_round_tail ]
```

### Transport modes

The wrapper auto-detects how to run Codex and picks one of three modes:

- `exec` / `e` → **exec-json**: adds `--json` and points Codex at the local HTTP proxy via Responses
  provider overrides; observes stdout JSONL for turn boundaries.
- `resume` / `fork` (or no command) → **interactive-direct**: runs `codex` directly with the same
  local provider overrides, but under a wrapper-owned private `CODEX_HOME`. The wrapper symlinks
  shared inputs (`config.toml`, `auth.json`, `.credentials.json`, `version.json`, `skills/`,
  `vendor_imports/`, `installation_id`) from the real Codex home and keeps `sessions/` private
  during the run so rollout attachment is exact. After Codex exits, the wrapper mirrors updated
  session files back into the real `CODEX_HOME/sessions`.
- any other top-level command (`login`, `mcp`, `help`, `app-server`, etc.) → **passthrough**: Codex
  runs with the provider overrides but nothing is intercepted.

## Codex argument passthrough

You can mix proxy flags and Codex arguments freely. The parser:

- Recognizes `--proxy-*` and `--help/-h` as proxy flags.
- Treats everything from the **first unrecognized argument onward** as Codex arguments and passes
  them through unchanged.
- Honors an explicit `--` separator as the end of proxy flags; anything after it goes to Codex
  verbatim.

Examples:

```sh
# All arguments after "exec" are passed to Codex:
npx -y pando-proxy --proxy-log exec --sandbox read-only -o out.txt "prompt"

# Same thing, explicit separator:
npx -y pando-proxy --proxy-log -- exec --sandbox read-only -o out.txt "prompt"

# Resume a specific session by exact thread id:
npx -y pando-proxy exec resume 019dc204-22fb-7c50-95ad-2f2508254945 "next prompt"

# Resume with exec-global flags after resume (wrapper hoists them automatically):
npx -y pando-proxy exec resume 019dc204-22fb-7c50-95ad-2f2508254945 --sandbox read-only -o out.txt "next prompt"

# Pure Codex passthrough (still runs through the proxy transport, no interception):
npx -y pando-proxy login
npx -y pando-proxy help exec
```

Because the first non-proxy argument becomes the start of the Codex args, `exec`, `resume`,
`app-server`, `help`, etc., all work as if you typed them into `codex` directly. Any Codex flag is
supported — the proxy never filters Codex's argument surface.

### Resume handling

Prefer an exact thread id almost always. That keeps live validation pinned to the session you
actually inspected in logs and avoids accidentally resuming the wrong rollout when several sessions
exist on disk.

Use `--last` only as a fallback when you explicitly want "whatever the wrapper most recently saw"
and you have already confirmed there is no ambiguity.

The wrapper does two things to `exec resume --last` if you use that fallback:

1. **`--last` is replaced with the saved session id** (from `<state-dir>/wrapper-last-thread.json`)
   before handing off to Codex. Codex also accepts `--last` natively, but substituting the concrete
   id keeps the session pinned across restarts of the wrapper and makes logs more useful.
2. **Exec-global flags written after `resume` are hoisted to before `resume`.** Codex's
   `exec resume` subcommand doesn't accept every flag that `codex exec` accepts — `--sandbox`,
   `-C`/`--cd`, `--add-dir`, `--oss`, `--local-provider`, `-p`/`--profile`, `--output-schema`, and
   `--color` are `exec`-only. Writing them after `resume` would make Codex reject the command. The
   wrapper detects these and moves them into the right slot automatically, so
   `exec resume 019dc204-22fb-7c50-95ad-2f2508254945 --sandbox read-only "prompt"` works, and the
   same hoisting also applies if you intentionally use `--last`.

Interactive `resume --last` and `fork --last` are also normalized to a concrete session id before
Codex is launched. The wrapper resolves that id from the explicit argument when present, otherwise
from `<state-dir>/wrapper-last-thread.json`, and finally from the private rollout file under the
wrapper-owned `CODEX_HOME` if needed. After an interactive run exits, the wrapper syncs updated
session files back to the source `CODEX_HOME/sessions`, then on normal exit and on interrupt it
prints the last observed Codex session id plus a `codex resume <id>` hint.

## Subcommands

```
pando-proxy [proxy options] [codex args...]   # wrapper — default
pando-proxy serve   [serve options]           # just run the proxy, no Codex
pando-proxy doctor                            # check port, creds, upstream reachability
pando-proxy help                              # print wrapper + proxy help
```

Use `serve` when you want the proxy running independently (e.g. for tests that start/stop Codex
themselves). Use `doctor` for a fast sanity check before opening a support issue.

## Wrapper options (proxy flags)

| Flag                                         | Default          | Description                                                                                                                               |
| -------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--proxy-host <host>`                        | `127.0.0.1`      | Host to bind the local proxy to.                                                                                                          |
| `--proxy-port-start <port>`                  | `40123`          | First port to try; the wrapper walks forward until a free port is found.                                                                  |
| `--proxy-upstream-base-url <url>`            | `auto`           | Upstream Responses endpoint. `auto` picks `https://api.openai.com/v1` when Codex sends an `sk-` key, otherwise the ChatGPT Codex backend. |
| `--proxy-small-structured-model <model>`     | `gpt-5.4-mini`   | Model used for structured memory updates and chunking. Alias: `--proxy-maintenance-model`.                                                |
| `--proxy-overflow-structured-model <model>`  | `gpt-5.4`        | Larger-window fallback when the small model's context is insufficient.                                                                    |
| `--proxy-state-dir <path>`                   | `~/.pando-proxy` | On-disk session state + logs.                                                                                                             |
| `--proxy-codex-auto-compact-token-limit <n>` | `280000`         | Value injected as Codex's `model_auto_compact_token_limit`. About 70% of GPT-5's documented 400000 context window.                        |
| `--proxy-no-memory`                          | off              | Bypass memory rewrite; pass requests straight through.                                                                                    |
| `--proxy-log`                                | off              | Enable JSONL logging to a unique file under `<state-dir>/logs`.                                                                           |
| `--proxy-log-file <path>`                    | (off)            | Enable logging to a specific path.                                                                                                        |
| `--run-codex-direct`                         | off              | Escape hatch: skip the wrapper and proxy entirely, run raw `codex` with inherited stdio. Put this flag **before** any Codex args.         |
| `--uninstall-codex-alias`                    | off              | Remove the `codex -> npx -y pando-proxy` shell alias that pando-proxy installed, then exit.                                               |
| `--proxy-help`, `--help`, `-h`               | —                | Print wrapper + proxy help.                                                                                                               |

> **Important — apparent freeze before any proxy request arrives.** If wrapped Codex appears stalled
> before the first proxy request, Codex is usually waiting on an in-terminal prompt of its own.
> `pando-proxy` now shares `version.json` from the real Codex home, so the update-banner state
> should normally match raw `codex`. If you still need to answer a Codex-owned prompt directly,
> re-run with `--run-codex-direct`:
>
> ```sh
> npx -y pando-proxy --run-codex-direct         # or: codex --run-codex-direct
> npx -y pando-proxy --run-codex-direct --help
> ```

To remove the installed shell alias later:

```sh
npx -y pando-proxy --uninstall-codex-alias
```

## `serve` / `doctor` options

`pando-proxy serve` accepts a simpler flag set (no wrapper-level concerns):

```
--host <host>                         Default: 127.0.0.1
--port <port>                         Default: 8787
--upstream-base-url <url>             Default: auto
--small-structured-model <model>      Default: gpt-5.4-mini
--overflow-structured-model <model>   Default: gpt-5.4
--state-dir <path>                    Default: ~/.pando-proxy
--codex-auto-compact-token-limit <n>  Default: 280000
--no-memory                           Bypass memory rewrite
--log-file <path>                     Write JSONL events to this path
```

## Environment variables

Every wrapper/serve flag has an equivalent env var. CLI flags win; env vars fall back to defaults.

| Variable                                         | Equivalent flag                                    |
| ------------------------------------------------ | -------------------------------------------------- |
| `PANDO_PROXY_HOST`                               | `--host` / `--proxy-host`                          |
| `PANDO_PROXY_PORT`                               | `--port`                                           |
| `PANDO_PROXY_UPSTREAM_BASE_URL`                  | `--upstream-base-url`                              |
| `PANDO_PROXY_SMALL_STRUCTURED_MODEL`             | `--small-structured-model`                         |
| `PANDO_PROXY_MAINTENANCE_MODEL`                  | legacy alias for above                             |
| `PANDO_PROXY_OVERFLOW_STRUCTURED_MODEL`          | `--overflow-structured-model`                      |
| `PANDO_PROXY_SMALL_STRUCTURED_CONTEXT_WINDOW`    | tuning only                                        |
| `PANDO_PROXY_OVERFLOW_STRUCTURED_CONTEXT_WINDOW` | tuning only                                        |
| `PANDO_PROXY_MODEL_TIMEOUT_MS`                   | structured-model call timeout                      |
| `PANDO_PROXY_STATE_DIR`                          | `--state-dir`                                      |
| `PANDO_PROXY_DISABLE_MEMORY`                     | `--no-memory`                                      |
| `PANDO_PROXY_LOG_FILE`                           | `--log-file`                                       |
| `PANDO_PROXY_INLINE_PIECE_BYTE_LIMIT`            | inline payload cap (bytes)                         |
| `PANDO_PROXY_PIECE_PREVIEW_CHAR_LIMIT`           | internal preview cap                               |
| `PANDO_PROXY_MAX_INLINE_PIECES`                  | max inline pieces per prompt                       |
| `PANDO_PROXY_MAX_LOCAL_CONTEXT_TOOL_CALLS`       | per-round cap on `context_get(...)` calls          |
| `PANDO_PROXY_CODEX_AUTO_COMPACT_TOKEN_LIMIT`     | `--codex-auto-compact-token-limit`                 |
| `OPENAI_API_KEY`                                 | fallback `Authorization` if Codex doesn't send one |

## Memory model

Durable per-session state is just:

- `groups` (a small list of active durable memory groups with routing labels and short summaries)
- `pieces` (exact retained pieces linked to groups, optionally spilled to payload refs when they
  exceed the inline byte limit)
- `processedSourceIds`
- `inlinePieceIds`

The runtime stays exact where it matters: retained evidence is stored as exact pieces, while the
group layer carries only compact routing metadata (`routingLabel` and `summary`) for internal
classification and cleanup. That metadata is not forwarded to the upstream model. There is still no
embedding store. Large payloads may be spilled to per-session payload files while preserving exact
retrieval. See `REFERENCE.md` for the exact types.

At the end of each completed round, the proxy runs three structured maintenance steps:

- `group_intent` updates the durable active groups from the previous groups plus the new user pieces
- `piece_retention_batch` decides which new exact pieces to keep, which group each kept piece
  belongs to, and whether it should usually be `inline` or `omittable`
- `prompt_projection` chooses which retained pieces should actually be inlined next round, subject
  to `maxInlinePieces`

New pieces are retained only when explicitly linked to still-active groups. Older pieces remain
while their groups remain active and they are not superseded by newer retained pieces.

## Prompt rewrite

Each upstream request is rebuilt from:

- the leading instructions in the original request
- a single developer-role `<pando_memory>` block containing only the inline exact pieces selected
  for this turn
- the current round tail (the live user message and in-flight tool results)

If retained pieces exist that weren't selected for inline inclusion, the proxy also injects a
`context_get` tool the model can call to read them. The tool returns exact stored payloads by
specific piece id or in chronological order, excluding anything already in the prompt.

## Finalization

Work and final answer are decoupled:

1. Work pass: tools and intermediate steps allowed.
2. Memory update: update groups, keep/drop exact pieces, and project the next inline set.
3. Finalization pass: no tools, produce the user-facing answer from exact work results.

The final answer should match the user's request, not the proxy's internal fragments.

## Observability

Logging is off unless `--proxy-log` or `--proxy-log-file` (or `PANDO_PROXY_LOG_FILE`) is set.

When enabled, every round emits JSONL events: `incoming_request`, `rewritten_context`,
`structured_model_selected`, `memory_round_sources`, `memory_round_chunked`,
`memory_round_decision`, `context_get_fetch`, `memory_round_updated`, `memory_state_saved`,
`round_complete`.

`round_complete` is the round-level aggregate: current group ids/count, piece ids/count, total
stored piece bytes, processed source count, inline piece ids/count, local fetch count and returned
ids, internal structured-model usage, aggregate token usage, and any memory-update error.

`memory_round_decision` records the group set before and after the round, retired group ids, piece
retention decisions, the new inline-piece projection, and the explicit kept/dropped piece ids for
that round.

## Local development

For fast iteration against the latest source, skip `npm pack` and invoke Deno directly:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-test-1.jsonl \
  --proxy-state-dir /tmp/pando-test-1-state \
  exec --sandbox read-only -o /tmp/r1.txt "your prompt"
```

Reuse the same `--proxy-log-file` and `--proxy-state-dir` across rounds to keep one durable memory
session. See `LIVE_E2E.md` for the full live-test recipe.

## Publishing

The npm release flow lives in [`npm-publishing.md`](./npm-publishing.md). It covers the exact
version bump, verification, commit, and `NPM_TOKEN`-based publish command used for this package.

## Files

Core implementation:

- `bin/pando-proxy.js` — Node shim that spawns Deno on the bundled/source entrypoint
- `src/main.ts` — CLI dispatch (wrapper / `serve` / `doctor`)
- `src/wrapper.ts` — Codex child-process wrapper + per-run proxy lifecycle
- `src/server.ts` — HTTP proxy for `/v1/responses`
- `src/upstream.ts` — upstream call + local `context_get(...)` interception
- `src/prompt_view.ts` — request rewrite with working memory
- `src/memory_pipeline.ts`, `src/group_manager.ts` — end-of-round group/piece update
- `src/chunking.ts`, `src/tool_results.ts` — source chunking
- `src/store.ts`, `src/memory_state.ts` — session state on disk
- `src/structured_model.ts` — small/overflow structured-model clients
- `src/codex_modes.ts`, `src/codex_request.ts`, `src/codex_events.ts` — Codex CLI shape & JSONL
  parsing
- `src/config.ts`, `src/doctor.ts`, `src/logger.ts`, `src/metrics.ts`, `src/json.ts`, `src/hash.ts`,
  `src/replay.ts`

Design docs:

- `DESIGN_PRINCIPLES.md`
- `MEMORY_OPERATIONS.md`
- `REFERENCE.md`
- `CONTEXT_MEMORY_DESIGN.md`
- `LIVE_E2E.md`
