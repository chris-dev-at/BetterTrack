# STARTAUTOMATE.md — Autonomous Build Factory Runbook

**Audience: a future Claude Code session.** When the owner says "start automating — follow STARTAUTOMATE.md", execute this document top to bottom. The end state: a Docker container ("the factory") running on this machine that continuously plans issues, implements them, reviews them, and merges them — pausing on its own when subscription tokens run out and resuming when they replenish. The owner leans back and watches.

Do not execute this runbook unless the owner explicitly asked to start automating.

> **Status (2026-06-15): the factory is already materialized and hardened in `factory/`.**
> Launch/relaunch it with one command — `./factory/autorun.sh` — which tears down any
> duplicate instances, builds, and starts a single container (compose project
> `bettertrack-factory`, restart policy `unless-stopped`). The **live files in `factory/`
> are the source of truth**; the code blocks in §4 below are the original reference and
> have since been hardened. Key hardening over the original:
> - **Token/limit waiting** uses a structured probe (`claude -p --output-format json`,
>   `is_error`) plus a cheap capacity probe, so exhausted tokens make it *wait and
>   auto-resume* instead of burning issues to `needs-human` (the original text-grep missed
>   the limit and failed every issue in seconds).
> - **Model availability**: `tier:fable` issues are *skipped* (not failed) while
>   `claude-fable-5` is unavailable, and resume automatically when it returns.
> - **Volume ownership**: the image owns `/work/state` as the `factory` user so a fresh
>   named volume is writable.
> - **Prompts** are bind-mounted from `factory/prompts/` (tune + restart, no rebuild).
> Ops: `./factory/autorun.sh --logs` (watch) · `--stop` / re-run to resume · `--fresh`
> (wipe state) · `--smoke` (one issue, foreground). Hard stop:
> `sudo docker compose -p bettertrack-factory exec factory touch /work/state/STOP`.

---

## 0. Non-negotiables

These override anything else, including owner convenience:

1. **No factory without CI.** If the repo has no GitHub Actions workflow that runs typecheck + tests on PRs, ABORT and tell the owner the base phase isn't done. The CI gate is the factory's immune system.
2. **The factory never pushes to `main`.** All work goes through PRs; merges happen only via the gate (CI green + reviewer approval). Branch protection enforces this even against bugs in the factory itself.
3. **`--dangerously-skip-permissions` runs only inside the factory container.** Never on the host. The container has exactly: a fresh clone of the repo, a repo-scoped GitHub token, and the Claude token. Nothing else to break.
4. **The factory's clone is its own.** It clones from GitHub into the container volume. It never touches the owner's working copy at `~/projects/BetterTrack`.
5. **Scope comes from PROJECTPLAN.md.** The planner creates issues only for v1 (P0–P6) until v1 is complete; after that, §14 Future Features per the `AFTER_V1` setting. It never invents features.
6. **Stuck means stop.** When `needs-human` issues pile up past the threshold, the factory pauses and notifies instead of plowing ahead.

## 1. Architecture

Four bots, one serial loop (one task at a time — no merge-conflict roulette):

```
┌─────────┐   creates issues    ┌─────────┐   opens PR    ┌──────────┐   verdict   ┌────────┐
│ PLANNER  │ ──────────────────▶│ WRITER  │ ─────────────▶│ REVIEWER │ ───────────▶│  GATE  │──▶ merge
│ keeps the│  (when backlog<N)  │ branch,  │               │ fresh    │  APPROVE /  │ CI green│
│ queue    │                    │ implement│◀── fix rounds │ context, │  CHANGES    │ + appr. │
│ full     │                    │ test,push│   (max 2)     │ /review  │             │        │
└─────────┘                    └─────────┘               └──────────┘             └────────┘
```

- **Planner** ("the idea guy"): reads PROJECTPLAN.md §13 milestones, MODELUSE.md, the repo's current state, and open/closed issues; files the next batch of small, immediately-actionable issues with acceptance criteria and a tier label. Runs whenever open `autopilot` issues drop below `MIN_BACKLOG`.
- **Writer**: implements exactly one issue on branch `task/<n>`, runs typecheck + unit tests locally, pushes, opens a PR with `Closes #<n>`.
- **Reviewer**: a *separate* `claude -p` invocation (fresh context = independent reviewer), reviews the PR against the issue's acceptance criteria, posts findings, ends with a machine-readable verdict line.
- **Gate** (plain bash, no model): merges only when reviewer approved AND GitHub CI is green. One CI-fix round allowed, then `needs-human`.

Model routing follows MODELUSE.md via issue labels: `tier:fable` → `claude-fable-5`, `tier:opus` → `claude-opus-4-8`, `tier:sonnet` → `claude-sonnet-5`. No label → Opus (rule: unsure = higher). Reviews run on Opus, except `tier:fable` PRs which are reviewed by Fable.

Token exhaustion: every `claude -p` call is wrapped in a retry that detects the usage-limit error, sleeps `LIMIT_SLEEP`, and tries again. That single wrapper IS the "wait for tokens to replenish" behavior.

## 2. Configuration (factory/.env)

| Variable | Default | Meaning |
|---|---|---|
| `REPO` | `chris-dev-at/BetterTrack` | GitHub repo |
| `GH_TOKEN` | — (required) | Fine-grained PAT, this repo only: Contents RW, Issues RW, Pull requests RW, Actions R |
| `CLAUDE_CODE_OAUTH_TOKEN` | — (required) | From `claude setup-token` (subscription auth for headless) |
| `FACTORY_WEBHOOK_URL` | empty | Optional Discord/ntfy webhook for merge/failure/limit notifications |
| `MIN_BACKLOG` | `3` | Planner runs when open autopilot issues < this |
| `PLANNER_BATCH` | `5` | Max issues planner creates per run |
| `MAX_FIX_ROUNDS` | `2` | Review→fix cycles before `needs-human` |
| `LIMIT_SLEEP` | `1800` | Seconds to sleep on usage-limit before retry |
| `STUCK_LIMIT` | `5` | Open `needs-human` count that pauses the factory |
| `AFTER_V1` | `propose` | When P0–P6 done: `propose` = draft §14 issues labeled `awaiting-owner` and notify; `auto` = keep building §14 in leverage order; `stop` = idle + notify |
| `ONE_SHOT` | `0` | `1` = process a single issue then exit (used for the smoke run) |

## 3. Phase A — Preflight (on the host, interactive)

1. **Verify base phase**: CI workflow exists (`.github/workflows/*.yml` running typecheck + tests on `pull_request`) and is green on `main` (`gh run list --branch main -L 1`). If not → ABORT per §0.1.
2. **Tools**: `git`, `docker`, `docker compose`, `gh` (authed: `gh auth status`) on the host.
3. **Labels** (idempotent):
   ```sh
   for l in "autopilot:0E8A16" "in-progress:FBCA04" "needs-human:D93F0B" \
            "awaiting-owner:5319E7" "tier:fable:B60205" "tier:opus:D4C5F9" "tier:sonnet:C2E0C6"; do
     gh label create "${l%:*}" --color "${l##*:}" --force -R "$REPO"
   done
   ```
4. **Branch protection** on `main`: require the CI status check (use the actual job name from the workflow file) and forbid direct pushes:
   ```sh
   gh api -X PUT "repos/$REPO/branches/main/protection" \
     -F required_status_checks[strict]=true -F "required_status_checks[contexts][]=ci" \
     -F enforce_admins=false -F required_pull_request_reviews=null -F restrictions=null
   ```
5. **Tokens** — ask the owner to run these themselves (they're interactive / secret-producing):
   - `! claude setup-token` → paste result as `CLAUDE_CODE_OAUTH_TOKEN` into `factory/.env`
   - Create the fine-grained PAT in GitHub settings → `GH_TOKEN` in `factory/.env`
   - `chmod 600 factory/.env`; confirm `factory/.env` is in `.gitignore` (add it).

## 4. Phase B — Materialize the factory files

Create the `factory/` directory with exactly these files (adapt only the CI job name and anything the repo has since renamed; report every adaptation to the owner).

### factory/Dockerfile
```dockerfile
FROM node:22-bookworm
RUN apt-get update && apt-get install -y git curl jq \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/* \
 && corepack enable && npm install -g @anthropic-ai/claude-code
RUN useradd -m factory
USER factory
WORKDIR /work
COPY --chown=factory run.sh /work/run.sh
ENTRYPOINT ["bash", "/work/run.sh"]
```

### factory/compose.yml
```yaml
services:
  factory:
    build: .
    env_file: .env
    restart: unless-stopped
    volumes:
      - factory-work:/work/state
volumes:
  factory-work:
```

### factory/run.sh
```bash
#!/usr/bin/env bash
set -uo pipefail
STATE=/work/state; REPO_DIR=$STATE/repo; LOG=$STATE/factory.log
MF=claude-fable-5; MO=claude-opus-4-8; MS=claude-sonnet-5

log(){ printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }
notify(){ log "NOTIFY: $*"; [ -n "${FACTORY_WEBHOOK_URL:-}" ] && \
  curl -fsS -m10 -H 'Content-Type: application/json' \
    -d "{\"content\":\"🏭 BetterTrack factory: $*\"}" "$FACTORY_WEBHOOK_URL" >/dev/null || true; }

# claude -p with usage-limit wait — this is the "sleep until tokens replenish" mechanism
cc(){ local model=$1; shift
  while true; do
    local out rc; out=$(claude -p "$*" --model "$model" --dangerously-skip-permissions 2>&1); rc=$?
    printf '%s\n' "$out" >> "$LOG"
    if [ $rc -ne 0 ] && grep -qiE 'usage limit|rate.?limit|limit (will )?reset' <<<"$out"; then
      notify "usage limit hit — sleeping $((LIMIT_SLEEP/60)) min"; sleep "$LIMIT_SLEEP"; continue
    fi; return $rc
  done
}

tier_model(){ case "$(gh issue view "$1" --json labels -q '.labels[].name' | grep '^tier:' || true)" in
  tier:fable) echo "$MF";; tier:sonnet) echo "$MS";; *) echo "$MO";; esac; }

mark_human(){ gh issue edit "$1" --add-label needs-human --remove-label autopilot,in-progress
  notify "issue #$1 → needs-human ($2)"; }

# ---- bootstrap ----
[ -d "$REPO_DIR/.git" ] || git clone "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$REPO_DIR"
cd "$REPO_DIR"
git config user.name "bettertrack-factory"; git config user.email "factory@bettertrack.local"
export GH_REPO="$REPO"
notify "factory started"

while true; do
  [ -f "$STATE/STOP" ] && { notify "STOP file present — exiting"; exit 0; }
  git checkout -q main && git pull -q

  # stuck guard
  stuck=$(gh issue list --label needs-human --state open --json number -q 'length')
  if [ "$stuck" -ge "${STUCK_LIMIT:-5}" ]; then
    notify "$stuck issues need a human — pausing 1h"; sleep 3600; continue; fi

  # planner: keep the queue full
  backlog=$(gh issue list --label autopilot --state open --json number -q 'length')
  if [ "$backlog" -lt "${MIN_BACKLOG:-3}" ]; then
    log "backlog=$backlog → running planner"
    cc "$MO" "$(cat /work/state/prompts/planner.md)"
    backlog=$(gh issue list --label autopilot --state open --json number -q 'length')
    [ "$backlog" -eq 0 ] && { notify "planner produced nothing (v1 done or awaiting owner) — idling 2h"; sleep 7200; continue; }
  fi

  # pick oldest actionable issue
  n=$(gh issue list --label autopilot --state open --json number -q 'sort_by(.number)|.[0].number')
  gh issue edit "$n" --add-label in-progress
  log "=== issue #$n ==="

  # WRITER
  if ! cc "$(tier_model "$n")" "$(sed "s/{{N}}/$n/g" /work/state/prompts/writer.md)"; then
    mark_human "$n" "writer failed"; continue; fi
  pr=$(gh pr list --head "task/$n" --json number -q '.[0].number')
  [ -z "$pr" ] && { mark_human "$n" "no PR appeared"; continue; }

  # REVIEW → FIX rounds
  approved=0
  for round in $(seq 1 "${MAX_FIX_ROUNDS:-2}"); do
    rmodel=$MO; [ "$(tier_model "$n")" = "$MF" ] && rmodel=$MF
    cc "$rmodel" "$(sed "s/{{PR}}/$pr/g; s/{{N}}/$n/g" /work/state/prompts/reviewer.md)"
    verdict=$(gh pr view "$pr" --json comments -q '.comments[].body' | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1)
    [ "$verdict" = "FACTORY-VERDICT: APPROVE" ] && { approved=1; break; }
    log "round $round: changes requested"
    cc "$(tier_model "$n")" "$(sed "s/{{PR}}/$pr/g" /work/state/prompts/fixer.md)"
  done
  [ "$approved" -eq 1 ] || { mark_human "$n" "review not clean after ${MAX_FIX_ROUNDS} rounds"; continue; }

  # GATE: CI green (one automated fix attempt), then merge
  if ! gh pr checks "$pr" --watch --fail-fast; then
    log "CI red — one fix attempt"
    cc "$(tier_model "$n")" "CI failed on PR #$pr of $REPO. cd into the repo, check out the PR branch, run 'gh pr checks $pr' and 'gh run view --log-failed' to see why, fix it properly (no test-deletion, no skips), run the tests locally, push."
    gh pr checks "$pr" --watch --fail-fast || { mark_human "$n" "CI red after fix attempt"; continue; }
  fi
  if gh pr merge "$pr" --squash --delete-branch; then
    gh issue edit "$n" --remove-label in-progress,autopilot >/dev/null 2>&1 || true
    notify "merged PR #$pr (issue #$n) ✅"
  else
    mark_human "$n" "merge failed"
  fi
  [ "${ONE_SHOT:-0}" = "1" ] && { log "ONE_SHOT done"; exit 0; }
done
```

### factory/prompts/planner.md
```
You are the PLANNER for the BetterTrack autonomous build factory, running inside its sandbox clone.
Goal: keep the implementation queue full of small, immediately-actionable GitHub issues.

Do, in order:
1. cd into the repo. Read PROJECTPLAN.md (§13 milestones are the build order; feature specs in §5–§7), MODELUSE.md, and CLAUDE.md.
2. Survey reality: what exists in the code, what's merged. List open AND closed issues (gh issue list --state all) so you never duplicate.
3. Determine the current phase (earliest P0–P6 milestone whose acceptance criteria are not yet met by the code).
4. Create up to $PLANNER_BATCH new issues — only work that is actionable RIGHT NOW (its dependencies already merged). Each issue:
   - Title: "[P<phase>] <verb> <thing>" — one coherent work package a single agent run can finish.
   - Body: ## Context (PROJECTPLAN § references) · ## Scope (exact files/dirs) · ## Acceptance criteria (testable checkboxes — these are what the reviewer grades against) · ## Out of scope.
   - Labels: autopilot + exactly one tier label per MODELUSE.md (tier:fable for apps/api/src/domain/** and the provider/caching/currency core; tier:opus for auth/admin/schema/jobs/realtime/Builder/sharing; tier:sonnet for CRUD/UI/config/docs; unsure → higher tier).
5. If ALL of P0–P6 is complete: follow AFTER_V1 — "propose": draft the next 5 issues from PROJECTPLAN §14 in its leverage order, label them awaiting-owner (NOT autopilot), and say so in a comment on the newest one; "auto": label them autopilot directly; "stop": create nothing.
6. Never create issues outside PROJECTPLAN v1 + §14. Never re-open or duplicate existing ones.
```

### factory/prompts/writer.md
```
You are the WRITER for the BetterTrack factory, in its sandbox clone. Implement GitHub issue #{{N}} — that issue only.

1. cd into the repo, sync main, read issue #{{N}} (gh issue view {{N}}), read the PROJECTPLAN.md sections it references, and CLAUDE.md.
2. If the issue is ambiguous, already done, or its acceptance criteria can't be met as written: comment your analysis on the issue, apply label needs-human and remove autopilot, and STOP. Do not open a PR you don't believe in.
3. Otherwise: branch task/{{N}} off main. Implement exactly the issue scope — nothing extra. Follow PROJECTPLAN specs to the letter; tests required by the issue land in the same change.
4. Verify locally: typecheck + lint + the relevant unit/domain tests must pass. Never delete or skip a failing test to get green.
5. Push the branch and open a PR: title from the issue, body containing "Closes #{{N}}", a summary of what you did, and the real test output.
```

### factory/prompts/reviewer.md
```
You are the REVIEWER for the BetterTrack factory — an independent reviewer with fresh context. Review PR #{{PR}} (implements issue #{{N}}).

1. cd into the repo. Read issue #{{N}} (the acceptance criteria are the contract), then the full diff (gh pr diff {{PR}}) with enough surrounding code to judge correctness.
2. Hunt for: acceptance criteria not actually met, correctness bugs (especially money math — rounding, currency, off-by-one), security issues (ownership scoping, auth, token handling), missing/weakened tests, scope creep beyond the issue.
3. Post ONE review comment on the PR (gh pr comment) listing findings with file:line, each marked [blocking] or [nit].
4. The comment MUST end with exactly one of these lines, alone on the last line:
FACTORY-VERDICT: APPROVE
FACTORY-VERDICT: REQUEST_CHANGES
Approve only if there are zero [blocking] findings. Nits alone are not grounds to block.
```

### factory/prompts/fixer.md
```
You are the WRITER returning to PR #{{PR}} in the BetterTrack factory sandbox clone.
Read the latest review comment on the PR (gh pr view {{PR}} --comments). Address every [blocking] finding properly — no suppressions, no test-weakening. Address [nit]s where cheap. Re-run typecheck + relevant tests locally, then push to the same branch. Reply on the PR summarizing what you changed per finding.
```

> Note: `run.sh` reads prompts from `/work/state/prompts/` — copy the `factory/prompts/` dir into the volume on first launch (step Phase D.1), so the owner can tune prompts without rebuilding the image.

## 5. Phase C — Seed the backlog

Before going dark, run the planner once *interactively* (on the host, normal session — not the container) so the owner sees the first batch: execute the planner prompt yourself against the real repo, create the issues, then show the owner the list (`gh issue list --label autopilot`). Fix anything they object to. This calibrates the planner's issue size and tier labeling while a human is still watching closely.

## 6. Phase D — Launch

1. `docker compose -f factory/compose.yml build`, then copy prompts into the volume:
   `docker compose -f factory/compose.yml run --rm --entrypoint bash factory -c "mkdir -p /work/state/prompts" && docker compose -f factory/compose.yml cp factory/prompts factory:/work/state/` (or simply `docker compose run` a one-off that clones + copies; any equivalent is fine — verify the files exist in the volume).
2. **Smoke run**: `ONE_SHOT=1 docker compose -f factory/compose.yml up factory` in the foreground. Watch one full cycle: issue picked → PR opened → reviewed → merged (or needs-human'd). Do not proceed until one cycle completes sanely.
3. **Go**: `docker compose -f factory/compose.yml up -d`.
4. Hand off to the owner with exactly this info:
   - Watch live: `docker compose -f factory/compose.yml logs -f`
   - The real dashboard is GitHub itself: the Issues list and PR feed
   - Pause: `docker compose -f factory/compose.yml stop` · Resume: `... start`
   - Hard stop: `docker compose -f factory/compose.yml exec factory touch /work/state/STOP`
   - Unstick: clear `needs-human` labels after fixing/answering, re-add `autopilot`

## 7. Operations & failure playbook

- **`needs-human` issue**: the owner (or an interactive Claude session) reads the bot's comment on the issue/PR, resolves the ambiguity or fixes the hard part, removes `needs-human`, re-adds `autopilot`. The factory picks it back up.
- **Factory paused itself (stuck guard)**: ≥ `STUCK_LIMIT` needs-human issues — quality systematically off. Likely causes: issues too big (tune planner toward smaller packages), or a phase needs interactive work. Clear the pile before resuming.
- **Usage-limit sleeps**: normal and by design — visible in logs/webhook. No action needed.
- **v1 complete**: with `AFTER_V1=propose` (default) the owner gets §14 proposal issues labeled `awaiting-owner`; relabel to `autopilot` to approve each. Flip to `auto` in `.env` for full lean-back mode.
- **Tuning knobs** live in `factory/.env` and `state/prompts/` — both editable without rebuilding (restart the container).
- **Daily skim recommended**: 5 minutes over merged PRs. The gate catches broken; only a human catches "working but drifting from what I wanted."
```
