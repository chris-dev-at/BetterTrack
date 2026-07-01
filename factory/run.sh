#!/usr/bin/env bash
set -uo pipefail
STATE=/work/state; REPO_DIR=$STATE/repo; LOG=$STATE/factory.log
PROMPTS=$STATE/prompts
MF=claude-fable-5; MO=claude-opus-4-8; MS=claude-sonnet-4-6
LIMIT_SLEEP=${LIMIT_SLEEP:-1800}

log(){ printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }
notify(){ log "NOTIFY: $*"; [ -n "${FACTORY_WEBHOOK_URL:-}" ] && \
  curl -fsS -m10 -H 'Content-Type: application/json' \
    -d "{\"content\":\"🏭 BetterTrack factory: $*\"}" "$FACTORY_WEBHOOK_URL" >/dev/null || true; }

# Limit wording we look for ONLY inside the structured result line (never the raw
# event stream, which carries benign "rate_limit_event" objects on every run).
LIMIT_RE='usage limit|limit reached|limit will reset|quota|insufficient (credit|balance|funds)|overloaded|(^|[^0-9])(429|529)([^0-9]|$)'

# Is a specific model usable right now? Fable is intermittently unavailable; when
# it is, its tier:fable issues are skipped (not failed) until it returns.
model_ok(){
  claude -p "Reply with exactly: ok" --model "$1" --output-format json \
    --dangerously-skip-permissions 2>/dev/null \
    | jq -e 'select(.is_error==false)' >/dev/null 2>&1
}

# Cheap capacity probe on the cheapest model: tells "tokens exhausted" apart from
# "the task genuinely failed".
api_ok(){ model_ok "$MS"; }

# Block until the subscription has capacity again. This IS the "wait for tokens
# to replenish, then continue" behaviour the factory is built around.
wait_for_capacity(){
  local why=$1
  while ! api_ok; do
    notify "tokens/capacity exhausted ($why) — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
    sleep "$LIMIT_SLEEP"
  done
}

# Headless Claude call. Streams progress to the log, detects success/failure from
# the structured result line, and — crucially — never reports failure when the
# real problem is exhausted tokens: in that case it waits and retries forever.
# Returns 0 on a clean run, 1 only on a genuine (non-capacity) task failure.
cc(){ local model=$1; shift; local prompt="$*"
  while true; do
    local out rc res err
    out=$(claude -p "$prompt" --model "$model" --output-format stream-json --verbose \
          --dangerously-skip-permissions 2>&1 | tee -a "$LOG"); rc=${PIPESTATUS[0]}
    res=$(grep '"type":"result"' <<<"$out" | tail -1)
    err=$(jq -r 'try .is_error catch "x"' <<<"$res" 2>/dev/null)
    if [ "$err" = "false" ]; then
      log "  ↳ ok ($(jq -r 'try "\(.num_turns) turns, $\(.total_cost_usd)" catch "done"' <<<"$res"))"
      return 0
    fi
    # Failure. Look for limit wording ONLY in the result line's subtype/result
    # text — the raw event stream carries benign "rate_limit_event" objects that
    # must never be mistaken for an error.
    local sig; sig=$(jq -r 'try ((.subtype // "")+" "+(.result // "")) catch ""' <<<"$res" 2>/dev/null)
    if printf '%s' "$sig" | grep -qiE "$LIMIT_RE"; then
      notify "usage limit hit — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
      sleep "$LIMIT_SLEEP"; continue
    fi
    # Ambiguous failure (rc=$rc, no result line, or is_error without a clear
    # limit message). Probe the API: if it's also down, treat as capacity and
    # wait; otherwise it's a real task failure — let the caller handle it.
    if ! api_ok; then
      wait_for_capacity "ambiguous failure rc=$rc"; continue
    fi
    log "  ↳ genuine task failure (rc=$rc, is_error=$err)"
    return 1
  done
}

tier_model(){ case "$(gh issue view "$1" --json labels -q '.labels[].name' | grep '^tier:' || true)" in
  tier:fable) echo "$MF";; tier:sonnet) echo "$MS";; *) echo "$MO";; esac; }

mark_human(){ gh issue edit "$1" --add-label needs-human --remove-label autopilot,in-progress >/dev/null 2>&1 || true
  notify "issue #$1 → needs-human ($2)"; }

# ---- bootstrap ----
mkdir -p "$PROMPTS"
# Seed prompts from the image copy if the prompts dir is empty (no bind-mount case).
if [ -z "$(ls -A "$PROMPTS" 2>/dev/null)" ] && [ -d /work/prompts ]; then
  cp /work/prompts/* "$PROMPTS/" 2>/dev/null || true
fi
if [ -z "$(ls -A "$PROMPTS" 2>/dev/null)" ]; then
  notify "FATAL: no prompts found in $PROMPTS — aborting"; exit 1
fi
[ -d "$REPO_DIR/.git" ] || git clone "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$REPO_DIR"
cd "$REPO_DIR"
git config user.name "bettertrack-factory"; git config user.email "factory@bettertrack.local"
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
export GH_REPO="$REPO"
notify "factory started"

# Don't even begin a cycle if tokens are already exhausted at boot.
wait_for_capacity "startup"

while true; do
  [ -f "$STATE/STOP" ] && { notify "STOP file present — exiting"; exit 0; }
  git checkout -q main && git fetch -q origin main && git reset -q --hard origin/main

  # stuck guard
  stuck=$(gh issue list --label needs-human --state open --json number -q 'length')
  if [ "$stuck" -ge "${STUCK_LIMIT:-5}" ]; then
    notify "$stuck issues need a human — pausing 1h"; sleep 3600; continue; fi

  # planner: keep the queue full
  backlog=$(gh issue list --label autopilot --state open --json number -q 'length')
  if [ "$backlog" -lt "${MIN_BACKLOG:-3}" ]; then
    log "backlog=$backlog → running planner"
    cc "$MO" "$(sed "s/\$PLANNER_BATCH/${PLANNER_BATCH:-5}/g; s/{{BATCH}}/${PLANNER_BATCH:-5}/g; s/{{AFTER_V1}}/${AFTER_V1:-propose}/g" "$PROMPTS/planner.md")" || true
    backlog=$(gh issue list --label autopilot --state open --json number -q 'length')
    [ "$backlog" -eq 0 ] && { notify "planner produced nothing (v1 done or awaiting owner) — idling 2h"; sleep 7200; continue; }
  fi

  # pick the oldest actionable issue
  n=$(gh issue list --label autopilot --state open --json number -q 'sort_by(.number)|.[0].number')
  [ -z "$n" ] && { sleep 60; continue; }
  gh issue edit "$n" --add-label in-progress >/dev/null 2>&1 || true
  log "=== issue #$n ==="

  # WRITER — cc() already waits out token limits, so a failure here is genuine.
  # Give it a couple of attempts for transient (non-capacity) hiccups.
  writer_ok=0
  for w_try in $(seq 1 "${WRITER_RETRIES:-2}"); do
    if cc "$(tier_model "$n")" "$(sed "s/{{N}}/$n/g" "$PROMPTS/writer.md")"; then
      writer_ok=1; break
    fi
    log "writer attempt $w_try/${WRITER_RETRIES:-2} failed"
    [ "$w_try" -lt "${WRITER_RETRIES:-2}" ] && sleep "${WRITER_RETRY_SLEEP:-60}"
  done
  [ "$writer_ok" -eq 1 ] || { mark_human "$n" "writer failed after ${WRITER_RETRIES:-2} attempts"; continue; }

  pr=$(gh pr list --head "task/$n" --state open --json number -q '.[0].number')
  if [ -z "$pr" ]; then
    # No PR: the writer may have self-marked the issue (already done / ambiguous).
    state=$(gh issue view "$n" --json state -q '.state' 2>/dev/null)
    labels=$(gh issue view "$n" --json labels -q '.labels[].name' 2>/dev/null)
    if [ "$state" = "CLOSED" ] || grep -q needs-human <<<"$labels"; then
      gh issue edit "$n" --remove-label in-progress,autopilot >/dev/null 2>&1 || true
      log "issue #$n self-resolved by writer (no PR needed)"; continue
    fi
    mark_human "$n" "no PR appeared"; continue
  fi

  # REVIEW → FIX rounds
  approved=0
  for round in $(seq 1 "${MAX_FIX_ROUNDS:-2}"); do
    rmodel=$MO; [ "$(tier_model "$n")" = "$MF" ] && rmodel=$MF
    cc "$rmodel" "$(sed "s/{{PR}}/$pr/g; s/{{N}}/$n/g" "$PROMPTS/reviewer.md")" || true
    verdict=$(gh pr view "$pr" --json comments -q '.comments[].body' | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1)
    [ "$verdict" = "FACTORY-VERDICT: APPROVE" ] && { approved=1; break; }
    log "round $round: changes requested"
    cc "$(tier_model "$n")" "$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")" || true
  done
  [ "$approved" -eq 1 ] || { mark_human "$n" "review not clean after ${MAX_FIX_ROUNDS:-2} rounds"; continue; }

  # GATE: CI green (one automated fix attempt), then merge
  if ! gh pr checks "$pr" --watch --fail-fast; then
    log "CI red — one fix attempt"
    cc "$(tier_model "$n")" "CI failed on PR #$pr of $REPO. cd into the repo, check out the PR branch, run 'gh pr checks $pr' and 'gh run view --log-failed' to see why, fix it properly (no test-deletion, no skips), run the tests locally, push." || true
    gh pr checks "$pr" --watch --fail-fast || { mark_human "$n" "CI red after fix attempt"; continue; }
  fi
  if gh pr merge "$pr" --squash --delete-branch; then
    gh issue close "$n" >/dev/null 2>&1 || true
    gh issue edit "$n" --remove-label in-progress,autopilot >/dev/null 2>&1 || true
    notify "merged PR #$pr (issue #$n) ✅"
  else
    mark_human "$n" "merge failed"
  fi
  [ "${ONE_SHOT:-0}" = "1" ] && { log "ONE_SHOT done"; exit 0; }
done
