# pando-proxy Reference

This is the implementation reference for the current proxy behavior.

## Command Modes

Default mode wraps Codex:

```sh
npx -y pando-proxy [proxy options] [codex args...]
```

The wrapper starts one local proxy instance, runs `codex` with process-local provider overrides,
then shuts the proxy down when Codex exits. It does not edit Codex config files.

The wrapper uses three Codex execution paths:

- `exec-json`: for `codex exec` / `codex e`; injects `--json`, forwards stdout, and observes JSONL
  events.
- `interactive-remote`: for no args, normal interactive prompts, `resume`, and `fork`; starts
  `codex app-server`, places a local websocket relay in front of it, and runs the Codex TUI with
  wrapper-managed `--remote` pointed at the relay.
- `passthrough`: for utility commands such as `help`, `login`, `logout`, and `app-server`.

The classifier skips leading Codex global options such as `-c`, `--model`, `--sandbox`, `--cd`, and
their inline forms where Codex supports them. It treats top-level `--help`, `-h`, `--version`, and
`-V` as passthrough. Interactive mode rejects user-provided `--remote` because the websocket relay
must own that endpoint.

Proxy-owned commands are:

- `serve`: start only the local OpenAI-compatible proxy.
- `doctor`: check local prerequisites and upstream reachability when an `OPENAI_API_KEY` fallback is
  available.

Any first argument other than `serve` or `doctor` is treated as a Codex argument. This means `exec`,
`resume`, `help`, `app-server`, and future Codex commands are passed through.

## Wrapper Flags

Wrapper flags must appear before the first Codex argument.

| Flag                                | Default                | Behavior                                                              |
| ----------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `--proxy-host <host>`               | `127.0.0.1`            | Host for the local proxy.                                             |
| `--proxy-port-start <port>`         | `40123`                | First port to try; the wrapper increments until a free port is found. |
| `--proxy-upstream-base-url <url>`   | `auto`                 | Upstream base URL override.                                           |
| `--proxy-maintenance-model <model>` | incoming request model | Model used for internal memory maintenance calls.                     |
| `--proxy-state-dir <path>`          | `~/.pando-proxy`       | State, session, and auto-log root.                                    |
| `--proxy-no-memory`                 | memory enabled         | Bypass memory maintenance and prompt injection.                       |
| `--proxy-log`                       | off                    | Create a unique full JSONL log under `<state-dir>/logs`.              |
| `--proxy-log-file <path>`           | off                    | Write full JSONL logs to an explicit file.                            |
| `--proxy-help`, `--help`, `-h`      |                        | Show wrapper help.                                                    |

Everything after `--` is passed to Codex unchanged.

Examples:

```sh
npx -y pando-proxy exec "Help me with this repo"
npx -y pando-proxy e "Short alias for exec"
npx -y pando-proxy --model gpt-5.4 exec "Leading Codex globals are preserved"
npx -y pando-proxy exec --help
npx -y pando-proxy resume --last
npx -y pando-proxy help exec
npx -y pando-proxy app-server --listen ws://127.0.0.1:45123
```

## Serve and Doctor Flags

`serve` and `doctor` use the non-prefixed flags below:

| Flag                          | Default                | Behavior                                          |
| ----------------------------- | ---------------------- | ------------------------------------------------- |
| `--host <host>`               | `127.0.0.1`            | Host for the proxy server.                        |
| `--port <port>`               | `8787`                 | Fixed proxy port.                                 |
| `--upstream-base-url <url>`   | `auto`                 | Upstream base URL override.                       |
| `--maintenance-model <model>` | incoming request model | Model used for internal memory maintenance calls. |
| `--state-dir <path>`          | `~/.pando-proxy`       | State and session root.                           |
| `--no-memory`                 | memory enabled         | Bypass memory maintenance and prompt injection.   |
| `--log-file <path>`           | none                   | Enable full JSONL logging to an explicit file.    |

## Environment Variables

CLI flags take precedence over environment variables.

| Variable                             | Used by                | Behavior                                                               |
| ------------------------------------ | ---------------------- | ---------------------------------------------------------------------- |
| `PANDO_PROXY_HOST`                   | wrapper, serve, doctor | Host default.                                                          |
| `PANDO_PROXY_PORT`                   | serve, doctor          | Fixed port default.                                                    |
| `PANDO_PROXY_UPSTREAM_BASE_URL`      | all modes              | Upstream base URL default.                                             |
| `PANDO_PROXY_MAINTENANCE_MODEL`      | memory mode            | Maintenance model default.                                             |
| `PANDO_PROXY_STATE_DIR`              | all modes              | State root default.                                                    |
| `PANDO_PROXY_SYNTHETIC_CHAR_BUDGET`  | memory mode            | Max characters for injected `<context_memory>`. Default: `12000`.      |
| `PANDO_PROXY_MAINTENANCE_TIMEOUT_MS` | memory mode            | Timeout for each maintenance model call. Default: `60000`.             |
| `PANDO_PROXY_DISABLE_MEMORY`         | all modes              | Truthy values `1`, `true`, `yes`, `on` disable memory.                 |
| `PANDO_PROXY_LOG_FILE`               | all modes              | Enables logging to the given file.                                     |
| `OPENAI_API_KEY`                     | all modes              | Fallback auth only when Codex does not send an `Authorization` header. |

The supported path form `~/...` expands using `HOME`.

## Auth and Upstream Selection

The wrapper configures Codex with:

```toml
model_provider = "pando-proxy"
model_providers.pando-proxy = {
  name = "Pando Memory Proxy",
  base_url = "http://127.0.0.1:<port>/v1",
  wire_api = "responses",
  requires_openai_auth = true
}
```

Because `requires_openai_auth = true`, Codex sends its existing login or API-key authorization to
the proxy. The proxy forwards that `Authorization` header upstream and uses it for maintenance model
calls. `OPENAI_API_KEY` is only a fallback when no request authorization header exists.

When `--proxy-upstream-base-url` / `--upstream-base-url` is `auto`, the proxy chooses:

- `https://api.openai.com/v1` for bearer tokens that look like OpenAI API keys (`sk-...`),
- `https://chatgpt.com/backend-api/codex` otherwise, which is the Codex-login path.

## HTTP Surface

The proxy exposes:

- `GET /health`
- `GET /v1/health`
- `OPTIONS *`
- `POST /v1/responses`

All other routes return `404` JSON. `POST /v1/responses` requires a JSON object body.

## Request Flow

For each `POST /v1/responses` request:

1. The proxy parses the JSON body.
2. It derives auth from the incoming `Authorization` header or `OPENAI_API_KEY`.
3. If logging is enabled, it logs the inbound request.
4. If memory is disabled, it forwards the body upstream unchanged.
5. If memory is enabled, it locks the session, loads memory state, runs maintenance, saves changed
   state, injects synthetic memory, and forwards the rewritten request upstream.
6. The upstream response is streamed back to Codex.

## Session Keys and State Files

Session state is stored under:

```text
<state-dir>/sessions/<sanitized-session-key>_<hash>/
```

The session key is chosen in this order:

1. Headers: `x-pando-session-id`, `x-codex-session-id`, `x-openai-conversation-id`,
   `openai-conversation-id`.
2. Body fields: `conversation_id`, `session_id`, `conversation`, `prompt_cache_key`.
3. Metadata fields: `metadata.session_id`, `metadata.conversation_id`, `metadata.cwd`.
4. A fallback hash of `model` and `prompt_cache_key`.

Files in each session directory:

- `memory.snapshots.jsonl`: append-only memory snapshots.
- `handled-inputs.json`: IDs already processed by memory maintenance.

A per-session in-process lock serializes concurrent requests for the same session key.

## Current Memory Behavior

The current implementation eagerly maintains task-scoped memory and forwards a derived prompt view
instead of the full raw Codex transcript. It removes any prior synthetic memory item, keeps leading
`system`/`developer` messages, inserts the current synthetic `<context_memory>` item, then keeps
only the latest raw user turn and items after it. That preserves current-turn tool protocol while
dropping stale raw user/assistant history.

The memory pass:

- extracts user messages and tool outputs from the current request,
- extracts assistant responses from prior turns present in the current request,
- skips input IDs already recorded in `handled-inputs.json`,
- asks the maintenance model to update the live task list and retained user-message summaries,
- reviews unhandled assistant responses and creates task-linked assistant chunks only for durable
  information that still supports live tasks,
- chunks Pando tool results in code,
- chunks non-Pando tool results with batched maintenance model calls and, after one invalid retry,
  falls back to a conservative local chunk for each result,
- asks the maintenance model what chunks to retain,
- after one invalid retention retry, falls back to mechanically keeping chunks that reference live
  tasks or the active task,
- prunes retained messages/chunks to live task IDs.

Live tasks have:

- `id`
- `text`
- `status`: `open` or `in_progress`
- `kind`: `say` or `do`

Retained memory chunks include:

- `id`
- `title`
- `summary`
- `kind`
- `taskIds`
- optional `pointer`
- optional `source`: `tool`, `user`, or `assistant`

## Prompt Rewriting

When memory is enabled, upstream requests use `buildDerivedPrompt(..., { keepRawHistory: false })`.
The derived prompt:

1. Removes previous synthetic `<context_memory>` items.
2. Keeps leading `system` and `developer` messages.
3. Inserts the current synthetic memory item after those leading instructions.
4. Keeps the latest raw user message and any following protocol items.
5. Drops earlier raw user/assistant history from the upstream request.

When no latest user message can be found, the proxy keeps the input shape unchanged except for
synthetic-memory replacement. The canonical Codex transcript is not modified; this rewrite only
changes the request body forwarded upstream.

## Pando Tool Chunking

Known Pando MCP tools are chunked in code so maintenance calls do not need to reread full Pando
payloads. Analysis-style tools create item or pointer chunks. Mutation-style tools create a summary
chunk with changed paths when available.

Known Pando detection includes names prefixed with `pando__`, server label `pando`, and these tool
families:

- code search/reference tools such as `find_nodes`, `find_references`, `find_callers`, `query_db`,
  `analyze_imports`, and `list_exports`,
- workspace/schema/snapshot helpers,
- Clojure namespace graph helpers,
- modifying Pando operations such as `insert`, `replace`, `delete`, `rename`, `filter_map_reduce`,
  `restore_snapshot`, and namespace moves.

## Logging Contract

Logging is off by default. When enabled, logs are JSONL and intentionally generic: every event
writes the full fields supplied by the proxy, with no truncation in the logger.

Credential redaction is exact-field based only. These field names are replaced with `[redacted]`,
case-insensitively:

- `authorization`
- `proxy-authorization`
- `access_token`
- `refresh_token`
- `id_token`
- `api_key`
- `openai_api_key`
- `x-api-key`

There is no regex-based secret detection. Non-credential payload content is logged as-is.

Upstream streaming logs can end with either:

- `upstream_response_end`, when the stream flushes normally,
- `upstream_response_cancel`, when Codex stops reading before flush.

Wrapper observation events:

- `codex_exec_event`: one event per JSONL line observed from `codex exec --json`.
- `codex_app_server_frame`: one event per websocket frame relayed between the Codex TUI and
  `codex app-server`.
- `thread/tokenUsage/updated`: app-server token usage for interactive runs.
- `turn.completed`: exec-mode token usage when Codex emits it.

Passthrough utility commands may only emit wrapper lifecycle events because they often do not call
the model.

## Development

Useful local commands:

```sh
deno task check
deno task dev
deno task compile
npm pack --dry-run
```

`deno task check` runs formatting, linting, type checking, and unit tests.

The npm package entry point is `bin/pando-proxy.js`. `npm pack` runs the `prepack` script, which
bundles `src/main.ts` to `dist/main.js`.

## Publishing

The package is intended to be runnable as:

```sh
npx -y pando-proxy exec "Reply with exactly: ok"
```

Before publishing a changed package:

```sh
deno task check
npm version patch
npm publish --access public
npm view pando-proxy version
```

Then verify from outside the repo:

```sh
cd /tmp
npx -y pando-proxy@latest --proxy-help
```
