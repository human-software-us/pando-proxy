# Context Memory Design

The proxy is a sieve.

Each round:

1. take the raw prompt/history Codex would send
2. keep only the exact pieces still worth carrying
3. drop everything else from active memory
4. forward the reduced prompt

So:

- raw prompt/history is `A`
- forwarded prompt/history is `A'`
- `A'` should be no larger than `A`
- `A'` should preserve the same essential exact content, just filtered

There is one active memory tier only:

- `groups`
- exact surviving `pieces`

`groups` include summaries for temporary routing and grouping, but those summaries are not provided
as source material. Exact material in normal prompts comes only from surviving `pieces`.

There is one explicit recovery path:

- `recall({offset,limit})`
- archive-backed only
- max 3 calls per round
- no per-call item cap

The archive exists so dropped exact material can be resurrected deliberately if needed, but the
archive is not part of normal prompt memory.
