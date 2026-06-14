#!/usr/bin/env bash
set -uo pipefail
STATE=/work/state; REPO_DIR=$STATE/repo; LOG=$STATE/factory.log
MF=claude-fable-5; MO=claude-opus-4-8; MS=claude-sonnet-4-6

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
