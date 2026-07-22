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

# Pure helpers below (salvage_branch) are unit-tested on the host: test.sh sets
# MF_SOURCE_ONLY=1, stubs gh/log/git, and sources this file (lib.sh + boot + main
# loop skipped).
if [ "${MF_SOURCE_ONLY:-0}" != 1 ]; then
  . /work/mf/lib.sh
  . /work/mf/mflib.sh

# owner 2026-07-22: Fable writes, everything after writing runs Opus — cap post-write stages at hard
post_write_diff(){ local d="$1"; [ "$d" = max ] && d=hard; echo "$d"; }

fi

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
# The toucher ignores HUP/PIPE so a closing parent stream can't silently take it
# down (issue #497: a dead toucher beside a live writer let the master call a FALSE
# stall on a healthy worker at 00:32, 2026-07-16).
hb_start(){ ( trap '' HUP PIPE; while :; do date -Is >"$HB" 2>/dev/null || true; sleep 300; done ) & HB_PID=$!; }
# Is the toucher process actually running right now?
hb_alive(){ [ -n "$HB_PID" ] && kill -0 "$HB_PID" 2>/dev/null; }
# (Re)spawn the toucher whenever it is not alive. Called at the top of run_cycle and
# before every role attempt so a dead toucher can never coexist with a live role run
# beyond a single attempt window ("verified alive each attempt loop iteration").
hb_ensure(){ hb_alive || hb_start; }
hb_stop(){ [ -n "$HB_PID" ] && kill "$HB_PID" 2>/dev/null; HB_PID=""; return 0; }
[ "${MF_SOURCE_ONLY:-0}" = 1 ] || trap 'hb_stop' EXIT

enqueue_merge(){ # $1=pr $2=issue — claims copied from the assignment file
  ls "$QUEUE" 2>/dev/null | grep -q -- "-pr$1\.json$" && return 0
  local touches payload
  touches=$(jq -c '.touches // []' "$AF" 2>/dev/null || echo '[]')
  payload=$(jq -cn --argjson pr "$1" --argjson issue "$2" --argjson touches "$touches" \
    --arg at "$(date -Is)" '{pr:$pr,issue:$issue,touches:$touches,enqueued_at:$at}')
  atomic_write "$QUEUE/$(date +%s)-pr$1.json" "$payload"
  log "merge-queue ← PR #$1 (issue #$2)"
}

# Difficulty of the current cycle — resolved once per assignment (mflib.sh).
CYCLE_DIFF=intermediate

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
  hb_ensure
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
  mf_cc checker "$(role_diff checker)" "$(with_pack "$(sed "s/{{N}}/$n/g; s/{{PR}}/$pr/g" "$MF_PROMPTS/checker.md")

$materials")" || true
  local tcomment verdict
  tcomment=$(gh pr view "$pr" --json comments -q '[.comments[].body|select(test("FACTORY-TRIAGE:"))]|last // ""' 2>/dev/null)
  verdict=$(grep -oE 'FACTORY-TRIAGE: (RETRY_ESCALATED|RELOCATE|NEEDS_HUMAN)' <<<"$tcomment" | tail -1)
  case "$verdict" in
    "FACTORY-TRIAGE: RETRY_ESCALATED")
      local esc
      esc=$(diff_next "$CYCLE_DIFF")
      log "triage: escalated retry at diff:$esc (was diff:$CYCLE_DIFF)"
      hb_ensure
      wstatus fixing "$n" "$pr"
      mf_cc fixer "$(post_write_diff "$esc")" "$(with_pack "TRIAGE DIAGNOSIS BRIEF (address this root cause):
$tcomment

$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")")" || true
      wstatus reviewing "$n" "$pr"
      mf_cc reviewer "$(post_write_diff "$(diff_at_least "$esc" "$(review_floor)")")" \
        "$(with_pack "$(sed "s/{{PR}}/$pr/g; s/{{N}}/$n/g" "$PROMPTS/reviewer.md")")" || true
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

# ---- salvage — never lose the writer's output (issues #328/#332/#370) ------------
# After the writer returns (success OR failure), before any verdict handling: if the
# clone has uncommitted work or the task branch carries commits not on main and no
# PR exists yet, commit + push the branch. A retry/relocate/checker or the next
# run's reviewer can then pick it up instead of the work evaporating in the worker's
# volume (salvage-from-volume, PR #393, is manual COD labor otherwise). Sets the
# global SALVAGED=1 and logs `salvaged branch task/N` when it fires; a normal happy
# path (the writer opened its own PR) is a no-op.
salvage_branch(){ # $1=issue
  local n=$1
  local branch="task/$n" dirty="" ahead=0 cur
  SALVAGED=0
  cd "$REPO_DIR" 2>/dev/null || return 0
  # Happy path: the writer already opened a PR — nothing to salvage.
  if [ -n "$(gh pr list --head "$branch" --state open --json number -q '.[0].number' 2>/dev/null)" ]; then
    return 0
  fi
  [ -n "$(git status --porcelain 2>/dev/null)" ] && dirty=1
  if git rev-parse --verify -q "refs/heads/$branch" >/dev/null 2>&1; then
    ahead=$(git rev-list --count "origin/main..$branch" 2>/dev/null || echo 0)
  fi
  # Clean tree and no unpushed commits ⇒ the writer left nothing behind.
  [ -z "$dirty" ] && [ "${ahead:-0}" -eq 0 ] && return 0
  # Land any uncommitted work on the task branch (create it if the writer never did).
  cur=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$cur" != "$branch" ]; then
    if git rev-parse --verify -q "refs/heads/$branch" >/dev/null 2>&1; then
      git checkout -q "$branch" 2>>"$LOG" || { log "salvage: cannot switch to $branch"; return 0; }
    else
      git checkout -q -b "$branch" 2>>"$LOG" || { log "salvage: cannot create $branch"; return 0; }
    fi
  fi
  if [ -n "$dirty" ]; then
    git add -A 2>>"$LOG"
    git commit -q -m "chore(salvage): writer output for #$n (auto-committed by worker $WORKER_ID)" 2>>"$LOG" || true
  fi
  if git push -u origin "$branch" 2>>"$LOG"; then
    SALVAGED=1; log "salvaged branch $branch"
  else
    log "salvage push failed for $branch"
  fi
  return 0
}

# ---- one full assignment cycle — mirrors run.sh's issue cycle -1:1 where possible
run_cycle(){ # $1=issue $2=relocated
  local n=$1 reloc=$2 pr
  CC_ISSUE=$n
  CYCLE_DIFF=$(issue_difficulty "$n")
  hb_ensure
  wstatus writing "$n"
  log "=== issue #$n [diff:$CYCLE_DIFF] ==="

  if [ "$MF_DRY_RUN" = 1 ]; then
    log "DRY: would write/review issue #$n"
    sleep "$MF_DRY_SECS"
    gh issue edit "$n" --remove-label "in-progress,mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
    # Record the fake completion so the master's runnable filter skips this
    # issue — otherwise the still-open issue would be re-assigned forever.
    echo "$n" >>"$MFSTATE/control/dry-done" 2>/dev/null || true
    wstatus done "$n"; hb_stop; return 0
  fi

  ( cd "$REPO_DIR" \
    && git checkout -q main && git fetch -q origin main && git reset -q --hard origin/main \
    && node factory/knowledge/build.mjs 2>>"$LOG" ) || log "pre-cycle sync failed (non-fatal)"

  # WRITER — cc() already waits out token limits, so a failure here is genuine.
  local writer_ok=0 w_try
  for w_try in $(seq 1 "${WRITER_RETRIES:-2}"); do
    hb_ensure
    if mf_cc writer "$CYCLE_DIFF" "$(with_pack "$(sed "s/{{N}}/$n/g" "$PROMPTS/writer.md")")"; then
      writer_ok=1; break
    fi
    log "writer attempt $w_try/${WRITER_RETRIES:-2} failed"
    [ "$w_try" -lt "${WRITER_RETRIES:-2}" ] && sleep "${WRITER_RETRY_SLEEP:-60}"
  done
  # Never lose the writer's output: commit + push the task branch if there's work
  # sitting in the clone and no PR exists yet (success OR failure path).
  salvage_branch "$n"
  local salvage_note=""
  [ "${SALVAGED:-0}" = 1 ] && salvage_note=" (writer output salvaged to branch task/$n)"

  if [ "$writer_ok" -ne 1 ]; then
    mark_human "$n" "writer failed after ${WRITER_RETRIES:-2} attempts$salvage_note"
    gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
    wstatus failed "$n"; hb_stop; return 1
  fi

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
    local state labels
    state=$(gh issue view "$n" --json state -q '.state' 2>/dev/null)
    labels=$(gh issue view "$n" --json labels -q '.labels[].name' 2>/dev/null)
    if [ "$state" = "CLOSED" ] || grep -q needs-human <<<"$labels"; then
      gh issue edit "$n" --remove-label "in-progress,autopilot,mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
      log "issue #$n self-resolved by writer (no PR needed)"; issue_cost "$n"
      wstatus done "$n"; hb_stop; return 0
    fi
    mark_human "$n" "no PR appeared$salvage_note"
    gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
    wstatus failed "$n"; hb_stop; return 1
  fi

  # REVIEW → FIX rounds (same rules as run.sh)
  local approved=0 round verdict
  for round in $(seq 1 "${MAX_FIX_ROUNDS:-2}"); do
    hb_ensure
    wstatus reviewing "$n" "$pr"
    mf_cc reviewer "$(post_write_diff "$(diff_at_least "$CYCLE_DIFF" "$(review_floor)")")" \
      "$(with_pack "$(sed "s/{{PR}}/$pr/g; s/{{N}}/$n/g" "$PROMPTS/reviewer.md")")" || true
    verdict=$(gh pr view "$pr" --json comments -q '.comments[].body' | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1)
    [ "$verdict" = "FACTORY-VERDICT: APPROVE" ] && { approved=1; break; }
    log "round $round: changes requested"
    wstatus fixing "$n" "$pr"
    mf_cc fixer "$(post_write_diff "$CYCLE_DIFF")" "$(with_pack "$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")")" || true
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
if [ "${MF_SOURCE_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi
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
  hb_ensure   # belt: re-spawn the toucher if its PID is gone before a cycle starts
  run_cycle "$n" "$reloc"
  # Wait for the master's ack (it removes the assignment file), then go idle.
  while [ -f "$AF" ]; do
    [ -f "$MFSTATE/STOP" ] && exit 0
    sleep 3
  done
  wstatus idle
done
