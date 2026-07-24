# multi-factory.md — the parallel build factory

The multi-factory (`multi-factory/`) runs 1 **master** + N **workers** (default 2)
to roughly double wall-clock throughput while keeping tokens-per-issue within
±10% of the single factory. Full design rationale: `multi-factory/BRIEF.md`.
The single factory (`factory/`) stays intact as the fallback; both source the
same `factory/lib.sh` internals, and **the two must never run at the same time**
(both `autorun.sh` launchers enforce it).

## Roles

| Role      | Where  | Model (via difficulty routing)       | What                                                        |
| --------- | ------ | ------------------------------------ | ----------------------------------------------------------- |
| Composer  | master | `roles.composer` slot (default hard) | planner v2 — issues carry an `mf-meta` block (deps/touches) |
| Scheduler | master | none (pure bash)                     | assigns runnable, non-conflicting issues to idle workers    |
| Merger    | master | none (pure bash)                     | the ONLY thing that merges; FIFO queue, one ci-fix, re-gate |
| Writer    | worker | issue difficulty                     | same prompt as the single factory                           |
| Reviewer  | worker | issue difficulty, ≥ review floor     | same prompt/rules                                           |
| Fixer     | worker | issue difficulty                     | same prompt/rules                                           |
| Checker   | worker | `roles.checker` slot (default hard)  | triage after failed rounds: escalate / relocate / human     |
| ci-fix    | master | issue difficulty                     | one CI-repair attempt before needs-human                    |

## Difficulty routing & model providers (mflib.sh)

Issues are classified by **difficulty**, not by model — exactly one label:

| Label               | Color       | Meant for                                                            |
| ------------------- | ----------- | -------------------------------------------------------------------- |
| `diff:easy`         | blue        | trivial/mechanical: docs, config/CI, placeholders, tiny CRUD         |
| `diff:normal`       | light green | standard well-scoped features: plain UI pages, simple endpoints, e2e |
| `diff:intermediate` | dark green  | cross-cutting/stateful: auth/PIN, schema/migrations, jobs, realtime  |
| `diff:hard`         | purple      | complex engine/architecture: domain core, provider/caching, search   |
| `diff:max`          | red         | keystone/critical path + plan-deviation design decisions             |

The owner maps each difficulty to a **provider + model + effort** in the
dashboard's **Models** tab, persisted to `state/control/models.json` and read
fresh by `multi-factory/mflib.sh` before every agent run — **saving applies
from the next role run, no restart**. Escalation = one difficulty up (max stays
max); reviews never run below `roles.reviewFloor` (default intermediate).
Legacy `tier:*` labels still resolve (sonnet→easy, opus→intermediate,
fable→max); unlabeled issues run as intermediate.

Four subscription providers (per-provider effort semantics):

- **claude** — claude CLI, auth via `CLAUDE_CODE_OAUTH_TOKEN` (factory/.env);
  effort = `--effort low|medium|high|xhigh|max`.
- **claudex** — the Claude Code agent harness routed through
  [Claude Code Router](https://github.com/musistudio/claude-code-router) (CCR)
  to the local Codex OAuth login; model selectors are passed explicitly as
  `codex-api/<model>`. CCR is a third-party, experimental compatibility bridge,
  not an OpenAI-supported Claude Code integration. It is a separate option and
  does not replace either `claude` or native `codex`.
- **codex** — OpenAI codex CLI, auth from the host's `~/.codex/auth.json`
  (ChatGPT login); effort =
  `model_reasoning_effort low|medium|high|xhigh|max|ultra` where supported by
  the selected model; models e.g. `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`
  (free-text for new ones).
- **gemini** — Google **Antigravity CLI (`agy`)**, auth from the host's
  `~/.gemini` Google login; the reasoning level is part of the model name,
  e.g. `Gemini 3.1 Pro (High)`, `Gemini 3.5 Flash (Low)` (`agy models` lists
  what the subscription offers — the dashboard shows them as suggestions).

Auth for codex/ClaudeX/agy is synced by `autorun.sh` from the host into gitignored
**per-container** copies under `multi-factory/auth/<service>/` (bind-mounted
over the container HOME, rw so token refreshes persist; a copy is only
overwritten when the host file is newer). **Nothing under `auth/` or `state/`
is ever committed.** Each service also has its own writable
`auth/<service>/ccr/` directory; CCR databases are never shared between
containers. `auth.json` and, when present, `models_cache.json` are copied into
each service's Codex home. If a difficulty routes to a provider that is not logged
in, its runs fail → the normal retry/triage path applies; the Models tab shows
per-provider connection status and a provider-specific Test button. ClaudeX
testing runs in the actual master service, or in a one-off container built from
that same service while it is stopped, so it exercises the factory image,
isolated auth/CCR mounts, direct gateway, and Claude Code route rather than a
host-only CLI shortcut.
Claude capacity gating (`wait_for_capacity`) only blocks startup while some
difficulty actually routes to claude — a claudex/codex/gemini-only config starts fine
during a claude outage. Non-claude runs land in the ledger with `cost_usd: 0`
(subscription) and whatever token counts the CLI reports.

ClaudeX bootstrap is idempotent and runs inside the selected service. It pins
CCR `3.0.7`, imports only the local `codex-api` candidate, requires provider ID
and name `codex-api`, requires the `chatgpt.com/backend-api/codex` upstream and
OAuth marker, keeps exactly two flat OAuth plugins, disables request-body
logging and direct `api.openai.com` providers, and binds both CCR services to
loopback. The normal `claude` and `codex` profiles are disabled only inside the
service's isolated CCR configuration; their native factory routes are unchanged.

The official OpenAI billing systems for ChatGPT subscriptions and API projects
are separate. ClaudeX therefore records actual `cost_usd: 0` for this
subscription route. Claude Code's pre-normalization local `total_cost_usd`
estimate is retained separately as `api_equivalent_usd`; it is not an invoice.
See [OpenAI's billing explanation](https://help.openai.com/en/articles/8156019).

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
one difficulty higher, with the checker's diagnosis brief injected),
`RELOCATE` (checker files a properly-scoped follow-up issue labeled
`mf:relocated`; the current PR merges as-is or is closed with the dependency
written back into the issue's mf-meta), or `NEEDS_HUMAN` (a distilled A-or-B
question lands on the issue). Caps: one checker pass, one escalated retry,
relocate chain depth 1. `needs-human` means "only a human can answer this".

**Branch salvage (never lose writer output).** Right after the writer returns
(success OR failure), before any verdict handling, the worker checks its clone: if
the working tree is dirty or `task/N` carries commits not on `main` **and no PR
exists yet**, it commits (`chore(salvage): …`) and pushes `task/N` to origin,
logging a `salvaged branch task/N` event line. The failure paths then point at the
pushed branch, so a retry/relocate/checker or the next run's reviewer can pick the
work up instead of it evaporating in the worker's clone volume (the manual
salvage-from-volume drill after `needs-human`). The normal happy path — where the
writer opened its own PR — is a no-op (a PR already exists).

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
./multi-factory/test.sh             # offline scheduler+provider+protocol+control tests
node multi-factory/control/server.mjs   # dashboard on 127.0.0.1:8790
docker compose -p bettertrack-multifactory pause|unpause   # freeze/thaw (cc() survives)
```

Optional clean-runtime overlays are supported without editing the committed
Compose file:

```bash
MF_COMPOSE_OVERRIDE=/absolute/path/runtime.yml ./multi-factory/autorun.sh
```

Exactly one additional Compose file is accepted and is retained for build, up,
dry-run, login, logs, stop, down, fresh, and generated worker 3/4 operations.
For isolated acceptance routing, `MF_MODELS_FILE` is passed through to every
service; the overlay must mount that file at the same container path. The normal
default remains `/work/mfstate/control/models.json`.

Inside a running service (or a one-off service with the same mounts):

```bash
node /work/mf/ccr-ensure.mjs --status-json
/work/mf/provider-test.sh claudex gpt-5.6-sol high
```

With `--status-json`, the first command only validates the existing route and
returns sanitized no-model-call status; it never starts, bootstraps, repairs, or
reconfigures CCR. Run `node /work/mf/ccr-ensure.mjs` without that flag when a
normal idempotent start/repair is intended. The provider test performs both a
direct `DIRECT_OK` gateway proof and a one-turn Claude Code `CLAUDEX_OK` proof;
success requires the exact requested selector in `modelUsage`. Both commands
emit no credentials, local client key, service URL, raw result, or response
text.

Ledger: same `factory/usage/ledger.jsonl`; multi-factory records carry extra
`factory`/`worker` fields; `factory/usage-report.sh` works unchanged. Token
capacity: all containers share the subscription; each `cc()` waits limits out
independently (`LIMIT_SLEEP`), scheduler and merger stay token-free.
