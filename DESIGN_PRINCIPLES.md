# pando-proxy Goals and Design Principles

This document explains what pando-proxy is trying to do and the principles that should guide future
changes. For implementation details, see [REFERENCE.md](./REFERENCE.md) and
[MEMORY_OPERATIONS.md](./MEMORY_OPERATIONS.md).

## Goal

pando-proxy lets a user run Codex normally while a local proxy manages task-scoped memory between
Codex and the upstream model provider. The user should be able to run:

```sh
npx -y pando-proxy [codex args...]
```

and get the normal Codex experience, with the proxy handling provider wiring, request rewriting,
memory maintenance, logging, and cleanup.

## Intent

The proxy exists to keep the model focused on the active work instead of replaying every raw prior
message forever. It tracks live tasks, retains only useful task-linked context, and rewrites the
upstream request so Codex receives a compact derived memory view plus the current turn.

The proxy is not a second agent UI and should not change how users think about Codex. It is a local
transport and memory layer.

## Design Principles

- Codex remains the interface. The wrapper should pass Codex arguments through naturally and
  preserve normal `exec`, interactive, `resume`, and utility command behavior.
- Setup should be one command. The default path is `npx -y pando-proxy`; no manual Codex config edit
  should be required.
- Prefer Codex authentication. Requests use the authorization Codex already sends. Environment API
  keys are only a fallback when no request authorization header exists.
- Keep everything local by default. The proxy binds to localhost, stores state under the configured
  state directory, and does not send telemetry.
- Logging is explicit. Full JSONL logs and searchable metrics are disabled by default and enabled
  only with logging flags or `PANDO_PROXY_LOG_FILE`.
- Memory is task-scoped. User messages, assistant responses, and tool outputs are retained only when
  they support live tasks.
- Prefer derived context over raw history. Prior synthetic memory is removed, stale raw transcript
  is dropped, and a fresh `<context_memory>` item is injected for the upstream model. In
  particular, once prior assistant/tool protocol segments have been handled and covered by retained
  memory, the rewrite step may drop those raw segments instead of replaying them upstream.
- Use deterministic code where shapes are known. Pando tool outputs are chunked in code because
  their result formats are controlled.
- Use model judgment where shapes are arbitrary. Non-Pando tool outputs and assistant responses use
  strict JSON-schema maintenance calls so arbitrary output can be split into useful retention units.
- Bound maintenance calls. Task update, assistant-response review, and non-Pando chunking may ask
  for extra information at most once, then must produce a final structured answer.
- Fail clearly. Invalid final maintenance output or exhausted transport retries should stop the pass
  with a `pando_proxy_failed` error instead of silently keeping bad state.
- Keep memory small but specific. Prefer concise summaries with pointers over copying long raw data;
  prefer several small useful chunks over one broad chunk when retention may keep only part of a
  structured result.
- Preserve upstream behavior. The proxy should forward upstream streaming responses unchanged while
  observing enough traffic to maintain memory and logs.
- Avoid persistent Codex config mutation. The wrapper uses process-local provider overrides and owns
  its proxy/app-server wiring for the current invocation.

## Memory Lifecycle

Each inbound request is handled in this order:

1. Extract current user messages, assistant responses, and tool outputs from the Codex request.
2. Update the task list from new user messages.
3. Review new assistant responses and create task-linked chunks only for durable facts that still
   matter.
4. Chunk new tool outputs. Pando results are handled in code; non-Pando results are chunked by a
   maintenance model with live task/user-message context.
5. Run retention over existing and new chunks.
6. Persist the updated session memory.
7. Rewrite the upstream request with a fresh `<context_memory>` item and the current raw turn,
   minus older handled protocol segments that are already represented in retained memory.
8. Forward the request to the real upstream provider and stream the response back to Codex.
9. When the upstream response ends, review any assistant message items immediately, persist them,
   and mark them handled before the next inbound request.

## Non-Goals

- Do not replace Codex authentication, UI, or command semantics.
- Do not require users to manage provider config files.
- Do not log by default.
- Do not retain raw history just because it exists.
- Do not make best-effort hidden fallbacks that hide memory corruption or schema errors.
