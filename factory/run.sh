#!/usr/bin/env bash
set -uo pipefail
STATE=/work/state; REPO_DIR=$STATE/repo; LOG=$STATE/factory.log
PROMPTS=$STATE/prompts

# Shared internals (cc/ledger/capacity/pack/merge re-gate) — extracted verbatim
# to factory/lib.sh so the multi-factory reuses them. Behavior here is unchanged.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

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
# Owner directive: commits carry ONLY the owner's identity — no bot author, no
# Co-Authored-By trailers (GitHub squash-merge harvests every distinct PR commit
# author into the squash body, which is where stray avatars come from).
git config user.name "Christian Wiesinger"; git config user.email "chrisiclemi@gmail.com"
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
export GH_REPO="$REPO"
notify "factory started"

# Don't even begin a cycle if tokens are already exhausted at boot.
wait_for_capacity "startup"

while true; do
  [ -f "$STATE/STOP" ] && { notify "STOP file present — exiting"; exit 0; }
  git checkout -q main && git fetch -q origin main && git reset -q --hard origin/main
  # Regenerate the knowledge pack from the fresh tree (non-fatal on failure).
  node factory/knowledge/build.mjs 2>>"$LOG" || log "knowledge build failed (non-fatal)"

  # stuck guard
  stuck=$(gh issue list --label needs-human --state open --json number -q 'length')
  if [ "$stuck" -ge "${STUCK_LIMIT:-5}" ]; then
    notify "$stuck issues need a human — pausing 1h"; sleep 3600; continue; fi

  # planner: keep the queue full
  backlog=$(gh issue list --label autopilot --state open --json number -q 'length')
  if [ "$backlog" -lt "${MIN_BACKLOG:-3}" ]; then
    log "backlog=$backlog → running planner"
    CC_ISSUE=- CC_ROLE=planner cc "$MO" "$(with_pack "$(sed "s/\$PLANNER_BATCH/${PLANNER_BATCH:-10}/g; s/{{BATCH}}/${PLANNER_BATCH:-10}/g; s/{{AFTER_V1}}/${AFTER_V1:-propose}/g" "$PROMPTS/planner.md")")" || true
    backlog=$(gh issue list --label autopilot --state open --json number -q 'length')
    [ "$backlog" -eq 0 ] && { notify "planner produced nothing (v1 done or awaiting owner) — idling 2h"; sleep 7200; continue; }
  fi

  # pick the oldest actionable issue
  n=$(gh issue list --label autopilot --state open --json number -q 'sort_by(.number)|.[0].number')
  [ -z "$n" ] && { sleep 60; continue; }
  # `gh issue list` reads GitHub's eventually-consistent search index; right after a
  # merge it can still return the just-closed issue, spawning a ghost writer cycle.
  # Re-check the pick against the authoritative issue record and let the index settle.
  fresh=$(gh issue view "$n" --json state,labels -q '"\(.state) \([.labels[].name]|join(","))"' 2>/dev/null)
  case "$fresh" in
    OPEN\ *autopilot*) ;;
    *) log "issue #$n stale in search index ($fresh) — settling 30s"; sleep 30; continue;;
  esac
  gh issue edit "$n" --add-label in-progress >/dev/null 2>&1 || true
  CC_ISSUE="$n"   # tag every cc() run this cycle with the issue number for the ledger
  log "=== issue #$n ==="

  # WRITER — cc() already waits out token limits, so a failure here is genuine.
  # Give it a couple of attempts for transient (non-capacity) hiccups.
  writer_ok=0
  for w_try in $(seq 1 "${WRITER_RETRIES:-2}"); do
    if CC_ROLE=writer cc "$(tier_model "$n")" "$(with_pack "$(sed "s/{{N}}/$n/g" "$PROMPTS/writer.md")")"; then
      writer_ok=1; break
    fi
    log "writer attempt $w_try/${WRITER_RETRIES:-2} failed"
    [ "$w_try" -lt "${WRITER_RETRIES:-2}" ] && sleep "${WRITER_RETRY_SLEEP:-60}"
  done
  [ "$writer_ok" -eq 1 ] || { mark_human "$n" "writer failed after ${WRITER_RETRIES:-2} attempts"; continue; }

  # PR detection — a transient GitHub/network failure here must not condemn the
  # issue (seen live 2026-07-04: a TLS timeout marked two finished issues
  # needs-human while their PRs existed). Distinguish "gh failed" from "no PR".
  pr=""
  for pd_try in 1 2 3; do
    if pr=$(gh pr list --head "task/$n" --state open --json number -q '.[0].number' 2>/dev/null); then
      break
    fi
    pr=""
    log "PR detection failed (attempt $pd_try/3) — retrying in 20s"
    [ "$pd_try" -lt 3 ] && sleep 20
  done
  if [ -z "$pr" ]; then
    # No PR: the writer may have self-marked the issue (already done / ambiguous).
    state=$(gh issue view "$n" --json state -q '.state' 2>/dev/null)
    labels=$(gh issue view "$n" --json labels -q '.labels[].name' 2>/dev/null)
    if [ "$state" = "CLOSED" ] || grep -q needs-human <<<"$labels"; then
      gh issue edit "$n" --remove-label in-progress,autopilot >/dev/null 2>&1 || true
      log "issue #$n self-resolved by writer (no PR needed)"; issue_cost "$n"; continue
    fi
    mark_human "$n" "no PR appeared"; continue
  fi

  # REVIEW → FIX rounds
  approved=0
  for round in $(seq 1 "${MAX_FIX_ROUNDS:-2}"); do
    rmodel=$MO; [ "$(tier_model "$n")" = "$MF" ] && rmodel=$MF
    CC_ROLE=reviewer cc "$rmodel" "$(with_pack "$(sed "s/{{PR}}/$pr/g; s/{{N}}/$n/g" "$PROMPTS/reviewer.md")")" || true
    verdict=$(gh pr view "$pr" --json comments -q '.comments[].body' | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1)
    [ "$verdict" = "FACTORY-VERDICT: APPROVE" ] && { approved=1; break; }
    log "round $round: changes requested"
    CC_ROLE=fixer cc "$(tier_model "$n")" "$(with_pack "$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")")" || true
  done
  [ "$approved" -eq 1 ] || { mark_human "$n" "review not clean after ${MAX_FIX_ROUNDS:-2} rounds"; continue; }

  # GATE: CI green (one automated fix attempt), then merge
  if ! gh pr checks "$pr" --watch --fail-fast; then
    log "CI red — one fix attempt"
    CC_ROLE=ci-fix cc "$(tier_model "$n")" "CI failed on PR #$pr of $REPO. cd into the repo, check out the PR branch, run 'gh pr checks $pr' and 'gh run view --log-failed' to see why, fix it properly (no test-deletion, no skips), run the tests locally, push." || true
    gh pr checks "$pr" --watch --fail-fast || { mark_human "$n" "CI red after fix attempt"; continue; }
  fi
  if merge_with_regate "$pr"; then
    gh issue close "$n" >/dev/null 2>&1 || true
    gh issue edit "$n" --remove-label in-progress,autopilot >/dev/null 2>&1 || true
    notify "merged PR #$pr (issue #$n) ✅"; issue_cost "$n"
  else
    mark_human "$n" "merge failed"
  fi
  [ "${ONE_SHOT:-0}" = "1" ] && { log "ONE_SHOT done"; exit 0; }
done
