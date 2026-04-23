# Memory Operations

This document captures operational behavior that is easy to miss from the design doc alone.

## Wrapper Defaults

`pando-proxy` is a wrapper around the system `codex` command. A normal invocation:

```sh
npx -y pando-proxy exec "Help me with this repo"
```

does the following:

1. Starts a local proxy on `127.0.0.1`, beginning at port `40123` and incrementing until a free port
   is found.
2. Runs `codex` directly with process-local `-c` provider overrides pointing at that proxy.
3. Passes Codex arguments through unchanged after proxy-owned `--proxy-*` flags.
4. Shuts the proxy down when Codex exits and returns Codex's exit code.

The first non-proxy argument starts Codex passthrough. For example, `exec`, `resume`, `help exec`,
and `app-server` are Codex arguments, not proxy subcommands. The wrapper does not edit
`~/.codex/config.toml`.

Runtime shape:

- `exec` / `e`: the wrapper adds `--json` when missing, forwards stdout, and observes every JSONL
  event.
- interactive prompt / `resume` / `fork`: the wrapper starts `codex app-server` on loopback, starts
  a loopback websocket relay, then runs the Codex TUI with `--remote` pointed at the relay.
- utility commands: the wrapper runs Codex directly with the proxy provider overrides. These
  commands may not make a model request, so only wrapper lifecycle events may appear in logs.

Mode classification handles leading Codex global flags before the command. For example,
`pando-proxy --model gpt-5.4 exec "..."` still runs in `exec-json` mode. Interactive mode owns
`--remote`; passing a user `--remote` is an error because the wrapper must insert its websocket
relay.

## Logging

Logging is disabled by default. A normal wrapper invocation does not create a log file and does not
print a `Pando Proxy log:` line.

Enable full JSONL logging with one of:

```sh
npx -y pando-proxy --proxy-log exec "Logged run"
npx -y pando-proxy --proxy-log-file /tmp/pando-proxy.jsonl exec "Logged run"
```

`--proxy-log` creates a unique file under `~/.pando-proxy/logs`. `--proxy-log-file` writes to the
specified path.

When logging is enabled, request and response payloads are logged as received. Only explicit
credential fields are redacted:

- `authorization`
- `proxy-authorization`
- `access_token`
- `refresh_token`
- `id_token`
- `api_key`
- `openai_api_key`
- `x-api-key`

Do not use content regex scans to decide whether a log is safe. Upstream events can legitimately
contain opaque encrypted payloads or schema text with token-like substrings.

Mode-specific log events:

- `codex_exec_event`: observed JSONL events from `codex exec --json`.
- `codex_app_server_frame`: websocket frames relayed between the TUI and `codex app-server`.
- `thread/tokenUsage/updated`: app-server token usage for interactive runs.
- `wrapper_start`, `wrapper_codex_start`, and `wrapper_exit`: lifecycle events for all modes.

## Memory Pipeline Events

The memory pass runs before forwarding each Codex model request upstream. With logging enabled,
memory events are prefixed with `memory_`.

Important events:

- `memory_pass_start`: prior state IDs and handled input IDs.
- `memory_inputs_extracted`: user message IDs, assistant response IDs, and tool result metadata
  extracted from the Codex request.
- `memory_user_message_skipped`: a user message was already handled in this session.
- `memory_task_update_start`: task update begins for one new user message.
- `memory_task_update_model_request`: compact metadata for the maintenance task-update call.
- `memory_task_update_model_response`: task IDs, actions, and kept/dropped message actions returned
  by the maintenance model.
- `memory_task_update_model_error`: maintenance task-update call failed.
- `memory_task_update_applied`: ID diffs after applying a valid task update.
- `memory_assistant_responses_none`: no unhandled assistant responses were present.
- `memory_assistant_responses_start`: unhandled assistant responses will be reviewed.
- `memory_assistant_memory_model_request`: compact metadata for the assistant-response review call.
- `memory_assistant_memory_model_response`: assistant chunk metadata returned by the maintenance
  model.
- `memory_assistant_memory_model_error`: assistant-response review call failed.
- `memory_assistant_chunks_created`: assistant chunk IDs and compact chunk metadata.
- `memory_assistant_retention_start`: existing, inbox, and candidate chunk IDs for assistant
  retention.
- `memory_assistant_retention_applied`: final kept and dropped chunk IDs after assistant retention.
- `memory_tool_results_none`: no unhandled tool outputs were present.
- `memory_tool_results_start`: unhandled tool outputs will be chunked.
- `memory_chunk_batch_model_request`: compact metadata for non-pando chunking.
- `memory_chunk_batch_model_response`: chunk metadata returned by the chunking model.
- `memory_chunk_batch_model_error`: chunking model call failed.
- `memory_chunks_created`: chunk IDs and compact chunk metadata. The log does not duplicate chunk
  summaries/content here because full request bodies are already logged elsewhere.
- `memory_retention_start`: existing, inbox, and candidate chunk IDs.
- `memory_retention_model_request`: retention candidate IDs and compact metadata.
- `memory_retention_model_response`: keep/drop chunk IDs returned by the retention model.
- `memory_retention_model_error`: retention model call failed.
- `memory_retention_applied`: final kept and dropped chunk IDs.
- `memory_pass_end`: final state IDs and whether the pass changed memory.
- `memory_state_saved`: persisted state IDs and handled input IDs.
- `memory_state_unchanged`: pass completed without a state change.

These events intentionally use IDs and compact metadata for memory internals. The full upstream
request and response logs contain the raw transcript/tool payloads when logging is enabled.

Searchable metrics events use the `pando_proxy_metrics_` event prefix and include
`marker: "PANDO_PROXY_METRICS"`:

- `pando_proxy_metrics_incoming_context`: raw inbound request size, approximate input tokens, model,
  input item counts, message counts, and tool call/output counts.
- `pando_proxy_metrics_memory_state`: task, retained user-message, memory chunk, handled-input, and
  approximate memory-state token counts after maintenance.
- `pando_proxy_metrics_rewritten_context`: raw versus rewritten approximate input tokens and input
  item counts after memory prompt injection/history dropping.
- `pando_proxy_metrics_upstream_response`: upstream response bytes, approximate output tokens, and,
  when the Responses API stream includes `usage`, actual input/output/total token usage plus
  in-process cumulative usage for the session. This event is emitted on normal stream end and
  best-effort on stream cancel, with `termination: "end" | "cancel"`.

## Classification Call Flow

The proxy does not ask the main work model to classify memory. Before every upstream Codex model
request, the memory manager extracts inputs from the request and makes separate Responses calls
through the same upstream/auth path Codex is already using:

1. User messages call `task_update`, which creates, keeps, merges, completes, or drops live tasks
   and decides which user-message summaries remain attached to those tasks.
2. Assistant messages from previous turns call `assistant_memory`, which decides whether any durable
   assistant output should become task-linked memory chunks.
3. Non-Pando tool outputs call `chunk_batch`, which receives live tasks, retained user-message
   summaries, tool metadata, and JSON-parsed output when possible. It should split structured
   collections such as search results, arrays, rows, match sets, grouped errors, or keyed object
   maps into semantic task-linked chunks when those items may be retained or dropped independently.
   If the preview is too thin to choose boundaries, it can request `tool_result` or
   `all_tool_results` once. Pando tool outputs are chunked deterministically in code by tool/result
   shape instead.
4. Assistant and tool chunks then call `retention_decision`, which keeps only chunks still useful
   for live tasks.

Maintenance transport failures and upstream 5xx responses are retried once as transport retries.
They are not converted into validation-repair attempts. If the retry still fails, the proxy returns
`pando_proxy_failed`.

The order is deliberate: user-message task updates run first, assistant-response review runs next,
and tool-output chunking runs after that. This lets a new user message such as "nevermind, do X"
drop old tasks before assistant or tool output is classified and retained.

Task update, assistant-response review, and non-Pando tool chunking use the same two-step contract:

1. The first maintenance call receives the minimal normal payload for that classifier and
   `infoRequestAttempt: false`.
2. It must either return the final structured decision with `needsMoreInfo: false`, or request more
   data with `needsMoreInfo: true` and `requestedInfo`.
3. If it requests data, the proxy materializes the requested data into `extraContext` and makes one
   second call with `infoRequestAttempt: true`.
4. The second call must return the final decision. A second request for more data fails the
   maintenance pass with a clear error.

Supported `requestedInfo` types are:

- task/user context: `live_tasks`, `kept_user_messages`
- retained memory: `all_memory_chunks`, `memory_chunk`, `assistant_chunks`, `tool_chunks`
- tool outputs: `all_tool_results`, `tool_result`
- assistant output: `all_assistant_responses`, `assistant_response`

## Assistant Response Review

Assistant responses are reviewed on the next inbound request, after user-message task updates run.
That timing lets the latest user message drop or replace old tasks before assistant output is
considered. The assistant-memory maintenance call can create chunks only for durable information
that still supports live tasks, such as decisions, implementation facts, test results, unresolved
errors, or explicit next steps.

The assistant-memory first call receives live tasks, `activeTaskId`, retained user-message
summaries, unhandled assistant response text/previews from prior turns, and empty `extraContext`. It
is asked to keep only durable task-relevant assistant facts. If the assistant text refers to prior
tool output, retained chunks, or earlier assistant output and the preview is not enough, it can
request that data once. The second call receives the requested data and must produce final assistant
chunks or no chunks.

Generic assistant narration, repeated user instructions, and assistant output for completed or
dropped tasks should produce no chunks. Any assistant chunks that are created are passed through the
same eager retention step as tool-result chunks.

## Maintenance Model Calls

Maintenance calls use the same upstream auth that Codex sends to the proxy. For Codex login auth,
the upstream backend currently requires:

- a top-level `instructions` field for the maintenance system prompt,
- `stream: true`,
- `text.format` JSON-schema structured outputs,
- SSE response parsing.

By default, maintenance calls do not use the user's main Codex model. The binary uses `gpt-5.4-mini`
for normal ChatGPT/Codex maintenance payloads and switches to `gpt-5.4` only when the estimated
input would exceed the small-model context window. `--proxy-maintenance-model` and
`PANDO_PROXY_MAINTENANCE_MODEL` can force only `small`/`gpt-5.4-mini` or `large`/`gpt-5.4`; no other
maintenance models are accepted.

The maintenance parser accepts both normal JSON Responses API payloads and SSE payloads. It treats a
body as SSE when either the content type is `text/event-stream` or the body starts with `event:` /
`data:`. This matters because Codex-login upstreams can stream SSE without a clean event-stream
content type.

## Stream Termination

The proxy logs upstream streaming in chunks:

- `upstream_response_start`
- `upstream_response_chunk`
- `upstream_response_end`

If Codex stops reading early after receiving enough output, the stream transform may be cancelled
instead of flushed. In that case the terminal event is:

- `upstream_response_cancel`

Live log checks should accept either `upstream_response_end` or `upstream_response_cancel` as the
terminal stream event.

## Retention Behavior

Retention is eager. Chunks created from completed or no-longer-live tasks can be dropped
immediately. This is expected.

If a live E2E test needs to prove persisted memory across `codex resume`, the first turn must create
an ongoing task that makes the chunk useful for the next turn. Otherwise retention may correctly
drop the chunk before the resume test.

## Derived Prompt Rewrite

The rewrite step builds a derived prompt view before forwarding upstream. It removes any prior
synthetic memory item, keeps leading `system`/`developer` messages, inserts the latest
`<context_memory>` item after those instructions, then keeps only the latest raw user turn and items
after it. That keeps current-turn tool-call/tool-output protocol items while dropping stale raw
transcript history.

`buildDerivedPrompt(..., { keepRawHistory: true })` preserves the old pass-through raw-history shape
for callers that explicitly need it, but the proxy uses `keepRawHistory: false` by default when
memory is enabled.

The rewrite does not edit Codex's canonical session transcript. It only changes the upstream model
request for the current turn.

## Useful Live Coverage

The live memory tests should cover these distinct paths:

- no-tool task update only,
- stderr-only shell output,
- empty shell output,
- JSON-shaped shell output,
- multiple tool calls in one user request,
- assistant response review on the next user request,
- long single-line tool output,
- pando deterministic chunking, for example `workspace_overview`, `find_nodes`, and
  `get_project_root`,
- stream cancellation as well as normal stream completion,
- resume with handled input skipping,
- resume with retained chunks loaded from persisted state.

## Mode E2E Coverage

A minimal live wrapper matrix should run two invocations for each mode:

- `exec-json`: one memory-disabled transport check and one memory-enabled check with a separate
  state dir.
- `interactive-remote`: one memory-disabled TUI/app-server relay check and one memory-enabled check
  with a separate state dir.
- `passthrough`: two utility commands, such as `help exec` and `--version`, to prove argument
  forwarding and lifecycle logging.

For model-call modes, verify both directions: the request reaches the proxy and the expected agent
message comes back. For passthrough utility commands, verify Codex output plus `wrapper_exit` with
exit code `0`.
