# multi-factory/BRIEF.md — Build brief for the Multi-Factory

> **Owner usage:** in a fresh Claude session at `/model` Fable + `/effort` max, say
> _"Read multi-factory/BRIEF.md and build it."_ This document is the complete,
> self-contained specification. Owner: `chris-dev-at`. Decisions already made in
> this brief are final — do not re-litigate them; genuinely open questions are
> listed in §12.

## 0. Before writing any code

Read, in this order: `CLAUDE.md` (binding model-tier rules), `MODELUSE.md`,
`docs/factory-knowledge.md`, and **all of `factory/run.sh`** — the multi-factory
reuses its battle-tested internals (headless `cc()` calls, capacity waits,
ledger, merge re-gate, self-heal). Also skim `factory/prompts/*.md` and
`factory/knowledge/build.mjs`.

Repo: `~/Desktop/Coding/Github/BetterTrack` → github.com/chris-dev-at/BetterTrack.
Main is protected by a ruleset (PR required + `verify` status check, strict
up-to-date). Commit as the logged-in gh user; **never add Co-Authored-By or any
AI attribution trailer**. Repo has delete-branch-on-merge enabled.

## 1. What exists today (single factory) — DO NOT BREAK IT

`factory/run.sh` in one Docker container (compose project `bettertrack-factory`,
launched by `./factory/autorun.sh`) runs a serial loop: planner refills the
GitHub-issue backlog when it drops below `MIN_BACKLOG`; per issue it runs
writer → up to `MAX_FIX_ROUNDS=2` reviewer/fixer rounds → CI gate (one ci-fix
attempt) → squash-merge with a BEHIND re-gate retry. Model per issue comes from
labels `tier:sonnet` / `tier:opus` / `tier:fable` (claude-sonnet-5 /
claude-opus-4-8 / claude-fable-5). Every role prompt gets the knowledge pack
injected (`factory/knowledge/PACK.md` + generated MAP + live STATE). Every run
appends to the host ledger `factory/usage/ledger.jsonl`. `cc()` never mistakes
token exhaustion for task failure — it waits `LIMIT_SLEEP` (1800 s) and retries.

**The single factory stays fully working and untouched in behavior.** It is the
fallback while the multi-factory proves itself. Extracting shared code is
allowed only if `factory/run.sh` behavior is provably unchanged (see §8).

## 2. Goal

A parallel factory under `multi-factory/` that roughly doubles wall-clock
throughput with 2 workers while keeping tokens-per-issue within ±10% of the
single factory, by:

- a **master** process that composes issues, assigns them to workers, and is
  the **only** thing that ever merges to main;
- **N worker** containers (default 2) that write/review/fix in isolation;
- a **checker** triage role that replaces "more fix rounds" with smarter
  routing, so `needs-human` fires only for genuine decisions.

## 3. Architecture (final)

```
multi-factory/
├─ master.sh          one bash loop: composer step → scheduler → merger
├─ worker.sh          per-container loop: wait for assignment → build cycle
├─ autorun.sh         build image + compose up (project: bettertrack-multifactory)
├─ compose.yml        1 master + N workers (replicas via env WORKERS, default 2)
├─ prompts/           composer.md, checker.md  (writer/reviewer/fixer/ci-fix
│                     are REUSED from factory/prompts/ unchanged)
├─ state/             gitignored shared volume — the master↔worker protocol (§6)
└─ BRIEF.md           this file
```

Roles and models:

| Role      | Model                       | LLM?                                          |
| --------- | --------------------------- | --------------------------------------------- |
| Composer  | opus                        | yes — creates issues with scheduling metadata |
| Scheduler | —                           | **no — pure bash**                            |
| Merger    | —                           | **no — pure bash**                            |
| Writer    | issue tier label            | yes                                           |
| Reviewer  | opus (fable for tier:fable) | yes — same rule as run.sh today               |
| Fixer     | issue tier label            | yes                                           |
| Checker   | opus                        | yes — classifier only, writes no code         |

## 4. The composer (planner v2)

Triggered by the master when the count of _runnable_ queued issues (open,
`autopilot`, deps satisfied, unassigned) drops below `WORKERS + 1`. Start from
the existing `factory/prompts/planner.md` (same PROJECTPLAN §13 build-order
discipline, verbatim spec excerpts in issue bodies, small batches) and add one
requirement — every issue body ends with a machine-readable block:

```
<!-- mf-meta
depends-on: 143, 145        (omit line if none)
touches: apps/api/src/services/social/**
touches: packages/contracts/src/social.ts
-->
```

Rules for the composer prompt:

- `depends-on` lists issue numbers that must be **closed** first. The composer
  knows these because it designed the decomposition.
- `touches` claims every path prefix the implementation is expected to modify.
  Over-claiming is safe (serializes); under-claiming costs a rebase round.
- The composer should _deliberately_ shape batches so at least 2 issues are
  lane-independent when the plan allows (e.g. a backend slice + an unrelated
  frontend slice), so the workers actually parallelize.
- Tier labels per MODELUSE, same as today. When unsure, higher tier.

### One-shot owner composition brief

For a bounded owner-requested batch, place the brief in gitignored control state
with the helper:

```bash
./multi-factory/request-compose.sh 2 /absolute/path/to/brief.md acceptance-20260724
```

The requested exact count becomes the effective composer batch for that one
invocation, without changing `state/control/models.json` or restarting the
factory. It may not exceed the master's `COMPOSER_BATCH` ceiling. The master
atomically claims the request, appends its text verbatim between visible
owner-brief delimiters, and archives it under
`state/control/composer-request-archive/` only after the normal manifest
contract validates with exactly that many issues. `NONE`, a partial batch, a
malformed manifest, or an archive failure retains the active request and never
publishes its artifacts to the scheduler. After the invocation's bounded
protocol attempts are spent, the retained request is marked blocked and is not
automatically replayed.

The active claim carries a master-session guard. After a master restart, an
unresolved claim is not replayed automatically because the previous process may
already have created GitHub issues; new scheduling pauses and the owner must
reconcile the retained active request and manifest first. This is deliberately
fail-closed.

## 5. The scheduler (deterministic — this is the core novelty)

Bash only. The scheduler **never infers** compatibility; it checks claims:

1. **Runnable**: issue is open, labeled `autopilot`, not assigned, and every
   `depends-on` issue is CLOSED (direct REST reads via `gh api` — never the
   search endpoint, whose index lags ~30 s+).
2. **Non-conflicting**: an issue may be assigned only if none of its `touches`
   claims overlaps any claim of any in-flight issue. Overlap test: strip
   everything from the first wildcard, then two claims conflict if either
   resulting prefix is a string-prefix of the other. (`apps/api/**` vs
   `apps/api/src/x.ts` → conflict; `apps/api/**` vs `apps/web/**` → fine.)
3. **Conservative default**: a missing/unparseable `mf-meta` block means the
   issue conflicts with _everything_ — it runs, but only alone. Serializing is
   never incorrect, only slower.
4. Assignment: lowest runnable issue number to the lowest-numbered idle worker.
   Mirror it on GitHub (`in-progress` label + a `mf:worker-N` label) for
   visibility, but the source of truth is the state dir (§6).

## 6. Master↔worker protocol (shared `state/` volume, no GitHub round-trips)

- `state/assignments/worker-N.json` — written atomically (`mv` from tmp) by the
  master: `{ "issue": 144, "assigned_at": "…" }`. Removed by the master after
  the worker acknowledges completion.
- `state/status/worker-N.json` — written atomically by the worker:
  `{ "phase": "idle|writing|reviewing|fixing|awaiting-merge|triage|done|failed",
"issue": 144, "pr": 158, "updated_at": "…" }`. The worker touches this
  file at least once per phase change; the master treats an `updated_at` older
  than 60 min with no container log output as a stall → apply the existing
  killed-mid-run recovery semantics (re-check issue/PR state authoritatively,
  reset or reassign).
- `state/merge-queue/` — one file per ready PR, named `<epoch>-pr<NUM>`,
  created by the worker when its PR is reviewer-approved; consumed FIFO by the
  merger.

Each worker container gets its **own repo clone** in its own volume (reuse the
existing factory image/bootstrap). Workers never touch main and never merge.

## 7. Worker cycle, checker, and the escalation ladder

Per assignment: writer → (reviewer → fixer) up to **2 rounds**, exactly like
run.sh (reuse its round loop semantics, verdict parsing `FACTORY-VERDICT:`,
ghost-cycle re-check, no-PR self-resolve path). Then:

- **Approved** → drop a merge-queue file, set phase `awaiting-merge`, and — key
  throughput win — the worker is immediately schedulable for its next issue;
  it does not babysit CI.
- **Still rejected after round 2** → phase `triage`: run the **checker** once.

**Checker** (new prompt, `multi-factory/prompts/checker.md`): input = issue
body, final review verdict, PR diff stat + changed-file list (not the full
diff), and the two fixer attempts' summaries. It writes no code. It posts one
PR comment ending in exactly one of:

- `FACTORY-TRIAGE: RETRY_ESCALATED` + a **diagnosis brief** (root cause, files,
  what both attempts missed). → The worker runs ONE more fixer+reviewer cycle
  with the brief injected, at **one tier higher** (sonnet→opus→fable;
  tier:fable retries at fable). Approve → merge queue. Reject → `needs-human`,
  no appeal.
- `FACTORY-TRIAGE: RELOCATE` + the scope reasoning. → The checker files a new
  properly-scoped, properly-tiered issue (with its own `mf-meta`), links both
  ways, and states whether the current PR is mergeable as-is (→ merge queue)
  or blocked (→ close PR, label issue `blocked-by:#N`). A RELOCATE-spawned
  issue that itself reaches triage gets **NEEDS_HUMAN directly** — chain depth
  is capped at 1.
- `FACTORY-TRIAGE: NEEDS_HUMAN` + a **distilled decision question** ("A or B,
  tradeoff is X") posted on the issue. → label `needs-human`, notify, move on.

Hard rule: at most one checker pass and at most one escalated retry per issue.
`needs-human` must mean "only a human can answer this", not "the factory gave up".

## 8. The merger (single, sequential — kills BEHIND races)

One merger, inside the master loop, processing `state/merge-queue/` FIFO:

1. Re-verify PR is open + approved verdict present (authoritative re-check).
2. `gh pr checks --watch --fail-fast`; on red, ONE ci-fix attempt (reuse the
   existing ci-fix call at the issue's tier), then re-gate; still red →
   checker-style `NEEDS_HUMAN` on the issue, dequeue.
3. Squash-merge. On BEHIND: reuse run.sh's proven re-gate block (update-branch,
   poll the new head's check runs, close/reopen kick if none appear, retry
   once). With a single merger this should be rare — only PRs queued behind a
   just-merged one pay it, one at a time.
4. Close issue, log `COST:` line via the existing `issue_cost` helper.

**Shared code**: extract `cc()`, `wait_for_capacity`/`api_ok`/`model_ok`,
`ledger_record`, `issue_cost`, `with_pack`, and the merge re-gate block from
`factory/run.sh` into `factory/lib.sh`, sourced by BOTH `run.sh` and the
multi-factory. This is the one permitted change to the single factory and it
must be purely mechanical (same function bodies, same env expectations); prove
it by running the single factory once end-to-end on a real issue afterward.
Extend `ledger_record` with an optional `factory`/`worker` field — existing
consumers (`usage-report.sh`) must keep working on old entries.

## 9. Compose & ops

- Compose project `bettertrack-multifactory`; `WORKERS` env (default 2) drives
  worker replica count; each worker gets an isolated state/repo volume; the
  `state/` protocol dir is one shared volume mounted in all containers.
- `multi-factory/autorun.sh` mirrors `factory/autorun.sh` (build + up), plus:
  **refuse to start if `bettertrack-factory` is running, and vice versa** —
  add the reverse guard to `factory/autorun.sh` (a 3-line check; allowed).
  The two factories must never run at the same time against the repo.
- Logging: keep the single factory's convention — ISO-timestamped lines for
  factory events (prefix them `[master]` / `[w1]` / `[w2]`), untimestamped
  agent stream via `tee` into per-container `factory.log`. `docker compose -p
bettertrack-multifactory pause`/`unpause` must behave like today (frozen runs
  fail their dead socket on resume and retry cleanly — `cc()` already handles it).
- gh auth, git identity, Docker mounts: copy the existing factory patterns.
  Never touch the read-only backup clone that holds `.env` files.

## 10. Token & capacity notes

All containers share one subscription. `wait_for_capacity` in each worker
independently is fine (they all sleep, all wake). Do not add polling LLM calls
anywhere; scheduler and merger must stay token-free. Target: tokens/issue
within ±10% of the single factory's ledger baseline (~$2.5–5 clean issues;
check `factory/usage-report.sh`).

## 11. Acceptance (test before calling it done)

1. **Dry-run mode** (`MF_DRY_RUN=1`): master composes/schedules against real
   issues but workers echo instead of calling `cc()`; verify assignment,
   conflict serialization (two issues with overlapping `touches` never run
   together), dependency gating, and stall detection with fabricated state files.
2. **Live shakedown**: 2 workers on a real batch containing at least 2
   lane-independent issues. Verify: both PRs built in parallel, merger landed
   them sequentially with zero failed BEHIND merges, ledger got per-worker
   entries, `COST:` lines logged.
3. **Checker path**: verify on the next naturally-rejected issue (or a
   deliberately under-scoped scratch issue) that triage produces one of the
   three verdicts and the caps hold (one checker pass, one escalated retry).
4. Single factory still works: one full issue cycle end-to-end after the
   `lib.sh` extraction.
5. All repo rules intact: PRs + `verify` green for every multi-factory commit,
   owner-identity commits, no attribution trailers.

Ship the work as 2–3 reviewable PRs: (1) `factory/lib.sh` extraction +
single-factory proof, (2) multi-factory core, (3) prompts + docs.

## 12. Genuinely open (builder decides, note the choice in the PR)

- Assignment mirror label name (`mf:worker-N` vs assignee field).
- Whether workers pre-fetch/warm their clone between assignments.
- Merge-queue file locking details (flock vs atomic rename discipline).

## 13. Out of scope

GitHub merge queue (native), >2 workers tuning, CI speedups, changes to branch
protection, the live preview, `factory/CHIEF.md`, and any app code. If you hit
an app bug while testing, file a normal factory issue — do not fix it inline.
