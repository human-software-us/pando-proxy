# pando-proxy

Run Codex through a local task-memory proxy with one `npx` command.

`pando-proxy` starts a localhost proxy, runs the system `codex` command with process-local provider
overrides, and rewrites upstream model requests so Codex gets compact task-scoped memory instead of
stale raw transcript history.

## Usage

```sh
npx -y pando-proxy exec "Help me with this repo"
```

Proxy-owned flags go before the Codex command and use the `--proxy-*` prefix:

```sh
npx -y pando-proxy --proxy-no-memory exec "Reply with exactly: ok"
```

The wrapper starts a localhost proxy on the first available port at or above `40123`, then runs the
system `codex` command with process-local provider overrides pointing at that proxy. Logging is off
by default. The first non-proxy argument is passed to Codex, so forms like `exec`, `resume`,
`help exec`, and `app-server` keep their normal Codex meaning.

Memory is enabled by default. Use `--proxy-no-memory` for a pure pass-through transport check.

## Design

pando-proxy is designed to be invisible in normal Codex use:

- Codex remains the UI and command surface.
- Codex-provided authorization is preferred; API keys are only a fallback when Codex sends no
  authorization header.
- The wrapper does not edit Codex config files.
- Logging is explicit and disabled by default.
- Memory is task-scoped, eager, and derived from user messages, assistant responses, and tool
  outputs.

## Modes

`pando-proxy` uses three Codex paths:

| Mode                 | Codex form                                                             | Behavior                                                                                                               |
| -------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `exec-json`          | `exec` / `e`                                                           | Adds `--json` once, forwards stdout, and logs structured Codex events when logging is enabled.                         |
| `interactive-remote` | prompt, no args, `resume`, `fork`                                      | Starts `codex app-server`, relays websocket traffic, then starts the normal Codex TUI with a wrapper-owned `--remote`. |
| `passthrough`        | `help`, `--version`, `login`, `logout`, `app-server`, utility commands | Runs Codex directly with the same process-local provider overrides. Utility commands may not make model requests.      |

Interactive mode owns `--remote`; pass normal Codex prompt/session arguments and let the wrapper
create the app-server and relay.

## Requirements

- `codex` installed and logged in.
- `deno` available on `PATH`.
- `node`/`npm` available for `npx`.

`pando-proxy` does not edit `~/.codex/config.toml`.

## Useful Commands

```sh
npx -y pando-proxy --proxy-help
npx -y pando-proxy "Help me with this repo"
npx -y pando-proxy --proxy-no-memory exec "Reply with exactly: pass-through ok"
npx -y pando-proxy --proxy-log-file /tmp/pando-proxy.jsonl "Reply with exactly: logged tui ok"
npx -y pando-proxy exec --help
npx -y pando-proxy resume --last
npx -y pando-proxy --proxy-log exec "Run with a unique JSONL log file"
npx -y pando-proxy serve --no-memory --log-file /tmp/pando-proxy.jsonl
```

See [LIVE_E2E.md](./LIVE_E2E.md) for a live end-to-end test procedure and
[MEMORY_OPERATIONS.md](./MEMORY_OPERATIONS.md) for memory/logging operational details. When logging
is enabled, searchable metrics events use the `pando_proxy_metrics_` prefix and
`PANDO_PROXY_METRICS` marker.

Documentation:

| Document                                               | Purpose                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| [DESIGN_PRINCIPLES.md](./DESIGN_PRINCIPLES.md)         | Goals, intent, and design principles.                       |
| [REFERENCE.md](./REFERENCE.md)                         | Complete flag, environment, auth, state, and dev reference. |
| [MEMORY_OPERATIONS.md](./MEMORY_OPERATIONS.md)         | Memory maintenance, logging, and metrics behavior.          |
| [LIVE_E2E.md](./LIVE_E2E.md)                           | Live end-to-end test procedure.                             |
| [CONTEXT_MEMORY_DESIGN.md](./CONTEXT_MEMORY_DESIGN.md) | Detailed context-memory design notes.                       |
