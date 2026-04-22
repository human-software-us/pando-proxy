# Context Memory Design

## Product Deliverable

This repository's deliverable is a standalone local proxy binary named `pando-proxy`.

It is not a reusable memory library, a Codex fork, an MCP memory server, or a hosted backend service. The product is one self-contained local executable that stock Codex can use as an OpenAI-compatible model provider.

Implement the app in Deno + TypeScript. Library-shaped modules are allowed only as internal implementation units of the binary, for example under `src/`. They must not be designed, packaged, or documented as a separate public SDK or as the primary deliverable.

The memory design below exists to serve that proxy. All task update, tool chunking, retention, prompt injection, snapshot persistence, config installation, and upstream forwarding behavior must be wired through the local proxy request path and CLI.

## Goal

Inside the `pando-proxy` binary, keep context useful without letting it accumulate. Every user message and every tool result must be explicitly handled before the next work turn:

- update the task list from the latest user message,
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
  source?: "tool" | "user";
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
- Users configure stock Codex to send model requests to `http://127.0.0.1:<port>/v1`.
- The proxy receives every model turn, runs task update/chunking/retention, rewrites the request input to include compact memory, forwards the request to the real upstream model provider, and streams the upstream SSE response back unchanged.
- Memory is local to the user's machine. This is a local helper process, not a hosted backend service.

This approach is stronger than AGENTS.md, skills, custom prompts, or an MCP memory server because those options are model-mediated. They can suggest that the model call a memory tool, but they cannot guarantee that maintenance runs before the next model turn. A model-provider proxy is on the request path, so it can enforce the maintenance order.

Implementation priority: functionality comes first. Unit tests, integration tests, fixtures, and exhaustive validation harnesses are secondary to getting the proxy's core behavior working end to end. Tests should support implementation and protect high-risk logic, but they must not become the main project. The first milestone is a usable local proxy that stock Codex can route through, that can inject memory context, persist snapshots, and stream upstream responses correctly.

### Codex Config Support

Yes, stock Codex can be configured to use a local proxy as a model provider.

This is based on the current `codex-main` repository:

- `docs/config.md` documents `model_providers` as a map that can override and amend providers bundled with Codex.
- `docs/config.md` documents `model_provider` as the key used to select one of those providers.
- `docs/config.md` documents `model_providers.<id>.base_url`, `env_key`, and `wire_api`.
- `codex-rs/core/src/config.rs` loads user-defined `model_providers`, selects `model_provider`, and stores the selected `ModelProviderInfo`.
- `codex-rs/core/src/client.rs` sends model requests through the selected provider's configured URL.

Users should be able to install the proxy and add a config block like this:

```toml
model_provider = "pando-proxy"

[model_providers.pando-proxy]
name = "Pando Memory Proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

The proxy should expose the same wire shape Codex expects from an OpenAI-compatible Responses API provider. At minimum, support:

- `POST /v1/responses`
- streaming SSE responses
- Bearer auth forwarding from `OPENAI_API_KEY`
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
pando-proxy serve       # start localhost proxy
pando-proxy install     # write or print Codex config snippet/profile
pando-proxy doctor      # verify port, OPENAI_API_KEY, upstream reachability, Codex config
```

Second choice is Go. Go is excellent for a robust single binary and long-running local HTTP services, but the memory state logic will be more verbose and slower to evolve.

Do not start with JVM Clojure for broad distribution. It is pleasant for this style of data transformation, but users need a Java runtime, which creates install friction. Babashka is attractive for Clojure-style scripting and installers, but Deno or Go is a better fit for a reliable streaming HTTP proxy.

### Repository Shape

Keep the first implementation small and boring. This is an application layout for the Deno binary, not a public library package layout:

```text
src/
  main.ts             # CLI entrypoint: serve/install/doctor
  server.ts           # HTTP server and routing only
  upstream.ts         # OpenAI-compatible forwarding and SSE passthrough
  codex_request.ts    # parse and normalize Codex model requests
  memory_state.ts     # MemoryState types and pure state transitions
  task_update.ts      # task-update model call, validation, retry once
  tool_results.ts     # extract tool outputs from Codex request input
  chunking.ts         # pando deterministic chunking and non-pando batch chunking
  retention.ts        # retention model call, validation, applyRetention
  prompt_view.ts      # derive synthetic memory context item for each turn
  store.ts            # local snapshot persistence
  config.ts           # proxy config and upstream provider config
tests/
  memory_state_test.ts
  task_update_test.ts
  chunking_test.ts
  retention_test.ts
  prompt_view_test.ts
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
6. Extract tool results from `input` that have not been handled yet.
7. Normalize tool results into `ToolResultEnvelope` values.
8. Chunk all tool results:
   - pando tool results in code,
   - non-pando tool results by batched model call.
9. Run eager retention over existing `memoryLibrary` plus the transient inbox.
10. Validate and apply retention.
11. Persist a full memory snapshot.
12. Derive a compact synthetic memory context item from the updated state.
13. Rewrite the upstream request to include that synthetic memory context.
14. Forward the request to the real upstream provider.
15. Stream the upstream SSE response back to Codex unchanged.

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

Later, for real token savings, the proxy can also implement prompt rewriting that omits or summarizes older raw transcript items before forwarding upstream. That must still be a derived prompt view. It should not corrupt the canonical Codex rollout or the proxy's memory snapshots.

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

The proxy needs model calls for three maintenance tasks:

- task update,
- non-pando chunking,
- retention.

Use a smaller/cheaper model by default, configurable separately from the user's main Codex model. These maintenance calls should not expose tools. They should request strict JSON output and then validate it locally.

Fail-closed policy:

- If task update validation fails twice, return an error to Codex instead of forwarding the next work turn.
- If chunking fails for non-pando output, create one conservative fallback chunk with a pointer/summary when safe, or fail if the output is essential and cannot be represented.
- If retention validation fails twice, keep the previous memory library and new chunks only if they can be mechanically attached to the active live task; otherwise fail closed.

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

The desired product shape is a standalone local app/binary. A user should be able to download or install one executable, run it, approve installation as their Codex proxy, and then use stock Codex normally.

Target first-run experience:

```bash
pando-proxy
```

The app should:

1. Detect whether it is already installed in `~/.codex/config.toml`.
2. If not installed, ask the user whether to install itself as a Codex model-provider proxy.
3. Explain exactly what it will change:
   - add a `pando-proxy` entry under `[model_providers]`,
   - add a `pando-memory` profile that selects that provider,
   - leave existing profiles and user settings intact,
   - create a timestamped backup of `~/.codex/config.toml` before writing.
4. Apply the config change after confirmation.
5. Run `doctor` checks.
6. Start the local proxy server.
7. Print the exact next command:

```bash
codex --profile pando-memory
```

If the app chooses to make `pando-memory` the default profile, that must be an explicit separate confirmation. The safe default is to create a named profile and tell the user how to use it.

Target package/install options:

```bash
brew install pando-proxy
pando-proxy
codex --profile pando-memory
```

Also support non-Homebrew direct downloads:

```bash
curl -L https://example.com/pando-proxy/latest/pando-proxy-macos-arm64 -o pando-proxy
chmod +x pando-proxy
./pando-proxy
codex --profile pando-memory
```

The exact distribution URL can change, but the design goal is stable: one local binary, no Java runtime, no Node project checkout, no manual config editing required for the happy path.

The CLI should still expose explicit commands for automation and debugging:

```text
pando-proxy serve       # start localhost proxy without changing config
pando-proxy install     # install/update Codex config profile and provider
pando-proxy uninstall   # remove only config entries created by pando-proxy
pando-proxy doctor      # verify port, OPENAI_API_KEY, upstream reachability, Codex config
pando-proxy status      # show whether proxy is running and how Codex is configured
```

The `install` command should write a named profile to `~/.codex/config.toml` by default. It may also support `--print` to print an exact snippet without changing files. Prefer a named profile first to avoid surprising users who already have a tuned Codex setup:

```toml
[profiles.pando-memory]
model_provider = "pando-proxy"

[model_providers.pando-proxy]
name = "Pando Memory Proxy"
base_url = "http://127.0.0.1:8787/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
```

Then users can run:

```bash
codex --profile pando-memory
```

The app should print a successful install message like:

```text
Pando Proxy is installed and running at http://127.0.0.1:8787/v1.

Use Codex with:
  codex --profile pando-memory

Leave this terminal open while using Codex.
```

If the user wants the proxy to run in the background, that should be an explicit command such as:

```bash
pando-proxy service install
pando-proxy service start
codex --profile pando-memory
```

Background service support is useful but not required for the first vertical slice. The first version can run in the foreground and clearly tell the user to leave it open.

Standalone binary requirements:

- The released artifact should be a self-contained executable per platform/architecture.
- It should store app data under `~/.pando-proxy/`.
- It should never require users to clone this repository.
- It should never require users to manually run Deno, npm, Node, Java, or Clojure.
- It should be safe to run repeatedly. Re-running install should update existing pando-owned config blocks, not duplicate them.
- It should create backups before editing Codex config.
- It should preserve unrelated Codex config formatting as much as practical. If exact formatting preservation becomes costly, correctness and safety are more important: parse TOML, update only owned keys, write valid TOML, and keep a backup.
- It should bind to `127.0.0.1` by default, not `0.0.0.0`.
- It should fail with clear messages if the port is busy or upstream credentials are missing.

`doctor` should check:

- Deno/binary version.
- proxy port availability.
- `OPENAI_API_KEY` is present if required.
- upstream OpenAI-compatible endpoint is reachable.
- Codex config contains the proxy provider/profile.
- a test request can round-trip through the proxy.

### Testing Strategy

All tests are secondary to implementing the functionality. Do not block the first usable version on comprehensive coverage. Add tests where they directly accelerate implementation or protect the pure state-machine pieces most likely to regress. The priority order is:

1. Working local proxy behavior.
2. Correct memory state transitions and prompt rewriting.
3. Easy install/setup for stock Codex users.
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
10. Add `install` command for Codex config/profile.
11. Make running `pando-proxy` with no subcommand perform the friendly first-run flow: install if needed, run doctor, start the foreground proxy, and tell the user to run `codex --profile pando-memory`.

Do not start with a complex database, hosted service, background daemon manager, UI, or custom Codex fork. The value of this repo is that it is a small local proxy that stock Codex users can install quickly.
