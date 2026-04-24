# pando-proxy

> **By [pando](https://getpando.ai).** Free for personal & noncommercial use under **[PolyForm Noncommercial 1.0.0](./LICENSE)**. **Commercial use requires a license** — contact **<camellia@human.software>**.

`pando-proxy` is a thin local wrapper around [Codex](https://github.com/openai/codex) that inserts an OpenAI Responses-compatible proxy between Codex and the upstream model. The proxy maintains a small, mechanical working memory so multi-round Codex sessions stay within context without replaying the whole history.

## Measured replay benchmarks

Real replay runs are summarized in [`QUICK_BENCHMARKS.md`](./QUICK_BENCHMARKS.md) and documented in full in [`BENCHMARKS.md`](./BENCHMARKS.md). These numbers come from `bin/replay.ts --real-llm --auth-from-codex`, so the replay path used the real structured chunking and working-memory-update calls instead of the deterministic stub policy.

| Case | Rounds | Baseline avg approx tokens | Pando avg approx tokens | Avg reduction | Baseline max approx tokens | Pando max approx tokens | Max reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Local `exec` stress log | 8 | 7,674 | 5,195 | 32.3% | 13,231 | 7,788 | 41.1% |
| Local `cli` interactive log | 9 | 193,840 | 60,407 | 68.8% | 286,898 | 87,877 | 69.4% |
| Public open log (GitHub Gist) | 2 | 1,292 | 885 | 31.5% | 1,502 | 1,084 | 27.8% |
| SWE-PolyBench `iswe_agent` editing | 69 | 8,331 | 4,464 | 46.4% | 10,046 | 7,385 | 26.5% |

The proxy helps most once a session has real history to carry forward. On short 1-2 turn runs the win can be small or mixed, but on long interactive sessions the baseline keeps replaying old context while Pando stays bounded by the compact working set.

Artifacts from these runs live under `tmp/replay-real/` as `*_stats.json`, `*_turns.jsonl`, `*_series.csv`, and `*_manager-usage.jsonl`.

## Why this exists

Long Codex sessions blow up the prompt with raw tool output and prior rounds. `pando-proxy` replaces that approach with:

- one compact live `objective` per session
- exact retained chunks only (no prose summaries, no preview catalogs, no embeddings)
- aggressive end-of-turn pruning
- an optional local `memory(offset, limit)` tool the model can call to pull remaining exact chunks on demand
- a separate clean finalization pass for the user-facing answer

The package is designed to be invoked with one `npx` command and is otherwise invisible to Codex.

## Quickstart

```sh
npx -y pando-proxy exec "help me with this repo"
npx -y pando-proxy exec resume --last "continue"
npx -y pando-proxy "start an interactive Codex session"
```

Requires Deno and Codex on `PATH`. Codex must already be logged in (`codex login`).

The first run offers to install a shell alias (`codex → npx -y pando-proxy`). After that, plain `codex ...` runs through the proxy.

## How it works

When you run `pando-proxy [...args]`, the binary:

1. Starts a local HTTP proxy on a free port (default search from `40123`).
2. Injects Codex config overrides so Codex talks to that proxy instead of the upstream.
3. Spawns `codex [...args]` as a child process, forwarding stdio.
4. Intercepts `POST /v1/responses`, rewrites each request against the stored session memory, runs the upstream call, and updates memory at round end.

### Pseudocode: request round

```
on POST /v1/responses:
  authHeader    = headerOrFallback(request, config.apiKey)
  sessionKey    = derivedFromHeadersOrBody(request, body)
  waitForAnyPendingFinalization(sessionKey)

  record        = store.load(sessionKey)          # objective + kept chunks + processedSourceIds
  rewritten     = rewriteRequestWithMemory(body, record.memory)
    # drops prior-round items not needed
    # inserts <pando_working_memory> developer block with objective + selected exact chunks
    # injects memory(offset, limit) tool if any retained chunks were omitted from prompt

  response, fetches, assistantSources = runResponsesLoop(rewritten)
    # streams upstream; intercepts memory(...) tool calls locally
    # memory(offset, limit) returns the next chronological slice of retained chunks
    # that weren't already inline in the prompt

  scheduleOrRunFinalization:
    newChunks = chunkNewSources(requestBody, loopFinalBody, assistantSources)
      # user messages  -> whole chunk
      # assistant/tool -> structured chunker (small model)
      # pando outputs  -> deterministic splitter

    update = working_memory_update(
      objective     = record.memory.objective,
      keptChunks    = record.memory.chunks,
      newChunks     = newChunks,
    )
    # returns: { objectiveAfter, keepOldChunkIds, keepNewChunkIds }

    store.save(sessionKey, {
      objective:          update.objectiveAfter,
      chunks:             keep(old + new, update.keep*Ids),
      processedSourceIds: record.processedSourceIds ∪ sourcesSeenThisRound,
    })

  return response
```

### Pseudocode: rewritten prompt shape

```
[ leading_instructions_from_request ]
<pando_working_memory>
  <objective>…current live objective…</objective>
  <exact_chunks>
    <chunk id="chunk_17">…exact payload…</chunk>
    …
  </exact_chunks>
  <memory_fallback>
    If the attached exact chunks are insufficient, call memory(offset, limit).
  </memory_fallback>
</pando_working_memory>
[ current_round_tail ]
```

### Transport modes

The wrapper auto-detects how to run Codex and picks one of three modes:

- `exec` / `e` → **exec-json**: adds `--json` and points Codex at the local HTTP proxy via Responses provider overrides; observes stdout JSONL for turn boundaries.
- `resume` / `fork` (or no command) → **interactive-remote**: starts a local `codex app-server` plus a websocket relay and runs Codex with `--remote <relay>`.
- any other top-level command (`login`, `mcp`, `help`, `app-server`, etc.) → **passthrough**: Codex runs with the provider overrides but nothing is intercepted.

## Codex argument passthrough

You can mix proxy flags and Codex arguments freely. The parser:

- Recognizes `--proxy-*` and `--help/-h` as proxy flags.
- Treats everything from the **first unrecognized argument onward** as Codex arguments and passes them through unchanged.
- Honors an explicit `--` separator as the end of proxy flags; anything after it goes to Codex verbatim.

Examples:

```sh
# All arguments after "exec" are passed to Codex:
npx -y pando-proxy --proxy-log exec --sandbox read-only -o out.txt "prompt"

# Same thing, explicit separator:
npx -y pando-proxy --proxy-log -- exec --sandbox read-only -o out.txt "prompt"

# Resume last session (wrapper rewrites `resume --last` to the saved session id):
npx -y pando-proxy exec resume --last "next prompt"

# Resume with exec-global flags after resume (wrapper hoists them automatically):
npx -y pando-proxy exec resume --last --sandbox read-only -o out.txt "next prompt"

# Pure Codex passthrough (still runs through the proxy transport, no interception):
npx -y pando-proxy login
npx -y pando-proxy help exec

```

Because the first non-proxy argument becomes the start of the Codex args, `exec`, `resume`, `app-server`, `help`, etc., all work as if you typed them into `codex` directly. Any Codex flag is supported — the proxy never filters Codex's argument surface.

### Resume handling

The wrapper does two things to `exec resume --last` so it behaves the way you'd expect:

1. **`--last` is replaced with the saved session id** (from `<state-dir>/wrapper-last-thread.json`) before handing off to Codex. Codex also accepts `--last` natively, but substituting the concrete id keeps the session pinned across restarts of the wrapper and makes logs more useful.
2. **Exec-global flags written after `resume` are hoisted to before `resume`.** Codex's `exec resume` subcommand doesn't accept every flag that `codex exec` accepts — `--sandbox`, `-C`/`--cd`, `--add-dir`, `--oss`, `--local-provider`, `-p`/`--profile`, `--output-schema`, and `--color` are `exec`-only. Writing them after `resume` would make Codex reject the command. The wrapper detects these and moves them into the right slot automatically, so `exec resume --last --sandbox read-only "prompt"` and `exec --sandbox read-only resume --last "prompt"` both work.

## Subcommands

```
pando-proxy [proxy options] [codex args...]   # wrapper — default
pando-proxy serve   [serve options]           # just run the proxy, no Codex
pando-proxy doctor                            # check port, creds, upstream reachability
pando-proxy help                              # print wrapper + proxy help
```

Use `serve` when you want the proxy running independently (e.g. for tests that start/stop Codex themselves). Use `doctor` for a fast sanity check before opening a support issue.

## Wrapper options (proxy flags)

| Flag | Default | Description |
| --- | --- | --- |
| `--proxy-host <host>` | `127.0.0.1` | Host to bind the local proxy to. |
| `--proxy-port-start <port>` | `40123` | First port to try; the wrapper walks forward until a free port is found. |
| `--proxy-upstream-base-url <url>` | `auto` | Upstream Responses endpoint. `auto` picks `https://api.openai.com/v1` when Codex sends an `sk-` key, otherwise the ChatGPT Codex backend. |
| `--proxy-small-structured-model <model>` | `gpt-5.4-mini` | Model used for structured memory updates and chunking. Alias: `--proxy-maintenance-model`. |
| `--proxy-overflow-structured-model <model>` | `gpt-5.4` | Larger-window fallback when the small model's context is insufficient. |
| `--proxy-state-dir <path>` | `~/.pando-proxy` | On-disk session state + logs. |
| `--proxy-codex-auto-compact-token-limit <n>` | `280000` | Value injected as Codex's `model_auto_compact_token_limit`. About 70% of GPT-5's documented 400000 context window. |
| `--proxy-no-memory` | off | Bypass memory rewrite; pass requests straight through. |
| `--proxy-log` | off | Enable JSONL logging to a unique file under `<state-dir>/logs`. |
| `--proxy-log-file <path>` | (off) | Enable logging to a specific path. |
| `--proxy-run-codex-direct` | off | Escape hatch: skip the wrapper and proxy entirely, run raw `codex` with inherited stdio. Put this flag **before** any Codex args. |
| `--uninstall-codex-alias` | off | Remove the `codex -> npx -y pando-proxy` shell alias that pando-proxy installed, then exit. |
| `--proxy-help`, `--help`, `-h` | — | Print wrapper + proxy help. |

> **Important — apparent freeze before any proxy request arrives.** Codex sometimes waits on its own update-chooser prompt before making its first Responses call. When that happens, `pando-proxy` (or an aliased `codex`) will look frozen because no request has reached the proxy yet. Re-run with `--proxy-run-codex-direct` to bypass the wrapper entirely and let Codex display its prompt directly:
>
> ```sh
> npx -y pando-proxy --proxy-run-codex-direct         # or: codex --proxy-run-codex-direct
> npx -y pando-proxy --proxy-run-codex-direct --help
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

| Variable | Equivalent flag |
| --- | --- |
| `PANDO_PROXY_HOST` | `--host` / `--proxy-host` |
| `PANDO_PROXY_PORT` | `--port` |
| `PANDO_PROXY_UPSTREAM_BASE_URL` | `--upstream-base-url` |
| `PANDO_PROXY_SMALL_STRUCTURED_MODEL` | `--small-structured-model` |
| `PANDO_PROXY_MAINTENANCE_MODEL` | legacy alias for above |
| `PANDO_PROXY_OVERFLOW_STRUCTURED_MODEL` | `--overflow-structured-model` |
| `PANDO_PROXY_SMALL_STRUCTURED_CONTEXT_WINDOW` | tuning only |
| `PANDO_PROXY_OVERFLOW_STRUCTURED_CONTEXT_WINDOW` | tuning only |
| `PANDO_PROXY_MODEL_TIMEOUT_MS` | structured-model call timeout |
| `PANDO_PROXY_STATE_DIR` | `--state-dir` |
| `PANDO_PROXY_DISABLE_MEMORY` | `--no-memory` |
| `PANDO_PROXY_LOG_FILE` | `--log-file` |
| `PANDO_PROXY_INLINE_PIECE_BYTE_LIMIT` | inline payload cap (bytes) |
| `PANDO_PROXY_PIECE_PREVIEW_CHAR_LIMIT` | internal preview cap |
| `PANDO_PROXY_MAX_INDEXED_PIECES_PER_TASK` | max inline chunks per prompt |
| `PANDO_PROXY_MAX_LOCAL_CONTEXT_TOOL_CALLS` | per-round cap on `memory(...)` calls |
| `PANDO_PROXY_CODEX_AUTO_COMPACT_TOKEN_LIMIT` | `--codex-auto-compact-token-limit` |
| `OPENAI_API_KEY` | fallback `Authorization` if Codex doesn't send one |

## Memory model

Durable per-session state is just:

- `objective` (one compact string or `null`)
- `chunks` (array of exact retained chunks, inline payloads)
- `processedSourceIds`

There are no blob refs, no payload indirection, no summaries. See `REFERENCE.md` for the exact types.

At the end of each completed round, the proxy runs one structured `working_memory_update` call with:

- the previous objective
- the previous kept chunks
- the new exact chunks observed during the round

It returns `{ objectiveAfter, keepOldChunkIds, keepNewChunkIds }`. Everything not explicitly kept is dropped.

## Prompt rewrite

Each upstream request is rebuilt from:

- the leading instructions in the original request
- a single developer-role `<pando_working_memory>` block containing the objective and the inline exact chunks selected for this turn
- the current round tail (the live user message and in-flight tool results)

If retained chunks exist that weren't selected for inline inclusion, the proxy also injects a `memory(offset, limit)` tool the model can call to read them. The tool returns exact stored payloads in chronological order, excluding anything already in the prompt. It is a fallback, not the main retrieval path.

## Finalization

Work and final answer are decoupled:

1. Work pass: tools and intermediate steps allowed.
2. Memory update: keep/drop exact chunks.
3. Finalization pass: no tools, produce the user-facing answer from exact work results.

The final answer should match the user's request, not the proxy's internal fragments.

## Observability

Logging is off unless `--proxy-log` or `--proxy-log-file` (or `PANDO_PROXY_LOG_FILE`) is set.

When enabled, every round emits JSONL events: `incoming_request`, `rewritten_context`, `structured_model_selected`, `memory_round_sources`, `memory_round_chunked`, `memory_round_decision`, `memory_fetch`, `memory_round_updated`, `memory_state_saved`, `round_complete`.

`round_complete` is the round-level aggregate: current objective, chunk ids/count, total stored bytes, processed source count, local fetch count and returned ids, token usage, and any memory-update error.

## Local development

For fast iteration against the latest source, skip `npm pack` and invoke Deno directly:

```sh
deno run --allow-net --allow-env --allow-read --allow-write --allow-run \
  src/main.ts \
  --proxy-log-file /tmp/pando-test-1.jsonl \
  --proxy-state-dir /tmp/pando-test-1-state \
  exec --sandbox read-only -o /tmp/r1.txt "your prompt"
```

Reuse the same `--proxy-log-file` and `--proxy-state-dir` across rounds to keep one durable memory session. See `LIVE_E2E.md` for the full live-test recipe.

## Publishing

Release flow:

```sh
# 1. bump the package version
npm version patch --no-git-tag-version

# 2. verify the package from the exact tree you will publish
deno check src/main.ts
npm pack --dry-run

# 3. commit the release
git add README.md package.json src tests LICENSE
git commit -m "Release x.y.z"

# 4. publish using an npm token loaded from .env
set -a
. ./.env
set +a
npm publish --//registry.npmjs.org/:_authToken="$NPM_TOKEN"
```

Notes:

- `.env` should provide `NPM_TOKEN`.
- Do not commit `.env`.
- The `--//registry.npmjs.org/:_authToken=...` flag overrides any token baked into `~/.npmrc` for this invocation. Without it, a stale non-publish token in `~/.npmrc` will win over the env var and you'll get `EOTP` even with a publish-capable token in `.env`.
- If your npm account enforces an OTP on top of a publish token, rerun with `npm publish --otp=<code>` (and the same `--_authToken` flag).
- After publish, the existing shell alias `codex='npx -y pando-proxy'` will pick up the new package version automatically.

## Files

Core implementation:

- `bin/pando-proxy.js` — Node shim that spawns Deno on the bundled/source entrypoint
- `src/main.ts` — CLI dispatch (wrapper / `serve` / `doctor`)
- `src/wrapper.ts` — Codex child-process wrapper + per-run proxy lifecycle
- `src/server.ts` — HTTP proxy for `/v1/responses`
- `src/upstream.ts` — upstream call + local `memory(...)` interception
- `src/prompt_view.ts` — request rewrite with working memory
- `src/memory_pipeline.ts`, `src/round_update.ts` — end-of-round update
- `src/chunking.ts`, `src/tool_results.ts` — source chunking
- `src/store.ts`, `src/memory_state.ts` — session state on disk
- `src/structured_model.ts` — small/overflow structured-model clients
- `src/codex_modes.ts`, `src/codex_request.ts`, `src/codex_events.ts` — Codex CLI shape & JSONL parsing
- `src/websocket_relay.ts` — relay used by interactive mode
- `src/config.ts`, `src/doctor.ts`, `src/logger.ts`, `src/metrics.ts`, `src/json.ts`, `src/hash.ts`, `src/replay.ts`

Design docs:

- `DESIGN_PRINCIPLES.md`
- `MEMORY_OPERATIONS.md`
- `REFERENCE.md`
- `CONTEXT_MEMORY_DESIGN.md`
- `LIVE_E2E.md`
