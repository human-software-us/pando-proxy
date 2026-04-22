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

The wrapper starts a localhost proxy on the first available port at or above `40123`, creates a
unique JSONL log file under `~/.pando-proxy/logs`, then runs the system `codex` command with
process-local provider overrides pointing at that proxy.

## Requirements

- `codex` installed and logged in.
- `deno` available on `PATH`.
- `node`/`npm` available for `npx`.

`pando-proxy` does not edit `~/.codex/config.toml`.

## Useful Commands

```sh
npx -y pando-proxy --proxy-help
npx -y pando-proxy --proxy-no-memory exec "Reply with exactly: pass-through ok"
npx -y pando-proxy serve --no-memory --log-file /tmp/pando-proxy.jsonl
```

See [LIVE_E2E.md](./LIVE_E2E.md) for a live end-to-end test procedure.
