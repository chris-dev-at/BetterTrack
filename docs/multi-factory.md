# multi-factory.md — the parallel build factory

The multi-factory (`multi-factory/`) runs 1 **master** + N **workers** (default 2)
to roughly double wall-clock throughput while keeping tokens-per-issue within
±10% of the single factory. Full design rationale: `multi-factory/BRIEF.md`.
The single factory (`factory/`) stays intact as the fallback; both source the
same `factory/lib.sh` internals, and **the two must never run at the same time**
(both `autorun.sh` launchers enforce it).

## Roles

| Role      | Where  | Model                       | What                                                        |
| --------- | ------ | --------------------------- | ----------------------------------------------------------- |
| Composer  | master | opus                        | planner v2 — issues carry an `mf-meta` block (deps/touches) |
| Scheduler | master | none (pure bash)            | assigns runnable, non-conflicting issues to idle workers    |
| Merger    | master | none (pure bash)            | the ONLY thing that merges; FIFO queue, one ci-fix, re-gate |
| Writer    | worker | issue tier label            | same prompt as the single factory                           |
| Reviewer  | worker | opus (fable for tier:fable) | same prompt/rules                                           |
| Fixer     | worker | issue tier label            | same prompt/rules                                           |
| Checker   | worker | opus                        | triage after failed rounds: escalate / relocate / human     |

## Scheduling in one paragraph

The composer ends every issue body with `<!-- mf-meta … -->`: `depends-on`
(issue numbers that must be closed first) and `touches` (path-prefix claims).
An issue is **runnable** when it's open + `autopilot` + unassigned + all deps
closed (checked via direct REST reads — never the lagging search index). It may
be **assigned** only when none of its claims overlaps any in-flight claim
(assigned issues + PRs still in the merge queue). Claims are compared by
stripping everything from the first `*` and testing string-prefix both ways.
No/unparseable meta ⇒ the issue claims `**` and simply runs alone. Assignment:
lowest runnable issue → lowest idle worker, mirrored on GitHub with
`in-progress` + `mf:worker-N` labels (the `state/` dir is the source of truth).

## The escalation ladder (replaces "more fix rounds")

writer → (reviewer → fixer) ×2, then: approved PRs drop into the merge queue
and the worker immediately takes its next issue (it never babysits CI). Still
rejected → ONE **checker** pass decides: `RETRY_ESCALATED` (one more fix+review
at one tier higher, with the checker's diagnosis brief injected),
`RELOCATE` (checker files a properly-scoped follow-up issue labeled
`mf:relocated`; the current PR merges as-is or is closed with the dependency
written back into the issue's mf-meta), or `NEEDS_HUMAN` (a distilled A-or-B
question lands on the issue). Caps: one checker pass, one escalated retry,
relocate chain depth 1. `needs-human` means "only a human can answer this".

## The protocol dir (`multi-factory/state/`, bind-mounted at `/work/mfstate`)

- `assignments/worker-N.json` — master-written (atomic tmp+mv), removed on ack
- `status/worker-N.json` + `worker-N.hb` — worker phase + heartbeat (touched
  ≥ every 5 min even inside hour-long `cc()` calls; a heartbeat older than
  `MF_STALL_SECS` (default 3600 s) with an assignment present triggers
  killed-mid-run recovery: authoritative GH re-check → salvage approved PR to
  the queue, or reset labels + assignment for rescheduling)
- `merge-queue/<epoch>-prNN.json` — FIFO, consumed by the merger only
- `control/mode` — `run` | `run-out` | `close-down` (owner/dashboard-written)
- `control/phase` — `running` | `draining` | `drained` (master-written)
- `logs/events.log` — every container's factory event lines (`[master]`/`[wN]`)

## Modes & the control dashboard

- **run** — normal operation.
- **run-out** — composer off; workers keep draining until every open
  `autopilot` issue is done and merged, then `phase=drained`.
- **close-down** — composer off, no new assignments; only in-flight issues
  finish (including their merges), then `phase=drained`.

`multi-factory/control/server.mjs` (host, zero-dep Node, http://127.0.0.1:8790)
serves the live dashboard: master/worker phases, merge queue, GitHub
issues/PRs, event stream, per-issue cost — plus Start / Pause / Resume /
Run-out / Close-down / Stop controls. It writes `control/mode`, runs the
compose commands, and automatically downs the project when `phase=drained`.
Without the dashboard the drained factory just idles token-free until stopped.

## Ops crib sheet

```bash
./multi-factory/autorun.sh          # build + start (refuses while single factory runs)
./multi-factory/autorun.sh --dry    # MF_DRY_RUN=1 — full protocol, no LLM calls
./multi-factory/autorun.sh --logs   # follow all containers
./multi-factory/autorun.sh --stop   # stop containers (resumable)
./multi-factory/autorun.sh --down   # remove containers (state/ + volumes persist)
./multi-factory/test.sh             # offline scheduler tests (22, no tokens)
node multi-factory/control/server.mjs   # dashboard on 127.0.0.1:8790
docker compose -p bettertrack-multifactory pause|unpause   # freeze/thaw (cc() survives)
```

Ledger: same `factory/usage/ledger.jsonl`; multi-factory records carry extra
`factory`/`worker` fields; `factory/usage-report.sh` works unchanged. Token
capacity: all containers share the subscription; each `cc()` waits limits out
independently (`LIMIT_SLEEP`), scheduler and merger stay token-free.
