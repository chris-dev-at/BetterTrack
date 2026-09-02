# multi-factory.md — the parallel build factory

The multi-factory (`multi-factory/`) runs 1 **master** + N **workers** (default 2)
to roughly double wall-clock throughput while keeping tokens-per-issue within
±10% of the single factory. Full design rationale: `multi-factory/BRIEF.md`.
The single factory (`factory/`) stays intact as the fallback; both source the
same `factory/lib.sh` internals, and **the two must never run at the same time**
(both `autorun.sh` launchers enforce it).

## Roles

| Role      | Where  | Model (via difficulty routing)       | What                                                                   |
| --------- | ------ | ------------------------------------ | ---------------------------------------------------------------------- |
| Composer  | master | `roles.composer` slot (default hard) | planner v2 — issues carry an `mf-meta` block (deps/touches)            |
| Scheduler | master | none (pure bash)                     | assigns runnable, non-conflicting issues to idle workers               |
| Merger    | master | none (pure bash)                     | the ONLY thing that merges; FIFO-preferring queue, one ci-fix, re-gate |
| Writer    | worker | issue difficulty                     | same prompt as the single factory                                      |
| Reviewer  | worker | issue difficulty, ≥ review floor     | same prompt/rules                                                      |
| Fixer     | worker | issue difficulty                     | same prompt/rules                                                      |
| Checker   | worker | `roles.checker` slot (default hard)  | triage after failed rounds: escalate / relocate / human                |
| ci-fix    | master | issue difficulty                     | one CI-repair attempt before needs-human                               |

The merge queue is FIFO-**preferring**, not strictly serial: each tick inspects up
to `MF_MERGE_LOOKAHEAD` records (default 5; invalid values reset to 5, then the
value is clamped to 1–10) in FIFO order and skips past entries that are only
_deferred_ — CI still pending, or a merge command GitHub refused — so an
already-CLEAN PR behind them is not starved. Queue files are never reordered or
rewritten, and at most one merge lands per tick, so the oldest genuinely
mergeable record always wins.

**The merge lane outranks the composer.** A successful composer run blocks the
whole tick for ~45 min, which freezes merging as well as scheduling. So
`composer_step` returns early — logging `composer deferred: merge queue
non-empty` — whenever any `<epoch>-prNN.json` record is waiting. Owner briefs
are exempt in **both** their states: an already-claimed one
(`.composer-request-active.json`, reconciled above the mode gate) and a fresh
`control/composer-request.json` that has not been claimed yet — the claim
happens _below_ this guard, so the guard has to test the file, not just the
loaded flag. Consequence worth knowing: a permanently stuck queue record stops
ordinary composition, which is intended (drain the lane, then compose), but it
never blocks a brief you write yourself.

**Review-requeue budget.** An approval that keeps invalidating used to send the
same issue back through review forever (#1232 burned 140 reviewer runs).
`requeue_for_review` now counts requeues per issue in
`state/control/requeue-count/<issue>` and parks the issue with a human once the
count passes `MF_REQUEUE_MAX` (default 3, set to `3` for the master service in
`compose.yml`). The counter is keyed by **issue**, so it survives the new PR and
new head that a requeue produces, and it is deliberately never cleared — the
budget is a lifetime bound on re-entering review, not a per-cycle allowance.
An in-budget requeue leaves the PR's merge-refusal counter alone; the
over-budget park retires the PR for good and therefore clears both that counter
and the CI-fix state along with the queue record.

> **Re-arming a parked issue.** Because the counter is never cleared
> automatically, fixing the issue and removing `needs-human` is not enough — the
> very next requeue parks it again immediately. Delete the counter too:
>
> ```bash
> rm -f multi-factory/state/control/requeue-count/<issue>
> ```

## Difficulty routing & model providers (mflib.sh)

Issues are classified by **difficulty**, not by model — exactly one label:

| Label               | Color       | Meant for                                                                                                                |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `diff:easy`         | blue        | trivial/mechanical: docs, config/CI, placeholders, tiny CRUD                                                             |
| `diff:normal`       | light green | standard well-scoped features: plain UI pages, simple endpoints, e2e                                                     |
| `diff:intermediate` | dark green  | cross-cutting/stateful: auth/PIN, schema/migrations, jobs, realtime                                                      |
| `diff:hard`         | purple      | complex engine/architecture: domain core (`apps/api/src/domain/**` + `packages/domain/src/**`), provider/caching, search |
| `diff:max`          | red         | keystone/critical path + plan-deviation design decisions                                                                 |

The owner maps each difficulty to a **provider + model + effort** in the
dashboard's **Models** tab, persisted to `state/control/models.json` and read
fresh by `multi-factory/mflib.sh` before every agent run — **saving applies
from the next role run, no restart**. Escalation = one difficulty up (max stays
max); reviews never run below `roles.reviewFloor` (default intermediate).
Legacy `tier:*` labels still resolve (sonnet→easy, opus→intermediate,
fable→max); unlabeled issues run as intermediate.

Four subscription providers (per-provider effort semantics), plus one API-key
provider (`opencode`, below):

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
- **opencode** — the opencode CLI (Bun binary, installed by
  `multi-factory/opencode-install.sh`). **Not a subscription**: it authenticates
  with an API key held in `auth/<service>/opencode/share/opencode/auth.json`, and
  the three XDG vars are pointed at the single `MF_OPENCODE_HOME` mount so the
  whole opencode footprint stays in one bind mount. Routes are declared in the
  read-only `opencode-factory.json` (models are `provider/model`, e.g.
  `openrouter/stealth/ox-alpha`), which also carries opencode's permission
  policy (`webfetch` denied; `curl`/`wget`/`env`/`printenv` and the cloud CLIs
  denied at the bash layer). `opencode run` exits 0 even on failure, so
  `mflib.sh` classifies the `--format json` event stream rather than the exit
  code. **Read the data-exposure warning at the top of `mflib.sh` before routing
  any difficulty here** — an opencode role sees the checkout and can reach a
  third-party model provider. It is wired up but has never run a production
  role.

Usage-limit naps are bounded: a ClaudeX/Codex run that keeps hitting the
provider's usage limit sleeps `LIMIT_SLEEP` and retries at most
`MF_LIMIT_NAPS_MAX` times (default 8, set explicitly for every service in
`compose.yml`) before the role run fails and hands the issue to the normal
retry/triage path. Without the cap a quota-dead provider napped forever and the
worker looked alive while doing nothing.

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
during a claude outage. Non-Claude subscription runs retain `cost_usd: 0` as the
billing field and record token counts plus `api_equivalent_usd` when pricing is
known. Dashboard money totals, model/role/issue breakdowns, and daily charts use
that API-equivalent value for OpenAI-family rows, so ClaudeX/native Codex are not
displayed as free work.

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
estimate is retained separately as `api_equivalent_usd`; per-model `costUSD`
values are retained in the sanitized `model_usage` map. Analytics prefer those
CLI estimates, fall back to complete token telemetry plus the public standard
rate table when necessary, and label every result API-equivalent. They are
treated as money for internal economics, but they are not an invoice.
See [OpenAI's billing explanation](https://help.openai.com/en/articles/8156019).

## Scheduling in one paragraph

The composer ends every issue body with `<!-- mf-meta … -->`: `depends-on`
(issue numbers that must be closed first) and `touches` (path-prefix claims).
An issue is **runnable** when it's open + `autopilot` + unassigned + all deps
closed (checked via direct REST reads — never the lagging search index). It may
be **assigned** only when none of its claims overlaps any in-flight claim
(assigned issues + PRs still in the merge queue). Claims are compared by
stripping everything from the first `*` and testing string-prefix both ways.
No/unparseable meta ⇒ the issue claims `**`, which conflicts with **everything**
and silently serialized the whole fleet behind it. The scheduler therefore does
not run it: it labels the issue **`mf:bad-meta`**, logs `scheduler: issue #N has
empty mf-meta touches — labeled mf:bad-meta, skipped`, and moves on;
`runnable_issues` drops `mf:bad-meta` issues on every later tick, so the label
is the durable record. Fix the issue body's `mf-meta` block and remove the label
to let it back in. (The label is re-applied once per idle worker within the tick
that detects it — harmless, and it stops after that tick.) Assignment:
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

**Dependency priming.** Before each cycle the worker runs
`pnpm install --frozen-lockfile --prefer-offline` outside the billed model
session, so a moved lockfile does not make the writer install on model time. It
is bounded by `MF_PNPM_PRIME_TIMEOUT` (default 600 s) and is non-fatal either
way — the writer installs if it failed. The timeout is not optional: this runs
before the role loop, outside every heartbeat-refreshing `cc()` call, so an
unreachable registry would otherwise hang with a _fresh_ heartbeat, which the
stall detector cannot see (the 2026-08-19 DNS-wedge failure class).

## The protocol dir (`multi-factory/state/`, bind-mounted at `/work/mfstate`)

- `assignments/worker-N.json` — master-written (atomic tmp+mv), removed on ack
- `status/worker-N.json` + `worker-N.hb` — worker phase + heartbeat (touched
  ≥ every 5 min even inside hour-long `cc()` calls; a heartbeat older than
  `MF_STALL_SECS` (default 3600 s) with an assignment present triggers
  killed-mid-run recovery: authoritative GH re-check → salvage approved PR to
  the queue, or reset labels + assignment for rescheduling)
- `merge-queue/<epoch>-prNN.json` — FIFO-preferring, consumed by the merger only
  (the dir also holds the merger's own dotfile counters, `.mergefail-prNN` and
  `.apprfail-prNN`; only `<epoch>-prNN.json` records are queue entries)
- `control/mode` — `run` | `run-out` | `close-down` (owner/dashboard-written)
- `control/phase` — `running` | `draining` | `drained` (master-written)
- `control/requeue-count/<issue>` — the per-issue review-requeue budget
  (`MF_REQUEUE_MAX`); never cleared, so it bounds an issue's lifetime
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
The current console is served at `/`; the frozen pre-redesign console remains
available at `/legacy` (and `/legacy/`) against the same live control APIs.

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

`test.sh` runs entirely offline against stubs — **no containers, no Docker, no
network** — so it is the right check while the daemon is down or restarting.

**Standing fleet shape: `WORKERS=2`** (the value in `state/control/workers`, or
2 when that file is absent). `compose.yml` defines exactly `master`, `worker-1`
and `worker-2`; `autorun.sh` only generates `compose.extra.yml` for worker 3+
when `WORKERS > 2`, and that file is generated, gitignored, and never committed.

**Relaunching a script change without rebuilding the image.** Every `*.sh`,
prompt and `opencode-factory.json` is bind-mounted read-only into the
containers, so editing one and recreating the containers is enough — an image
rebuild is only needed when `factory/Dockerfile` changes (a pinned CLI version):

```bash
cd multi-factory && docker compose -p bettertrack-multifactory \
  -f compose.yml -f compose.dnsfix.yml up -d --force-recreate --no-build
```

(`autorun.sh` always runs `dc build` first; the image layer is cached, so it is
also fine — just slower.) Note that the containers keep the file **the deploy
worktree** holds, not the one in your checkout: after merging a factory change,
update the deploy worktree too or the fleet keeps running the old script.

Optional clean-runtime overlays are supported without editing the committed
Compose file:

```bash
MF_COMPOSE_OVERRIDE=/absolute/path/runtime.yml ./multi-factory/autorun.sh
```

`compose.dnsfix.yml` is a committed, **temporary** overlay from the 2026-08-19
Docker Desktop DNS wedge: it pins every service to the default bridge and sets
explicit resolvers, because the user-defined bridge black-holed port 53 and the
containers inherited `8.8.8.8` first — the factory then ran for hours with no
outbound DNS while looking like a GitHub outage. Apply it with
`-f compose.yml -f compose.dnsfix.yml`. **Caveat:** it carries stanzas for
`master`, `worker-1` and `worker-2` only. The worker-3/worker-4 stanzas were
removed with the `WORKERS=2` downscale, because an overlay-only service that has
no counterpart in `compose.yml`/`compose.extra.yml` has no image and Compose
refuses the whole project. If the fleet ever scales past 2, re-add the same
`network_mode` + `dns` block per worker. Retire the file once a Mac reboot
clears the NAT state — and verify DNS from inside a container first.

Exactly one additional Compose file is accepted and is retained for build, up,
dry-run, login, logs, stop, down, fresh, and generated worker 3/4 operations.
Every lifecycle command explicitly targets the `bettertrack-multifactory`
project; an inherited `COMPOSE_PROJECT_NAME` or an overlay's top-level `name:`
cannot redirect those operations to another Compose project.
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
independently (`LIMIT_SLEEP`), scheduler and merger stay token-free. The
dashboard's general daily chart groups economic estimates by Claude versus
Codex provider family, not by single- versus multi-factory harness.
