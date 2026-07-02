# factory-usage.md — per-issue token & cost tracking

The factory records how many tokens each GitHub issue consumed and the rough API
cost (USD), so the owner can see spend per issue locally.

## How it works

Every headless `claude` run in `factory/run.sh` goes through the `cc()` helper,
which already invokes the CLI with `--output-format stream-json --verbose`. The
final `{"type":"result"}` event in that stream carries `usage`
(`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
`cache_read_input_tokens`) and `total_cost_usd`. `cc()` now parses that line it
was already reading and appends one JSONL record per role run to a ledger — pure
plumbing, no extra model calls, agent behaviour unchanged.

Callers tag each run via two shell vars read by `cc()`: `CC_ISSUE` (set once per
cycle to the issue number, `-` for the queue-filling planner) and `CC_ROLE`
(`writer` / `reviewer` / `fixer` / `ci-fix` / `planner`). The cheap capacity
probes (`model_ok` / `api_ok`) call the CLI directly, not through `cc()`, so they
are intentionally **not** ledgered — they aren't attributable to any issue.

A missing or garbled usage line never fails the pipeline: `ledger_record` degrades
to a no-op (`|| true`) and the cycle continues.

## Ledger

- **In the container:** `/work/usage/ledger.jsonl`
- **On the host:** `factory/usage/ledger.jsonl`

`factory/compose.yml` bind-mounts `./usage → /work/usage`, so records persist on
the host across container restarts (unlike the `factory-work` named volume). The
directory is kept in git via `factory/usage/.gitkeep`; the data files
(`factory/usage/*.jsonl`) are git-ignored — only code is committed.

One compact JSON object per line (JSONL) — one record per role run:

```text
{"ts":"2026-07-02T18:00:00+00:00","issue":"95","role":"writer","model":"claude-opus-4-8","input_tokens":1234,"output_tokens":5678,"cache_read_tokens":900000,"cache_creation_tokens":40000,"cost_usd":0.8123,"duration_s":142,"outcome":"ok"}
```

`outcome` is `ok` (clean run), `fail` (genuine task failure), or `retry` (a
usage-limit or ambiguous failure that `cc()` will retry). Retries and failures are
kept so an issue's _true_ spend — not just its final successful run — is visible.

## Cost derivation

`cost_usd` prefers the CLI's `total_cost_usd` (almost always present). Only when
that field is absent does it fall back to `tokens × pricing`, using an editable
table near the top of `run.sh` (`PRICE_IN` / `PRICE_OUT` / `PRICE_CR` / `PRICE_CW`,
USD per 1M tokens) for the three models the factory uses — `claude-sonnet-5`,
`claude-opus-4-8`, `claude-fable-5`. Update that table if pricing changes.

## Per-cycle log line

After each issue's cycle ends (merged, self-resolved, or bailed to a human),
`run.sh` logs a timestamped line, e.g.:

```
2026-07-02T18:05:12+00:00 COST: issue #95 — $1.23 total (writer $0.80, reviewer $0.31, fixer $0.12)
```

This shows up in `docker compose -p bettertrack-factory logs` (the Chief watches
timestamped lines).

## Report

```bash
./factory/usage-report.sh                 # reads factory/usage/ledger.jsonl
./factory/usage-report.sh /path/to/ledger.jsonl
```

Prints a per-issue table (tokens by kind, total cost, per-role spend with retry
counts) plus a grand total. Needs `jq` on the host. Rows with a non-numeric issue
(`-`) are factory overhead (planner), not tied to a single issue.

## Deploying changes

`run.sh` is baked into the image (`COPY run.sh` in `factory/Dockerfile`), so these
changes take effect only after an **image rebuild + container recreate** — exactly
what `./factory/autorun.sh` does (`dc build` then `dc up -d --force-recreate`). The
new `./usage` bind-mount is picked up by the same recreate. Editing prompts alone
would not suffice; a plain restart of the existing container would not either. The
Chief handles the restart on the next factory cycle.
