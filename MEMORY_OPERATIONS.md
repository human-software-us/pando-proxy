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
- utility commands: the wrapper runs Codex directly with the proxy provider overrides.

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

## Assistant Response Review

Assistant responses are reviewed on the next inbound request, after user-message task updates run.
That timing lets the latest user message drop or replace old tasks before assistant output is
considered. The assistant-memory maintenance call can create chunks only for durable information
that still supports live tasks, such as decisions, implementation facts, test results, unresolved
errors, or explicit next steps.

Generic assistant narration, repeated user instructions, and assistant output for completed or
dropped tasks should produce no chunks. Any assistant chunks that are created are passed through the
same eager retention step as tool-result chunks.

## Maintenance Model Calls

Maintenance calls use the same upstream auth that Codex sends to the proxy. For Codex login auth,
the upstream backend currently requires:

- a top-level `instructions` field for the maintenance system prompt,
- `stream: true`,
- SSE response parsing.

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
