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

| Flag                                      | Default          | Behavior                                                              |
| ----------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `--proxy-host <host>`                     | `127.0.0.1`      | Host for the local proxy.                                             |
| `--proxy-port-start <port>`               | `40123`          | First port to try; the wrapper increments until a free port is found. |
| `--proxy-upstream-base-url <url>`         | `auto`           | Upstream base URL override.                                           |
| `--proxy-maintenance-model <small/large>` | auto small/large | Force one of the two built-in maintenance models.                     |
| `--proxy-state-dir <path>`                | `~/.pando-proxy` | State, session, and auto-log root.                                    |
| `--proxy-no-memory`                       | memory enabled   | Bypass memory maintenance and prompt injection.                       |
| `--proxy-log`                             | off              | Create a unique full JSONL log under `<state-dir>/logs`.              |
| `--proxy-log-file <path>`                 | off              | Write full JSONL logs to an explicit file.                            |
| `--proxy-help`, `--help`, `-h`            |                  | Show wrapper help.                                                    |

Everything after `--` is passed to Codex unchanged.

On the first wrapper run, pando-proxy records local wrapper preferences under
`~/.pando-proxy/wrapper-preferences.json`. On the second interactive wrapper run, if no previous
answer is recorded, it asks whether to add a shell alias so `codex` expands to `npx -y pando-proxy`.
A yes or no answer is saved in that preferences file and is not asked again. When accepted, the
wrapper appends a marked alias block to the detected shell startup file, such as `~/.zshrc`,
`~/.bash_profile`, `~/.bashrc`, `~/.config/fish/config.fish`, or the PowerShell profile.

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

| Flag                                | Default          | Behavior                                          |
| ----------------------------------- | ---------------- | ------------------------------------------------- |
| `--host <host>`                     | `127.0.0.1`      | Host for the proxy server.                        |
| `--port <port>`                     | `8787`           | Fixed proxy port.                                 |
| `--upstream-base-url <url>`         | `auto`           | Upstream base URL override.                       |
| `--maintenance-model <small/large>` | auto small/large | Force one of the two built-in maintenance models. |
| `--state-dir <path>`                | `~/.pando-proxy` | State and session root.                           |
| `--no-memory`                       | memory enabled   | Bypass memory maintenance and prompt injection.   |
| `--log-file <path>`                 | none             | Enable full JSONL logging to an explicit file.    |

## Environment Variables

CLI flags take precedence over environment variables.

| Variable                             | Used by                | Behavior                                                               |
| ------------------------------------ | ---------------------- | ---------------------------------------------------------------------- |
| `PANDO_PROXY_HOST`                   | wrapper, serve, doctor | Host default.                                                          |
| `PANDO_PROXY_PORT`                   | serve, doctor          | Fixed port default.                                                    |
| `PANDO_PROXY_UPSTREAM_BASE_URL`      | all modes              | Upstream base URL default.                                             |
| `PANDO_PROXY_MAINTENANCE_MODEL`      | memory mode            | Force `small` or `large` maintenance model.                            |
| `PANDO_PROXY_STATE_DIR`              | all modes              | State root default.                                                    |
| `PANDO_PROXY_SYNTHETIC_CHAR_BUDGET`  | memory mode            | Max characters for injected `<context_memory>`. Default: `12000`.      |
| `PANDO_PROXY_MAINTENANCE_TIMEOUT_MS` | memory mode            | Timeout for each maintenance model call. Default: `60000`.             |
| `PANDO_PROXY_DISABLE_MEMORY`         | all modes              | Truthy values `1`, `true`, `yes`, `on` disable memory.                 |
| `PANDO_PROXY_LOG_FILE`               | all modes              | Enables logging to the given file.                                     |
| `OPENAI_API_KEY`                     | all modes              | Fallback auth only when Codex does not send an `Authorization` header. |

The supported path form `~/...` expands using `HOME`.

Default maintenance model selection is fixed in the binary:

| Model          | Approx input window | Use                                                                        |
| -------------- | ------------------- | -------------------------------------------------------------------------- |
| `gpt-5.4-mini` | `272000` tokens     | Default for ChatGPT/Codex maintenance calls.                               |
| `gpt-5.4`      | `1000000` tokens    | Used when estimated maintenance input would exceed the small-model window. |

The estimate is character based and reserves output space. `PANDO_PROXY_MAINTENANCE_MODEL` or
`--proxy-maintenance-model` accepts only `small`, `large`, `gpt-5.4-mini`, or `gpt-5.4`; any value
outside those two built-in model choices fails before making the maintenance call.

## Auth and Upstream Selection

The wrapper configures Codex with process-local `-c` overrides equivalent to:

```sh
codex \
  -c 'model_provider="pando-proxy"' \
  -c 'model_providers.pando-proxy.name="Pando Memory Proxy"' \
  -c 'model_providers.pando-proxy.base_url="http://127.0.0.1:<port>/v1"' \
  -c 'model_providers.pando-proxy.wire_api="responses"' \
  -c 'model_providers.pando-proxy.requires_openai_auth=true' \
  ...
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
`system`/`developer` messages, inserts the current synthetic `<context_memory>` item, keeps the
latest raw user turn, and preserves only the still-needed tail of the current protocol state.
Older handled assistant/tool protocol segments are dropped once retained memory covers them.

The memory pass:

- extracts user messages and tool outputs from the current request,
- extracts assistant responses from prior turns present in the current request,
- skips input IDs already recorded in `handled-inputs.json`,
- asks the maintenance model to update the live task list and retained user-message summaries,
- reviews unhandled assistant responses and creates task-linked assistant chunks only for durable
  information that still supports live tasks,
- chunks Pando tool results in code,
- chunks non-Pando tool results with batched maintenance model calls. The chunking payload includes
  live tasks, active task, retained user-message summaries, tool metadata, and JSON-parsed output
  when possible so structured outputs can be split into semantic retention units. Search/list
  outputs, arrays, rows, match sets, grouped errors, and keyed object maps should usually become
  small independently retainable chunks. If the preview is insufficient, the model can request
  `tool_result` or `all_tool_results` once; invalid final output fails the request with a
  `pando_proxy_failed` error,
- asks the maintenance model what chunks to retain,
- invalid final retention output fails the request with a `pando_proxy_failed` error,
- prunes retained messages/chunks to live task IDs.

The task-update, assistant-memory, and non-Pando chunking calls each allow at most one model request
for more data. The first call receives the minimal normal classifier payload and can return either a
final decision or `needsMoreInfo: true` with `requestedInfo`. If it asks for data, the proxy
supplies actual requested items in `extraContext` and makes one second call. The second call must
return the final decision.

Maintenance transport failures and upstream 5xx responses are retried once as transport retries.
They are not converted into validation-repair attempts. If the retry still fails, the proxy returns
`pando_proxy_failed`.

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
4. Keeps the latest raw user message.
5. Preserves unfinished protocol state for the current tool cycle.
6. Drops older handled assistant/tool protocol segments whose substance is already represented in
   retained memory.
7. Drops earlier raw user/assistant history from the upstream request.

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

Every JSONL event includes an ISO timestamp in `ts`. Searchable state/size metrics use event names
starting with `pando_proxy_metrics_` and include `marker: "PANDO_PROXY_METRICS"`.

Current metrics events:

- `pando_proxy_metrics_incoming_context`
- `pando_proxy_metrics_memory_state`
- `pando_proxy_metrics_rewritten_context`
- `pando_proxy_metrics_upstream_response`

These log approximate context token counts from request/body size. When upstream Responses events
include a `usage` object, `pando_proxy_metrics_upstream_response` also logs actual usage and
in-process cumulative session usage. It includes `termination: "end"` or `"cancel"`.

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
