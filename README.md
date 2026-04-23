# pando-proxy

Run Codex through a local memory proxy.

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

See [REFERENCE.md](./REFERENCE.md) for the complete flag, environment variable, auth, state, and
development reference.
