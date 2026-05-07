# Context Memory Design

The proxy is a one-task sieve.

Each round:

1. take the raw prompt/history Codex would send
2. chunk non-user assistant/tool sources into exact pieces; keep each user message as one whole
   atomic piece
3. decide whether the new user input continues, starts, or revives an executable task
4. keep the active task's exact working set
5. drop only pieces with positive proof that they are unnecessary
6. forward the reduced prompt

So:

- raw prompt/history is `A`
- forwarded prompt/history is `A'`
- `A'` should be no larger than `A`
- `A'` should preserve exact task-relevant content, just filtered

There is one active memory tier only:

- `activeTask`
- exact surviving `pieces`
- a short task title used for routing and archive revive

There are no groups. The model may make ad-hoc semantic judgments in `piece_drop_batch`, but those
judgments do not create durable routing objects. They only answer: can this candidate be dropped
with certainty?

There is one explicit recovery path:

- `recall({offset,limit})`
- archive-backed only
- max 3 calls per round
- no per-call item cap

The archive exists so dropped exact material can be resurrected deliberately if needed, but the
archive is not part of normal prompt memory.
