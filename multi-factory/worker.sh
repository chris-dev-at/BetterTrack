#!/usr/bin/env bash
# multi-factory/worker.sh — one worker container: wait for assignment → build cycle.
#
# Per assignment (BRIEF §7): writer → up to MAX_FIX_ROUNDS reviewer/fixer rounds
# (identical semantics to factory/run.sh) → approved PRs go to the merge queue and
# the worker is immediately schedulable again (it never babysits CI or merges).
# Still rejected after the rounds → ONE checker triage → at most ONE escalated
# retry one tier higher → merge queue or needs-human. Workers never touch main.
set -uo pipefail
: "${WORKER_ID:?WORKER_ID must be set}"
STATE=/work/state; REPO_DIR=$STATE/repo; LOG=$STATE/factory.log
PROMPTS=$STATE/prompts; MF_PROMPTS=$STATE/mf-prompts
MFSTATE=${MFSTATE:-/work/mfstate}
ASSIGN=$MFSTATE/assignments; STATUS=$MFSTATE/status; QUEUE=$MFSTATE/merge-queue
LOGS=$MFSTATE/logs
AF=$ASSIGN/worker-$WORKER_ID.json
HB=$STATUS/worker-$WORKER_ID.hb
: "${MF_DRY_RUN:=0}"; : "${MF_DRY_SECS:=8}"
export LOG_TAG="[w$WORKER_ID]"
export MF_EVENTLOG=$LOGS/events.log
export WORKER_ID

. /work/mf/lib.sh

atomic_write(){ local tmp; tmp=$(mktemp "$(dirname "$1")/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" >"$tmp" && mv -f "$tmp" "$1"; }

wstatus(){ # $1=phase $2=issue-or-null $3=pr-or-null
  atomic_write "$STATUS/worker-$WORKER_ID.json" "$(jq -cn \
    --arg p "$1" --argjson i "${2:-null}" --argjson pr "${3:-null}" --arg at "$(date -Is)" \
    '{phase:$p,issue:$i,pr:$pr,updated_at:$at}')"
  date -Is >"$HB" 2>/dev/null || true
}

# Heartbeat toucher runs alongside long cc() calls (a healthy writer can be silent
# for an hour when it sleeps out a token limit — the master only calls a worker
# stalled when this heartbeat stops, i.e. the process actually died).
HB_PID=""
hb_start(){ ( while :; do date -Is >"$HB" 2>/dev/null || true; sleep 300; done ) & HB_PID=$!; }
hb_stop(){ [ -n "$HB_PID" ] && kill "$HB_PID" 2>/dev/null; HB_PID=""; return 0; }
trap 'hb_stop' EXIT

enqueue_merge(){ # $1=pr $2=issue — claims copied from the assignment file
  ls "$QUEUE" 2>/dev/null | grep -q -- "-pr$1\.json$" && return 0
  local touches payload
  touches=$(jq -c '.touches // []' "$AF" 2>/dev/null || echo '[]')
  payload=$(jq -cn --argjson pr "$1" --argjson issue "$2" --argjson touches "$touches" \
    --arg at "$(date -Is)" '{pr:$pr,issue:$issue,touches:$touches,enqueued_at:$at}')
  atomic_write "$QUEUE/$(date +%s)-pr$1.json" "$payload"
  log "merge-queue ← PR #$1 (issue #$2)"
}

esc_model(){ case "$1" in "$MS") echo "$MO";; *) echo "$MF";; esac; }

# Append a dependency into an issue's mf-meta block (RELOCATE/BLOCKED path) so the
# scheduler's existing depends-on gating un-blocks it automatically when the new
# issue closes.
add_dep_to_issue(){ # $1=issue $2=dep-number
  local body new
  body=$(gh api "repos/$REPO/issues/$1" --jq .body 2>/dev/null) || return 0
  if grep -q 'mf-meta' <<<"$body"; then
    if grep -qi '^[[:space:]]*depends-on:' <<<"$body"; then
      new=$(awk -v d="$2" 'BEGIN{done=0} {if(!done && $0 ~ /^[[:space:]]*depends-on:/){$0=$0", "d; done=1} print}' <<<"$body")
    else
      new=$(awk -v d="$2" 'BEGIN{done=0} {print; if(!done && $0 ~ /<!--[[:space:]]*mf-meta/){print "depends-on: "d; done=1}}' <<<"$body")
    fi
  else
    new=$(printf '%s\n\n<!-- mf-meta\ndepends-on: %s\ntouches: **\n-->' "$body" "$2")
  fi
  gh api -X PATCH "repos/$REPO/issues/$1" -f body="$new" >/dev/null 2>&1 || true
}

# ---- triage (checker) — BRIEF §7: one checker pass, one escalated retry, hard caps
triage(){ # $1=issue $2=pr $3=relocated("true"/"false") — returns 0 if PR was enqueued
  local n=$1 pr=$2 reloc=$3
  if [ "$reloc" = true ]; then
    mark_human "$n" "relocated issue rejected again — triage chain cap (depth 1)"
    return 1
  fi
  wstatus triage "$n" "$pr"
  local materials
  materials=$(
    echo "## Issue #$n"
    gh issue view "$n" --json title,body -q '"\(.title)\n\n\(.body)"' 2>/dev/null
    echo; echo "## Final review comment"
    gh pr view "$pr" --json comments -q '[.comments[].body|select(test("FACTORY-VERDICT:"))]|last // "(none)"' 2>/dev/null
    echo; echo "## PR #$pr diff stat (not the full diff)"
    gh pr diff "$pr" --stat 2>/dev/null | tail -40
    echo; echo "## Changed files"
    gh pr view "$pr" --json files -q '.files[].path' 2>/dev/null
    echo; echo "## Last fixer replies"
    gh pr view "$pr" --json comments -q '[.comments[].body|select(test("FACTORY-VERDICT:")|not)][-2:]|join("\n---\n")' 2>/dev/null
  )
  CC_ROLE=checker cc "$MO" "$(with_pack "$(sed "s/{{N}}/$n/g; s/{{PR}}/$pr/g" "$MF_PROMPTS/checker.md")

$materials")" || true
  local tcomment verdict
  tcomment=$(gh pr view "$pr" --json comments -q '[.comments[].body|select(test("FACTORY-TRIAGE:"))]|last // ""' 2>/dev/null)
  verdict=$(grep -oE 'FACTORY-TRIAGE: (RETRY_ESCALATED|RELOCATE|NEEDS_HUMAN)' <<<"$tcomment" | tail -1)
  case "$verdict" in
    "FACTORY-TRIAGE: RETRY_ESCALATED")
      local base esc rmodel
      base=$(tier_model "$n"); esc=$(esc_model "$base")
      log "triage: escalated retry at $esc (was $base)"
      wstatus fixing "$n" "$pr"
      CC_ROLE=fixer cc "$esc" "$(with_pack "TRIAGE DIAGNOSIS BRIEF (address this root cause):
$tcomment

$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")")" || true
      wstatus reviewing "$n" "$pr"
      rmodel=$MO; [ "$esc" = "$MF" ] && rmodel=$MF
      CC_ROLE=reviewer cc "$rmodel" "$(with_pack "$(sed "s/{{PR}}/$pr/g; s/{{N}}/$n/g" "$PROMPTS/reviewer.md")")" || true
      local v2
      v2=$(gh pr view "$pr" --json comments -q '.comments[].body' | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1)
      if [ "$v2" = "FACTORY-VERDICT: APPROVE" ]; then enqueue_merge "$pr" "$n"; return 0; fi
      mark_human "$n" "review not clean after escalated retry (no appeal)"; return 1;;
    "FACTORY-TRIAGE: RELOCATE")
      local prdisp newnum
      prdisp=$(grep -oE 'FACTORY-TRIAGE-PR: (MERGEABLE|BLOCKED)' <<<"$tcomment" | tail -1)
      newnum=$(grep -oE 'FACTORY-TRIAGE-NEW: #[0-9]+' <<<"$tcomment" | tail -1 | grep -oE '[0-9]+' || true)
      if [ "$prdisp" = "FACTORY-TRIAGE-PR: MERGEABLE" ]; then
        log "triage: RELOCATE, current PR mergeable as-is (follow-up: #${newnum:-?})"
        enqueue_merge "$pr" "$n"; return 0
      fi
      log "triage: RELOCATE, PR blocked on #${newnum:-?} — closing PR"
      gh pr close "$pr" --delete-branch >/dev/null 2>&1 || gh pr close "$pr" >/dev/null 2>&1 || true
      if [ -n "$newnum" ]; then
        add_dep_to_issue "$n" "$newnum"
        gh label create "blocked-by:#$newnum" --color D93F0B >/dev/null 2>&1 || true
        gh issue edit "$n" --add-label "blocked-by:#$newnum" >/dev/null 2>&1 || true
        gh issue edit "$n" --remove-label "in-progress,mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
        notify "issue #$n blocked by new issue #$newnum (checker RELOCATE) — will reschedule when it closes"
      else
        mark_human "$n" "RELOCATE verdict without a new issue number"
      fi
      return 1;;
    "FACTORY-TRIAGE: NEEDS_HUMAN"|*)
      [ -n "$verdict" ] || log "triage: no parsable FACTORY-TRIAGE verdict"
      mark_human "$n" "checker triage → needs a human decision"
      return 1;;
  esac
}

# ---- one full assignment cycle — mirrors run.sh's issue cycle -1:1 where possible
run_cycle(){ # $1=issue $2=relocated
  local n=$1 reloc=$2 pr
  CC_ISSUE=$n
  hb_start
  wstatus writing "$n"
  log "=== issue #$n ==="

  if [ "$MF_DRY_RUN" = 1 ]; then
    log "DRY: would write/review issue #$n"
    sleep "$MF_DRY_SECS"
    gh issue edit "$n" --remove-label "in-progress,mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
    wstatus done "$n"; hb_stop; return 0
  fi

  ( cd "$REPO_DIR" \
    && git checkout -q main && git fetch -q origin main && git reset -q --hard origin/main \
    && node factory/knowledge/build.mjs 2>>"$LOG" ) || log "pre-cycle sync failed (non-fatal)"

  # WRITER — cc() already waits out token limits, so a failure here is genuine.
  local writer_ok=0 w_try
  for w_try in $(seq 1 "${WRITER_RETRIES:-2}"); do
    if CC_ROLE=writer cc "$(tier_model "$n")" "$(with_pack "$(sed "s/{{N}}/$n/g" "$PROMPTS/writer.md")")"; then
      writer_ok=1; break
    fi
    log "writer attempt $w_try/${WRITER_RETRIES:-2} failed"
    [ "$w_try" -lt "${WRITER_RETRIES:-2}" ] && sleep "${WRITER_RETRY_SLEEP:-60}"
  done
  if [ "$writer_ok" -ne 1 ]; then
    mark_human "$n" "writer failed after ${WRITER_RETRIES:-2} attempts"
    gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
    wstatus failed "$n"; hb_stop; return 1
  fi

  pr=$(gh pr list --head "task/$n" --state open --json number -q '.[0].number')
  if [ -z "$pr" ]; then
    # No PR: the writer may have self-marked the issue (already done / ambiguous).
    local state labels
    state=$(gh issue view "$n" --json state -q '.state' 2>/dev/null)
    labels=$(gh issue view "$n" --json labels -q '.labels[].name' 2>/dev/null)
    if [ "$state" = "CLOSED" ] || grep -q needs-human <<<"$labels"; then
      gh issue edit "$n" --remove-label "in-progress,autopilot,mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
      log "issue #$n self-resolved by writer (no PR needed)"; issue_cost "$n"
      wstatus done "$n"; hb_stop; return 0
    fi
    mark_human "$n" "no PR appeared"
    gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
    wstatus failed "$n"; hb_stop; return 1
  fi

  # REVIEW → FIX rounds (same rules as run.sh)
  local approved=0 round rmodel verdict
  for round in $(seq 1 "${MAX_FIX_ROUNDS:-2}"); do
    wstatus reviewing "$n" "$pr"
    rmodel=$MO; [ "$(tier_model "$n")" = "$MF" ] && rmodel=$MF
    CC_ROLE=reviewer cc "$rmodel" "$(with_pack "$(sed "s/{{PR}}/$pr/g; s/{{N}}/$n/g" "$PROMPTS/reviewer.md")")" || true
    verdict=$(gh pr view "$pr" --json comments -q '.comments[].body' | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1)
    [ "$verdict" = "FACTORY-VERDICT: APPROVE" ] && { approved=1; break; }
    log "round $round: changes requested"
    wstatus fixing "$n" "$pr"
    CC_ROLE=fixer cc "$(tier_model "$n")" "$(with_pack "$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")")" || true
  done

  if [ "$approved" -eq 1 ]; then
    enqueue_merge "$pr" "$n"
  else
    # Escalation ladder instead of "more fix rounds" (BRIEF §7).
    triage "$n" "$pr" "$reloc" || { wstatus failed "$n" "$pr"; hb_stop
      gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true; return 1; }
  fi

  # Handed to the merge queue: this worker is done — free for the next issue.
  gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
  wstatus done "$n" "$pr"; hb_stop; return 0
}

# ---- boot ------------------------------------------------------------------------
mkdir -p "$ASSIGN" "$STATUS" "$QUEUE" "$LOGS"
[ -f "$PROMPTS/writer.md" ] || { notify "FATAL: factory prompts missing in $PROMPTS (worker $WORKER_ID)"; exit 1; }
[ -d "$REPO_DIR/.git" ] || git clone "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$REPO_DIR"
cd "$REPO_DIR"
git config user.name "Christian Wiesinger"; git config user.email "chrisiclemi@gmail.com"
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
export GH_REPO="$REPO"
if [ -f "$AF" ]; then
  log "boot: pending assignment found (issue #$(jq -r .issue "$AF" 2>/dev/null)) — resuming (killed-mid-run recovery)"
else
  wstatus idle
fi
notify "worker $WORKER_ID up (dry=$MF_DRY_RUN)"

while true; do
  [ -f "$MFSTATE/STOP" ] && { log "STOP file present — worker exiting"; exit 0; }
  if [ ! -f "$AF" ]; then
    sleep 5; continue
  fi
  n=$(jq -r '.issue' "$AF" 2>/dev/null)
  reloc=$(jq -r '.relocated // false' "$AF" 2>/dev/null)
  if [ -z "$n" ] || [ "$n" = null ]; then log "unreadable assignment — removing"; rm -f "$AF"; continue; fi
  run_cycle "$n" "$reloc"
  # Wait for the master's ack (it removes the assignment file), then go idle.
  while [ -f "$AF" ]; do
    [ -f "$MFSTATE/STOP" ] && exit 0
    sleep 3
  done
  wstatus idle
done
