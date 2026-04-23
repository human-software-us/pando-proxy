# Context Memory Design

## Product Deliverable

This repository's deliverable is a standalone local proxy binary named `pando-proxy`.

It is not a reusable memory library, a Codex fork, an MCP memory server, or a hosted backend service. The product is one self-contained local executable that stock Codex can use as an OpenAI-compatible model provider.

Implement the app in Deno + TypeScript. Library-shaped modules are allowed only as internal implementation units of the binary, for example under `src/`. They must not be designed, packaged, or documented as a separate public SDK or as the primary deliverable.

The memory design below exists to serve that proxy. All task update, tool chunking, retention, prompt injection, snapshot persistence, wrapper launch, and upstream forwarding behavior must be wired through the local proxy request path and CLI.

## Current Repository Status

The current implementation is the no-source-change proxy/wrapper path:

- `pando-proxy [codex args...]` starts a per-instance localhost proxy, then runs the system `codex` command with process-local provider overrides.
- It does not edit `~/.codex/config.toml`.
- `exec` / `e` run through `exec-json` mode, where the wrapper injects `--json` and observes Codex JSONL events.
- No-arg interactive use, prompt arguments, `resume`, and `fork` run through `interactive-remote` mode, where the wrapper starts `codex app-server`, inserts a websocket relay, and launches the normal Codex TUI against that relay.
- Utility commands such as `help`, `--version`, `login`, `logout`, `mcp`, and `app-server` run in passthrough mode.
- Logging is disabled by default. When enabled, JSONL logs include timestamps and full request/response payloads except exact credential fields.
- Memory-enabled requests use a derived prompt view with `keepRawHistory: false`, so stale raw
  prior user/assistant history and older handled assistant/tool protocol segments are removed from
  the upstream request while Codex's canonical transcript remains untouched.

## Goal

Inside the `pando-proxy` binary, keep context useful without letting it accumulate. Every user message, useful prior assistant response, and every tool result must be explicitly handled before the next work turn:

- update the task list from the latest user message,
- review assistant responses for durable facts that still support live tasks,
- chunk every tool result, whether it came from MCP or a native tool,
- keep only chunks that are still needed for live tasks,
- drop everything else immediately.

This replaces the older inbox/library/GC/node model with a task-only model. There are no node ids and no decomposition ownership.

## Core State

```ts
type MemoryState = {
  taskUpdateSeq: number;
  tasks: Task[];
  activeTaskId: string | null;
  keptUserMessages: UserMessageMemory[];
  memoryLibrary: MemoryChunk[];
};

type Task = {
  id: string;
  text: string;
  status: "open" | "in_progress";
  kind: "say" | "do";
};

type UserMessageMemory = {
  messageId: string;
  summary: string;
  taskIds: string[];
};

type MemoryChunk = {
  id: string;
  title: string;
  summary: string;
  kind: string;
  taskIds: string[];
  pointer?: object;
  source?: "tool" | "user" | "assistant";
};
```

Invariant: anything retained must have at least one live `taskId`.

## Task Update

After every new user message, the model must produce a complete task update. It must not rely on implicit "same as before" behavior.

```ts
type TaskUpdate = {
  taskUpdateSeq: number;
  latestUserMessageId: string;
  result: "changed" | "same_as_before";
  tasksAfter: Task[];
  activeTaskId: string | null;
  existingTaskActions: Array<{
    id: string;
    action: "keep" | "drop" | "complete" | "merge_into";
    mergeInto?: string;
  }>;
  userMessageActions: Array<{
    messageId: string;
    action: "keep" | "drop";
    taskIds?: string[];
    summary?: string;
  }>;
};
```

Failsafe validation:

- `taskUpdateSeq` must equal `previous.taskUpdateSeq + 1`.
- `latestUserMessageId` must match the actual new user message.
- Every previous live task must appear in `existingTaskActions`.
- Every kept user message must have live `taskIds`.
- `tasksAfter` must be complete, ordered, and contain all live tasks after applying the update.
- If nothing changes, the model still returns `result: "same_as_before"`, the full `tasksAfter`, and the incremented sequence.

If validation fails, retry once with the validation errors. If it fails again, stop before the next work turn.

## Tool Result Chunking

All tools, MCP or native, are normalized into one envelope:

```ts
type ToolResultEnvelope = {
  origin: "mcp" | "native";
  toolName: string;
  serverName?: string;
  params?: object;
  content: unknown;
  activeTaskId: string | null;
};
```

Then every envelope is chunked.

### Pando Tools

Pando results are chunked in code because their shapes are known. This applies whether pando is consumed through MCP or exposed as a native tool.

Rules:

- `find_nodes`: one chunk per node match.
- `find_references`: one chunk per reference.
- `find_callers`: one chunk per caller.
- other `find_*`, `list_*`, and analysis-style pando tools: one chunk per result row/item.
- mutating pando tools: one compact operation-summary chunk, plus changed paths when available.
- large/omitted result sets get pointer chunks for pagination or retrieval.

Pando chunks should be pointer-heavy and compact; the model can re-query details later.

### Non-Pando Tools

Non-pando content is chunked by a smaller model because arbitrary command output, file reads, web results, and MCP tools do not have one stable schema.

Batching is preferred when possible:

```ts
type BatchChunkRequest = {
  tasks: Task[];
  activeTaskId: string | null;
  keptUserMessages: UserMessageMemory[];
  results: ToolResultEnvelope[];
};

type BatchChunkResponse = {
  chunks: Array<{
    sourceResultIndex: number;
    title: string;
    summary: string;
    kind: string;
    taskIds: string[];
    pointer?: object;
  }>;
};
```

The chunking model receives the live task list, active task, compact retained user-message
summaries, tool names/params, and JSON-parsed tool output when possible. Its job is to choose
semantic retention units, not just summarize each whole result. Search results, arrays, rows, match
sets, and other independently useful structured items should usually become separate small chunks or
small related groups. A single larger chunk is appropriate for one coherent artifact or short command
output. When unsure, prefer more small task-linked chunks over one broad chunk so retention can keep
only the few useful items later.

Task updates, assistant-response review, and non-pando tool chunking share a bounded two-step
maintenance contract. The first call gets the minimal normal payload and may either return the final
structured decision or set `needsMoreInfo: true` with `requestedInfo`. The proxy then materializes
that requested data into `extraContext` and makes exactly one second call. The second call must
return the final structured decision; another data request is an error. The model is instructed to
err toward requesting more rather than less because it has only one chance.

Batching saves latency, not tokens. If the combined raw content is too large, split by size and run multiple batches.

## Retention

There is no delayed GC threshold. Retention runs eagerly after chunking and considers both new chunks and already-kept chunks.

```ts
type RetentionDecision = {
  keep: Array<{ id: string; taskIds: string[] }>;
  drop: string[];
};
```

Validation:

- Every candidate chunk id appears exactly once in `keep` or `drop`.
- Every kept chunk has at least one live `taskId`.
- No kept chunk may reference dropped, completed, or missing tasks.

The transient inbox is only an in-memory list inside the current maintenance pass. It is never durable and must be empty before the next work turn.

## Pseudocode

```ts
async function onNewUserMessage(message, state) {
  const update = await taskUpdateLLM({
    previousSeq: state.taskUpdateSeq,
    latestUserMessage: message,
    tasks: state.tasks,
    keptUserMessages: state.keptUserMessages,
  });

  validateTaskUpdate(update, state, message);

  state.taskUpdateSeq = update.taskUpdateSeq;
  state.tasks = update.tasksAfter;
  state.activeTaskId = update.activeTaskId;
  state.keptUserMessages = applyUserMessageActions(
    state.keptUserMessages,
    message,
    update.userMessageActions,
  );

  pruneMemoryToLiveTasks(state);
}

async function afterToolResults(rawResults, state) {
  const envelopes = rawResults.map((result) => normalizeToolResult(result, state));
  const pando = envelopes.filter(isPandoResult);
  const nonPando = envelopes.filter((result) => !isPandoResult(result));

  const inbox = [
    ...pando.flatMap((result) => chunkPandoInCode(result)),
    ...await chunkNonPandoInBatches(nonPando, state.tasks, state.activeTaskId),
  ];

  const candidates = [...state.memoryLibrary, ...inbox];
  const decision = await retentionLLM({
    tasks: state.tasks,
    activeTaskId: state.activeTaskId,
    candidates,
  });

  validateRetention(decision, candidates, state.tasks);
  state.memoryLibrary = applyRetention(candidates, decision);
  pruneMemoryToLiveTasks(state);
}
```

## Rationale

Task-only ownership removes the hardest ambiguity from the old design. A chunk is useful only if it supports a live task. When the task list changes, memory pruning becomes mechanical.

The task update step is required and sequence-checked because stale classifier output is dangerous. Even when the user says something that changes nothing, the system gets a fresh, validated `same_as_before` response with a new sequence number.

Pando chunking stays in code because pando result formats are controlled. Non-pando chunking uses a model because arbitrary tool output needs semantic judgment. Running that model in batches keeps latency reasonable while preserving the simpler rule that every result is chunked.

Eager retention trades extra model calls for simpler behavior: no growing inbox, no separate GC mode, no thresholds, and no stale context waiting around until the system is under pressure.

## Implementation Pointers

Useful current pando-extension references:

- `/Users/george/Documents/GitHub/pando-extension/src/extension/chat/toolChunking.ts`
  - Existing deterministic chunking for pando results, file reads, shell output, patches, generic arrays, and oversize placeholders.
  - This is the best starting point for the in-code pando chunker.
- `/Users/george/Documents/GitHub/pando-extension/src/extension/chat/ChatController.ts`
  - Existing call site that normalizes tool results, invokes `chunkToolResult`, uploads oversize chunks, and appends `tool_result_chunk` events.
- `/Users/george/Documents/GitHub/pando-extension/src/extension/threads/threadEventTypes.ts`
  - Existing thread event names, including `TOOL_RESULT_CHUNK`, `MEMORY_ACTION`, and `LIBRARY_ACTION`.
- `/Users/george/Documents/GitHub/pando-extension/tests/extension/chat/toolChunking.test.ts`
  - Existing tests for chunking behavior.

Useful historical pando-backend references:

- `/Users/george/Documents/GitHub/pando-backend/src/app/api/llm/orchestrator.ts`
  - Historical implementation of request classification, task replacement/append decisions, memory triage calls, and tool-result ingestion.
  - In the current backend history, the richer orchestrator code was removed by `47a09f4 Switch backend to prompt-only flow`; recover the old version with `git show 47a09f4^:src/app/api/llm/orchestrator.ts`.
- `/Users/george/Documents/GitHub/pando-backend/src/lib/orchestrator/memoryManager.ts`
  - Historical inbox/library manager. Use only as a reference for validation and retention mechanics; do not port node ids or threshold GC.
  - Recover with `git show 47a09f4^:src/lib/orchestrator/memoryManager.ts`.
- `/Users/george/Documents/GitHub/pando-backend/src/lib/orchestrator/stateMachine.ts`
  - Historical task classification and scope-change state transitions. Use only as a reference for task-list update semantics; do not port decomposition or node state.
  - Recover with `git show 47a09f4^:src/lib/orchestrator/stateMachine.ts`.
- `/Users/george/Documents/GitHub/pando-backend/src/lib/orchestrator/promptAssembler.ts`
  - Historical prompts for classification and memory triage. Useful for wording, but the new design should use the stricter `TaskUpdate` and eager retention contracts in this document.
  - Recover with `git show 47a09f4^:src/lib/orchestrator/promptAssembler.ts`.

## Codex-Main Implementation Entry Points

Best low-conflict shape: add a new `codex-rs/core/src/context_memory/` module that owns task updates, tool-result envelopes, pando chunking, retention validation, and memory-state persistence. Touch existing code only at narrow adapter hooks in `codex-rs/core/src/codex.rs`, plus the rollout type/policy if memory snapshots are persisted in the existing session log.

1. User-message ingress and task update
   - `codex-rs/core/src/codex.rs`: `submission_loop()` handles `Op::UserInput` and `Op::UserTurn` before input is either injected into an active task or used to spawn `AgentTask::spawn()`. This is the central hook for `onNewUserMessage`: it sees every frontend path and still has the submission id for `latestUserMessageId`.
   - `codex-rs/protocol/src/protocol.rs`: `Op::{UserInput, UserTurn}` and `InputItem` are the core input shapes.
   - Frontend adapters feed those ops: `codex-rs/tui/src/chatwidget.rs::submit_user_message()`, `codex-rs/exec/src/lib.rs`, `codex-rs/cli/src/proto.rs`, and `codex-rs/mcp-server/src/codex_message_processor.rs::{send_user_message, send_user_turn}`. Avoid putting memory logic here; use them only for tests or protocol coverage.

2. LLM turn finalization and eager retention
   - `codex-rs/core/src/codex.rs`: `try_run_turn()` returns only after `ResponseEvent::Completed`, and `run_task()` then records assistant/tool output and decides whether to continue with tool responses or emit `TaskComplete`.
   - Run eager tool chunking/retention in `run_task()` immediately after a successful `run_turn()` and after `ProcessedResponseItem` values are available, before the `responses.is_empty()` break/continue decision. This guarantees retention runs before the next model work turn that consumes tool outputs.
   - `TaskComplete` is emitted at the end of `run_task()` after `sess.remove_task(&sub_id)`; it is useful for observability but too late as the only retention hook because multi-tool loops may already have continued.

3. Tool call and result representation
   - `codex-rs/protocol/src/models.rs`: model output uses `ResponseItem::{FunctionCall, LocalShellCall, CustomToolCall}`; tool responses use `ResponseInputItem::{FunctionCallOutput, McpToolCallOutput, CustomToolCallOutput}` and are recorded back as `ResponseItem::*Output`.
   - `codex-rs/core/src/codex.rs`: `handle_response_item()` dispatches tool calls; `handle_function_call()` routes native functions, MCP fallthrough, and plan/update tools; `handle_container_exec_with_params()` and `format_exec_output()` shape native shell/apply_patch outputs.
   - `codex-rs/core/src/mcp_tool_call.rs`: `handle_mcp_tool_call()` emits `McpToolCallBegin/End` events and returns `ResponseInputItem::McpToolCallOutput`.
   - `codex-rs/core/src/exec.rs`, `codex-rs/core/src/exec_command/`, and `codex-rs/core/src/plan_tool.rs` cover native exec, streamable exec, stdin writes, and plan updates.

4. Pando MCP flow
   - `codex-rs/core/src/mcp_connection_manager.rs`: configured MCP servers are started, tools are listed, and tool names are qualified as `<server>__<tool>`.
   - `codex-rs/core/src/openai_tools.rs`: `get_openai_tools()` converts those MCP tools into OpenAI function schemas.
   - `codex-rs/core/src/codex.rs`: pando calls arrive as `ResponseItem::FunctionCall { name: "pando__find_nodes", ... }` or equivalent configured server name, then fall through `handle_function_call()` to `McpConnectionManager::parse_tool_name()`.
   - `codex-rs/core/src/mcp_tool_call.rs`: the deterministic pando chunker can hook after the `CallToolResult` is available. Prefer keeping final envelope creation in the new context-memory module and detecting pando by `(server, tool)` there, so the same code also works if pando is later exposed as a native tool.

5. Conversation/session state persistence
   - In-memory state lives in `codex-rs/core/src/codex.rs::State`, especially `history: ConversationHistory` and current task/pending input fields. Add in-memory `MemoryState` beside this state or behind a small `ContextMemoryManager`.
   - Durable session state is the rollout JSONL handled by `codex-rs/core/src/rollout/recorder.rs`; persisted item types live in `codex-rs/protocol/src/protocol.rs::RolloutItem`, and filtering is in `codex-rs/core/src/rollout/policy.rs`.
   - Best durable design is a compact snapshot item such as `RolloutItem::ContextMemorySnapshot(...)` containing `taskUpdateSeq`, live tasks, kept user messages, and memory library. A full snapshot after each validated task update/retention pass makes resume and fork reconstruction simple because `ConversationManager::resume_conversation_from_rollout()` and `fork_conversation()` already replay or truncate rollout items.
   - `codex-rs/core/src/message_history.rs` is only cross-session prompt history for UI recall; it should not store task memory.

6. Abstractions to reuse
   - `codex-rs/core/src/client_common.rs::Prompt`, `ModelClient::stream()` in `codex-rs/core/src/client.rs`, and `ResponseEvent` already provide model-call plumbing for tool-free maintenance calls.
   - `codex-rs/core/src/codex.rs::TurnContext` carries the active `ModelClient`, cwd, approval/sandbox policy, instructions, and `ToolsConfig`; pass only the fields the memory module needs.
   - `codex-rs/core/src/openai_tools.rs::ToolsConfig` and `get_openai_tools()` should remain the source of tool schemas.
   - `codex-rs/core/src/conversation_history.rs`, `codex-rs/core/src/event_mapping.rs`, and `codex-rs/core/src/codex/compact.rs` are the existing history/event/compaction utilities. Reuse their serialization patterns, but keep task-only memory separate from existing summarization compaction.

7. Relevant tests
   - Core flow: `codex-rs/core/tests/suite/client.rs`, `stream_error_allows_next_turn.rs`, and `stream_no_completed.rs`.
   - Compaction/resume/fork persistence: `codex-rs/core/tests/suite/compact.rs`, `compact_resume_fork.rs`, and the rollout reconstruction tests in `codex-rs/core/src/codex.rs`.
   - Tool outputs: `codex-rs/core/tests/suite/exec.rs`, `exec_stream_events.rs`, and the `convert_call_tool_result_to_function_call_output_payload` tests in `codex-rs/core/src/codex.rs`.
   - MCP ingress and turn overrides: `codex-rs/mcp-server/tests/suite/send_message.rs`, `create_conversation.rs`, `codex_message_processor_flow.rs`, and `list_resume.rs`.
   - Tool schema/qualification: unit tests in `codex-rs/core/src/openai_tools.rs` and `codex-rs/core/src/mcp_connection_manager.rs`.
   - Add new focused tests for `context_memory`: task-update validation, retention validation, pando chunking by tool name/result shape, rollout snapshot replay, and the `run_task()` hook ordering before the next tool-response turn.

## No-Source-Change Proxy Implementation

The implementation in this repository is the standalone `pando-proxy` app. It should make the memory design usable by people running the stock Codex CLI, without requiring them to download a custom Codex build.

The best no-source-change shape is a local OpenAI-compatible model-provider proxy:

- Codex continues to run normally.
- The wrapper configures stock Codex for the current process with `-c` provider overrides that send
  model requests to `http://127.0.0.1:<port>/v1`.
- The proxy receives every model turn, runs task update/chunking/retention, rewrites the request input to include compact memory, forwards the request to the real upstream model provider, and streams the upstream SSE response back unchanged.
- Memory is local to the user's machine. This is a local helper process, not a hosted backend service.

This approach is stronger than AGENTS.md, skills, custom prompts, or an MCP memory server because those options are model-mediated. They can suggest that the model call a memory tool, but they cannot guarantee that maintenance runs before the next model turn. A model-provider proxy is on the request path, so it can enforce the maintenance order.

Implementation priority: functionality comes first. Unit tests, integration tests, fixtures, and exhaustive validation harnesses are secondary to getting the proxy's core behavior working end to end. Tests should support implementation and protect high-risk logic, but they must not become the main project. The first milestone is a usable local proxy that stock Codex can route through, that can inject memory context, persist snapshots, and stream upstream responses correctly.

### Codex Wrapper Support

Yes, stock Codex can use a local proxy as a model provider without persistent config edits.

This is based on the current `codex-main` repository:

- `docs/config.md` documents `model_providers` as a map that can override and amend providers bundled with Codex.
- `docs/config.md` documents `model_provider` as the key used to select one of those providers.
- `docs/config.md` documents `model_providers.<id>.base_url` and `wire_api`.
- `codex-rs/core/src/config.rs` loads user-defined `model_providers`, selects `model_provider`, and stores the selected `ModelProviderInfo`.
- `codex-rs/core/src/client.rs` sends model requests through the selected provider's configured URL.

The happy path is wrapper-based: the user runs `pando-proxy`, which starts a per-instance proxy on
an available localhost port and then runs `codex` with process-local `-c` overrides that select the
proxy provider. The app must not edit `~/.codex/config.toml`. Full JSONL logging is opt-in.

The wrapper passes overrides equivalent to:

```sh
codex \
  -c 'model_provider="pando-proxy"' \
  -c 'model_providers.pando-proxy.name="Pando Memory Proxy"' \
  -c 'model_providers.pando-proxy.base_url="http://127.0.0.1:<port>/v1"' \
  -c 'model_providers.pando-proxy.wire_api="responses"' \
  -c 'model_providers.pando-proxy.requires_openai_auth=true' \
  ...
```

With `requires_openai_auth = true`, Codex sends its existing login/auth as an `Authorization` header
to the proxy. The proxy forwards that auth upstream and redacts it from logs.

The proxy should expose the same wire shape Codex expects from an OpenAI-compatible Responses API provider. At minimum, support:

- `POST /v1/responses`
- streaming SSE responses
- Bearer auth forwarding from Codex-sent `Authorization`, with `OPENAI_API_KEY` only as a fallback
  when the request has no auth header
- the request fields Codex sends today, including `model`, `instructions`, `input`, `tools`, `tool_choice`, `parallel_tool_calls`, `reasoning`, `store`, `stream`, `include`, `prompt_cache_key`, and `text`

Later, the proxy may also support Chat Completions if needed, but the first version should target `wire_api = "responses"` because that is the main Codex path for modern OpenAI models.

### Recommended Language

Implement the standalone proxy binary in Deno + TypeScript.

Reasons:

- The proxy is mostly HTTP, JSON, and streams; Deno uses standard Web APIs such as `Request`, `Response`, `fetch`, and `ReadableStream`.
- TypeScript gives quick iteration, good editor support, and enough static checking for the state machine.
- The memory logic can be written in a functional style: immutable state values, pure validators, and pure `apply*` functions.
- Deno has built-in `fmt`, `lint`, and `test`, which keeps the development loop short.
- Deno can compile the app into a self-contained executable, which keeps install/setup simple for Codex users.

This is an app-first Deno project. Do not structure the repo as a library-first TypeScript package with the proxy as an optional wrapper. Internal modules should exist only to keep the local proxy binary maintainable.

A practical command surface:

```text
pando-proxy [codex args...]          # start per-instance proxy, then run codex
pando-proxy serve                    # start localhost proxy only, for debugging
pando-proxy doctor                   # verify port, credentials, and upstream reachability
pando-proxy --proxy-no-memory exec   # run codex through pass-through proxy mode
```

Second choice is Go. Go is excellent for a robust single binary and long-running local HTTP services, but the memory state logic will be more verbose and slower to evolve.

Do not start with JVM Clojure for broad distribution. It is pleasant for this style of data transformation, but users need a Java runtime, which creates install friction. Babashka is attractive for Clojure-style scripting and installers, but Deno or Go is a better fit for a reliable streaming HTTP proxy.

### Repository Shape

Keep the first implementation small and boring. This is an application layout for the Deno binary, not a public library package layout:

```text
src/
  main.ts             # CLI entrypoint: wrapper/serve/doctor
  wrapper.ts          # dynamic port, unique logs, and codex process launch
  codex_modes.ts      # classify exec-json, interactive-remote, and passthrough runs
  codex_events.ts     # observe Codex exec JSONL and app-server websocket events
  websocket_relay.ts  # relay and log interactive app-server websocket frames
  server.ts           # HTTP server and routing only
  upstream.ts         # OpenAI-compatible forwarding and SSE passthrough
  codex_request.ts    # parse and normalize Codex model requests
  memory_pipeline.ts  # request-time memory orchestration
  memory_state.ts     # MemoryState types and pure state transitions
  task_update.ts      # task-update model call, validation, retry once
  assistant_memory.ts # assistant-response review and chunk materialization
  tool_results.ts     # extract tool outputs from Codex request input
  chunking.ts         # pando deterministic chunking and non-pando batch chunking
  retention.ts        # retention model call, validation, applyRetention
  prompt_view.ts      # derive synthetic memory context item for each turn
  store.ts            # local snapshot persistence
  config.ts           # proxy config and upstream provider config
tests/
  memory_state_test.ts
  task_update_test.ts
  assistant_memory_test.ts
  chunking_test.ts
  retention_test.ts
  prompt_view_test.ts
  wrapper_test.ts
```

The HTTP server should stay thin. The important logic belongs in pure modules that are easy to test without a running server.

### Request-Path Algorithm

For each incoming `POST /v1/responses` request:

1. Parse the JSON body.
2. Identify the session key:
   - Prefer `conversation_id` or `session_id` request headers when present.
   - Fall back to `prompt_cache_key` if needed.
   - If none exists, create a stable hash from process/user/cwd-adjacent metadata only if available. Prefer explicit IDs.
3. Load the latest `MemoryState` snapshot for that session.
4. Extract new user messages from `input` that have not been handled yet.
5. For each new user message, run `onNewUserMessage`:
   - call the task-update model,
   - validate the full `TaskUpdate`,
   - retry once with validation errors if invalid,
   - fail closed if still invalid.
6. Extract assistant responses from prior turns in `input` that have not been handled yet.
7. Ask the assistant-memory model which durable assistant facts, if any, should become chunks for
   live tasks.
8. Run eager retention over existing `memoryLibrary` plus assistant chunks.
9. Extract tool results from `input` that have not been handled yet.
10. Normalize tool results into `ToolResultEnvelope` values.
11. Chunk all tool results:
   - pando tool results in code,
   - non-pando tool results by batched model call.
12. Run eager retention over existing `memoryLibrary` plus the transient tool-result inbox.
13. Validate and apply retention.
14. Persist a full memory snapshot when state or handled ids changed.
15. Derive a compact synthetic memory context item from the updated state.
16. Rewrite the upstream request to include that synthetic memory context while dropping stale raw
    prior transcript history from the model-visible request.
17. Forward the request to the real upstream provider.
18. Stream the upstream SSE response back to Codex unchanged.

The proxy should not wait for the upstream response to do memory maintenance. Maintenance is based on the request Codex is about to send, because that request contains the prior user messages and tool outputs that must be handled before the next model turn.

### Snapshot Persistence

A snapshot means the whole current `MemoryState` serialized at this moment, not a diff.

Conceptually:

```json
{
  "type": "context_memory_snapshot",
  "payload": {
    "taskUpdateSeq": 7,
    "tasks": [],
    "activeTaskId": "task_2",
    "keptUserMessages": [],
    "memoryLibrary": []
  }
}
```

Snapshots are needed because memory cannot only live in RAM. If the proxy restarts, or if a user resumes a Codex conversation, the proxy must recover the memory state. Persisting small incremental operations like "keep chunk A", "drop chunk B", and "merge task C" requires perfect event replay. That is fragile. A full snapshot is simpler: load the latest snapshot for the session and continue from exactly that known state.

For the proxy, store snapshots in a local data directory, for example:

```text
~/.pando-proxy/
  config.json
  sessions/
    <session-id>/
      memory.snapshots.jsonl
      handled-inputs.json
```

Each successful task-update pass and each successful retention pass should append a full snapshot. On startup or request handling, the proxy scans the session's snapshot file and uses the latest valid snapshot.

Use atomic writes where practical:

- Write snapshot lines append-only.
- Flush after writes.
- If moving to one-file-per-latest-snapshot later, write to a temp file and rename atomically.

The first implementation can use JSONL files. SQLite is a reasonable later upgrade if concurrent sessions or queries become painful.

### Transcript History Versus Context Memory

Do not delete or rewrite Codex's canonical transcript/history as part of memory GC.

There are two separate things:

1. Canonical conversation history / rollout
   - Raw user messages, assistant messages, tool calls, and tool outputs.
   - Used for audit, replay, resume, fork, and debugging.
   - Should stay append-only as much as possible.

2. Context memory state
   - Live tasks.
   - Summaries of only user messages worth retaining.
   - Chunked tool-result facts worth retaining.
   - This is where "drop user messages we do not need" applies.

Dropping an unneeded user message from memory means the proxy stops carrying that message's summary/task association forward. It does not mean erasing the original `ResponseItem::Message` from the real transcript or from the request history Codex generated.

For model input, derive a model-visible context view before each turn. That view can include a compact synthetic memory item:

```text
Current live tasks:
- ...

Relevant retained context:
- ...
```

In the proxy implementation, this synthetic memory item is inserted into the request sent upstream. The original request body received from Codex should be treated as input evidence, not as the durable memory store.

For token savings, the proxy implements prompt rewriting as a derived prompt view. It removes prior
synthetic memory items, keeps leading `system`/`developer` instructions, inserts the latest
synthetic memory item, then keeps the latest raw user turn plus only the still-needed protocol
tail. Older handled assistant/tool cycles can be dropped once retained memory covers them, while
unfinished tool cycles stay intact. The proxy also reviews assistant message output at upstream
response end so those items can be persisted and marked handled before the next request. It does
not corrupt the canonical Codex rollout or the proxy's memory snapshots.

The key distinction: memory retention decides what remains relevant; transcript persistence preserves what happened.

### Synthetic Memory Context

The synthetic context item should be compact, deterministic, and clearly marked. Prefer one inserted user/developer-style message near the beginning of the upstream `input`, after Codex's own environment/instruction context but before the latest user work turn.

Example content:

```text
<context_memory>
Live tasks:
- task_2 [in_progress/do]: Implement the local Codex model-provider proxy.

Relevant retained context:
- pando chunking rules: find_nodes produces one chunk per node match; mutating pando tools produce operation-summary chunks.
- config support: Codex supports custom model_providers with base_url and wire_api.
</context_memory>
```

Rules:

- Include only live tasks.
- Include only chunks with at least one live task id.
- Keep chunk summaries short.
- Prefer pointer-heavy pando chunks so the model can re-query details.
- Do not include dropped/completed/missing task references.
- Enforce a maximum synthetic-context token or character budget.

### Upstream Model Calls For Maintenance

The proxy needs model calls for four maintenance tasks:

- task update,
- assistant-response review,
- non-pando chunking,
- retention.

Use a smaller/cheaper model by default, selected separately from the user's main Codex model.
The current binary uses a fixed two-model table for ChatGPT/Codex auth: `gpt-5.4-mini` by default,
and `gpt-5.4` when a conservative character-based token estimate would exceed the small model's
context window.
These maintenance calls should not expose tools. They should request strict JSON-schema structured
output and then validate it locally.

Current implementation policy:

- If task update validation fails twice, return an error to Codex instead of forwarding the next work turn.
- If assistant-response review fails twice, return an error to Codex instead of forwarding the next work turn.
- If chunking fails twice for non-pando output, return an error to Codex instead of forwarding the next work turn.
- If retention validation fails twice, return an error to Codex instead of forwarding the next work turn.
- In every case, retained chunks are pruned back to live task ids before persistence.

### Pando Tool Detection

Detect pando results by tool naming and result shape, not by one fragile integration path.

Likely names:

- `pando__find_nodes`
- `pando__find_references`
- `pando__find_callers`
- `pando__query_db`
- any configured MCP server name ending in pando-like tool names

Rules:

- If the tool name starts with `pando__`, treat it as pando.
- If the tool name is qualified as `<server>__<tool>` and `<tool>` matches known pando tools, treat it as pando.
- Keep this detection centralized in `tool_results.ts`.

### Install And Setup Goals

The proxy must optimize for easy adoption by normal Codex users.

The desired product shape is a standalone local app/binary. A user should be able to download or
run one executable and use stock Codex through it without editing Codex config.

Target wrapper experience:

```bash
pando-proxy exec "Help me with this repo"
```

The app should:

1. Start the local proxy on `127.0.0.1`, beginning at port `40123` and incrementing until free.
2. Run the system `codex` command directly with provider overrides pointing at that exact port.
3. Pass user-supplied Codex arguments through unchanged except for proxy-owned `--proxy-*` flags.
4. If `--proxy-log` or `--proxy-log-file` is set, write full JSONL logs; otherwise do not log.
5. Shut down the proxy when Codex exits and return Codex's exit code.

Target package/install options:

```bash
npx -y pando-proxy exec "Help me with this repo"
brew install pando-proxy
pando-proxy exec "Help me with this repo"
```

Also support non-Homebrew direct downloads:

```bash
curl -L https://example.com/pando-proxy/latest/pando-proxy-macos-arm64 -o pando-proxy
chmod +x pando-proxy
./pando-proxy
```

The exact distribution URL can change, but the design goal is stable: one local binary, no Java runtime, no Node project checkout, no manual config editing required for the happy path.

The CLI should still expose explicit commands for automation and debugging:

```text
pando-proxy [codex args...]          # start proxy and run codex with provider overrides
pando-proxy serve                    # start localhost proxy without running codex
pando-proxy doctor                   # verify port, credentials, and upstream reachability
```

With logging enabled, the app should print wrapper startup details like:

```text
Pando Proxy log: /Users/me/.pando-proxy/logs/pando-proxy-...jsonl
Pando Proxy URL: http://127.0.0.1:40123/v1
```

Standalone binary requirements:

- The released artifact should be a self-contained executable per platform/architecture.
- It should store app data under `~/.pando-proxy/`.
- It should never require users to clone this repository.
- It should never require users to manually run Deno, npm, Node, Java, or Clojure.
- It should not edit Codex config files.
- It should be safe to run repeatedly and concurrently; each instance gets its own port.
- It should not write logs unless the user passes an explicit logging flag.
- It should bind to `127.0.0.1` by default, not `0.0.0.0`.
- It should fail with clear messages if `codex` is not available or upstream credentials are missing.

`doctor` should check:

- Deno/binary version.
- proxy port availability.
- whether `OPENAI_API_KEY` fallback is present, while preferring Codex-sent auth.
- upstream OpenAI-compatible endpoint is reachable.
- a test request can round-trip through the proxy.

### Testing Strategy

All tests are secondary to implementing the functionality. Do not block the first usable version on comprehensive coverage. Add tests where they directly accelerate implementation or protect the pure state-machine pieces most likely to regress. The priority order is:

1. Working local proxy behavior.
2. Correct memory state transitions and prompt rewriting.
3. Easy wrapper launch for stock Codex users.
4. Focused tests around the riskiest pure logic.
5. Broader unit/integration coverage after the vertical slice works.

Start with tests that do not require network:

- `MemoryState` defaults and invariants.
- `TaskUpdate` validation:
  - sequence must increment,
  - latest message id must match,
  - every previous live task has an action,
  - kept user messages have live task ids,
  - `tasksAfter` is complete and ordered.
- retention validation:
  - every candidate appears exactly once,
  - kept chunks have live task ids,
  - kept chunks cannot reference dropped/completed/missing tasks.
- pando chunking:
  - `find_nodes` one chunk per node,
  - `find_references` one chunk per reference,
  - mutating tools produce one operation-summary chunk,
  - large/omitted results produce pointer chunks.
- prompt view:
  - excludes dropped memory,
  - includes live tasks,
  - respects the context budget,
  - produces deterministic output.
- request rewriting:
  - preserves all original tool schemas,
  - preserves `model`, `reasoning`, `text`, and stream settings,
  - inserts exactly one synthetic memory item.
- SSE passthrough:
  - streams upstream bytes to the client without buffering the whole response.

Then add integration tests with a fake upstream server:

- Codex-like request enters proxy.
- proxy performs maintenance using fake maintenance-model responses.
- rewritten upstream request contains memory context.
- upstream SSE response reaches client unchanged.

### First Milestone

Implement the smallest robust vertical slice:

1. Deno CLI with `serve` and `doctor`.
2. `POST /v1/responses` proxy with SSE passthrough.
3. Local JSONL snapshot store.
4. Pure `MemoryState` and validation modules.
5. Detect new user messages and insert a synthetic memory context.
6. Stub maintenance model calls behind interfaces so tests can use deterministic fixtures.
7. Add real task-update and retention model calls.
8. Add pando deterministic chunking.
9. Add non-pando batch chunking.
10. Add wrapper launch that starts a per-instance proxy and runs the system `codex` command.
11. Add dynamic port allocation and opt-in per-instance full JSONL logs.

Do not start with a complex database, hosted service, background daemon manager, UI, or custom Codex fork. The value of this repo is that it is a small local proxy that stock Codex users can install quickly.
