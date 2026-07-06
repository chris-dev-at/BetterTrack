#!/usr/bin/env bash
# multi-factory/master.sh — composer step → scheduler → merger, one bash loop.
#
# The master is the ONLY process that merges to main. Workers build in isolation
# and hand finished PRs over via the merge queue. Protocol dir (bind-mounted at
# /work/mfstate, host multi-factory/state/):
#   assignments/worker-N.json   master-written, removed on ack
#   status/worker-N.json(.hb)   worker-written phase + heartbeat
#   merge-queue/<epoch>-prNN.json  FIFO of reviewer-approved PRs
#   control/mode                run | run-out | close-down   (owner/dashboard-written)
#   control/phase               running | draining | drained (master-written)
#   logs/events.log             shared factory event lines (all containers)
#
# Modes: run = normal. run-out = composer off; keep scheduling until every open
# autopilot issue is done, then phase=drained. close-down = composer off, no new
# assignments; in-flight work finishes (incl. its merges), then phase=drained.
# The control dashboard watches phase=drained and downs the compose project;
# without it the drained master just idles (token-free) until stopped.
set -uo pipefail
: "${STATE:=/work/state}"; : "${REPO_DIR:=$STATE/repo}"; : "${LOG:=$STATE/factory.log}"
: "${PROMPTS:=$STATE/prompts}"; : "${MF_PROMPTS:=$STATE/mf-prompts}"
: "${MFSTATE:=/work/mfstate}"
ASSIGN=$MFSTATE/assignments; STATUS=$MFSTATE/status; QUEUE=$MFSTATE/merge-queue
CONTROL=$MFSTATE/control; LOGS=$MFSTATE/logs
: "${WORKERS:=2}"
: "${MF_TICK:=15}"                # seconds between master loop ticks
: "${MF_STALL_SECS:=3600}"        # heartbeat silence that counts as a worker stall
: "${COMPOSER_BATCH:=4}"          # issues per composer run
: "${MF_COMPOSER_COOLDOWN:=900}"  # min seconds between composer runs (base; also the floor after a reset)
: "${MF_COMPOSER_BACKOFF_MAX:=14400}"  # cap on the idle-backoff cooldown (empty composer runs)
: "${MF_DRY_RUN:=0}"
export LOG_TAG="[master]"
export MF_EVENTLOG=$LOGS/events.log

# Pure scheduler/parser functions below are unit-tested on the host: test.sh sets
# MF_SOURCE_ONLY=1, stubs gh/log/notify, and sources this file (lib.sh skipped,
# boot + main loop skipped).
if [ "${MF_SOURCE_ONLY:-0}" != 1 ]; then
  . /work/mf/lib.sh
  . /work/mf/mflib.sh
fi

# ---- small utils ---------------------------------------------------------------
atomic_write(){ # $1=path $2=content — write via tmp+mv so readers never see torn files
  local tmp; tmp=$(mktemp "$(dirname "$1")/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" >"$tmp" && mv -f "$tmp" "$1"
}
file_age(){ # seconds since mtime; huge when missing
  local m; m=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null) || { echo 9999999; return; }
  echo $(( $(date +%s) - m ))
}
# Master activity for the dashboard (composing / ci-fix / merging / idle).
mstatus(){ atomic_write "$STATUS/master.json" "$(jq -cn --arg a "$1" --argjson pr "${2:-null}" \
  --arg at "$(date -Is)" '{activity:$a,pr:$pr,updated_at:$at}')" 2>/dev/null || true; }

# ---- mf-meta parsing (BRIEF §4/§5) ----------------------------------------------
# Body comes in on stdin. A missing/unparseable block (no touches) is treated by
# callers as claiming '**' — conflicts with everything, runs alone. Serializing
# is never incorrect, only slower.
mf_meta_block(){ awk '/<!--[[:space:]]*mf-meta/{f=1; next} f && /-->/{exit} f{print}'; }
mf_meta_deps(){ mf_meta_block | grep -i '^[[:space:]]*depends-on:' | head -1 \
  | sed 's/^[^:]*://; s/[^0-9 ]/ /g' | xargs -n1 2>/dev/null | sort -un | xargs || true; }
mf_meta_touches(){ mf_meta_block | grep -i '^[[:space:]]*touches:' \
  | sed 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true; }

# ---- claim conflict test (BRIEF §5.2) --------------------------------------------
# Strip everything from the first wildcard; two claims conflict if either
# resulting prefix is a string-prefix of the other. '**' → '' conflicts with all.
claim_prefix(){ printf '%s' "${1%%\**}"; }
claims_conflict(){
  local a b; a=$(claim_prefix "$1"); b=$(claim_prefix "$2")
  case "$a" in "$b"*) return 0;; esac
  case "$b" in "$a"*) return 0;; esac
  return 1
}
# $1, $2: newline-separated claim lists — 0 (conflict) if ANY pair conflicts
claimsets_conflict(){
  local x y
  while IFS= read -r x; do
    [ -n "$x" ] || continue
    while IFS= read -r y; do
      [ -n "$y" ] || continue
      claims_conflict "$x" "$y" && return 0
    done <<<"$2"
  done <<<"$1"
  return 1
}

# ---- shared state readers --------------------------------------------------------
# Every in-flight claim: assigned issues + PRs still sitting in the merge queue
# (their changes aren't on main yet, so later work on the same paths must wait).
inflight_claims(){
  local f
  for f in "$ASSIGN"/worker-*.json "$QUEUE"/[0-9]*-pr*.json; do
    [ -f "$f" ] || continue
    if [ "$(jq -r '(.touches // [])|length' "$f" 2>/dev/null || echo 0)" = 0 ]
    then echo '**'
    else jq -r '.touches[]' "$f" 2>/dev/null
    fi
  done
}
inflight_issues(){
  local f
  for f in "$ASSIGN"/worker-*.json "$QUEUE"/[0-9]*-pr*.json; do
    [ -f "$f" ] || continue
    jq -r '.issue' "$f" 2>/dev/null
  done
}

# ---- GitHub reads (REST only — the search index lags ~30s+, BRIEF §5.1) ----------
TICK_ISSUES=${TICK_ISSUES:-/tmp/mf-tick-issues.json}
fetch_issues(){ # open autopilot issues, PRs filtered out; [] on any failure
  gh api "repos/$REPO/issues?labels=autopilot&state=open&per_page=100" \
    --jq '[.[]|select(.pull_request==null)|{number,title,body,labels:[.labels[].name]}]' \
    >"$TICK_ISSUES.tmp" 2>/dev/null && mv -f "$TICK_ISSUES.tmp" "$TICK_ISSUES" \
    || { [ -f "$TICK_ISSUES" ] || echo '[]' >"$TICK_ISSUES"; }
}
issue_body(){ jq -r --argjson n "$1" '.[]|select(.number==$n).body // ""' "$TICK_ISSUES"; }
issue_numbers_asc(){ jq -r 'sort_by(.number)|.[].number' "$TICK_ISSUES"; }
issue_has_label(){ jq -e --argjson n "$1" --arg l "$2" '.[]|select(.number==$n)|.labels|index($l)' "$TICK_ISSUES" >/dev/null 2>&1; }

# Direct REST read per dependency; cached per tick under $TICK_DEPS/.
deps_closed(){ # $1 = space-separated issue numbers; 0 when ALL are closed
  local d st
  for d in $1; do
    if [ -f "$TICK_DEPS/$d" ]; then st=$(cat "$TICK_DEPS/$d")
    else st=$(gh api "repos/$REPO/issues/$d" --jq .state 2>/dev/null || echo unknown)
         printf '%s' "$st" >"$TICK_DEPS/$d"
    fi
    [ "$st" = "closed" ] || return 1
  done
  return 0
}

# Claims for issue $1 (newline list; '**' when meta absent/empty)
issue_claims(){
  local t; t=$(issue_body "$1" | mf_meta_touches)
  if [ -n "$t" ]; then printf '%s\n' "$t"; else echo '**'; fi
}

# runnable = open+autopilot (tick cache), not in-flight, all deps closed
runnable_issues(){
  local inflight n deps
  inflight=$(inflight_issues)
  for n in $(issue_numbers_asc); do
    grep -qx "$n" <<<"$inflight" && continue
    # Dry-run cycles don't close real issues; skip ones already fake-completed.
    [ "$MF_DRY_RUN" = 1 ] && grep -qx "$n" "$CONTROL/dry-done" 2>/dev/null && continue
    deps=$(issue_body "$n" | mf_meta_deps)
    if [ -n "$deps" ]; then deps_closed "$deps" || continue; fi
    echo "$n"
  done
}

# ---- merge queue -----------------------------------------------------------------
enqueue_merge(){ # $1=pr $2=issue $3=claims (newline list)
  ls "$QUEUE" 2>/dev/null | grep -q -- "-pr$1\.json$" && return 0
  local touches payload
  touches=$(printf '%s\n' "$3" | jq -R . | jq -cs 'map(select(length>0))')
  payload=$(jq -cn --argjson pr "$1" --argjson issue "$2" --argjson touches "$touches" \
    --arg at "$(date -Is)" '{pr:$pr,issue:$issue,touches:$touches,enqueued_at:$at}')
  atomic_write "$QUEUE/$(date +%s)-pr$1.json" "$payload"
  log "merge-queue ← PR #$1 (issue #$2)"
}

# ---- master steps ----------------------------------------------------------------
process_acks(){
  local w af sf sphase sissue aissue
  for w in $(seq 1 "$WORKERS"); do
    af=$ASSIGN/worker-$w.json; sf=$STATUS/worker-$w.json
    [ -f "$af" ] && [ -f "$sf" ] || continue
    sphase=$(jq -r '.phase // ""' "$sf" 2>/dev/null)
    sissue=$(jq -r '.issue // 0' "$sf" 2>/dev/null)
    aissue=$(jq -r '.issue' "$af" 2>/dev/null)
    if [ "$sissue" = "$aissue" ] && { [ "$sphase" = done ] || [ "$sphase" = failed ]; }; then
      rm -f "$af"; log "ack: worker $w finished issue #$aissue ($sphase)"
    fi
  done
}

stall_check(){
  local w af n age pr verdict
  for w in $(seq 1 "$WORKERS"); do
    af=$ASSIGN/worker-$w.json; [ -f "$af" ] || continue
    age=$(file_age "$STATUS/worker-$w.hb")
    [ "$age" -ge "$MF_STALL_SECS" ] || continue
    n=$(jq -r '.issue' "$af")
    log "worker $w STALLED on issue #$n (heartbeat ${age}s old) — recovering"
    # Killed-mid-run recovery semantics: authoritative re-check, then reset/reassign.
    case "$(gh api "repos/$REPO/issues/$n" --jq .state 2>/dev/null || echo unknown)" in
      closed) rm -f "$af"; log "  issue #$n already closed — assignment cleared"; continue;;
    esac
    pr=$(gh pr list --head "task/$n" --state open --json number -q '.[0].number' 2>/dev/null || true)
    if [ -n "$pr" ]; then
      verdict=$(gh pr view "$pr" --json comments -q '.comments[].body' 2>/dev/null \
        | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1 || true)
      if [ "$verdict" = "FACTORY-VERDICT: APPROVE" ]; then
        enqueue_merge "$pr" "$n" "$(jq -r '.touches[]?' "$af")"
        rm -f "$af"; log "  approved PR #$pr salvaged to merge queue"; continue
      fi
    fi
    gh issue edit "$n" --remove-label "in-progress,mf:worker-$w" >/dev/null 2>&1 || true
    rm -f "$af"
    notify "worker $w stall on issue #$n — assignment reset, will reschedule"
  done
}

# Idle back-off (BRIEF: composer re-runs every MF_COMPOSER_COOLDOWN forever even
# when nothing is composable). $CONTROL/.composer-backoff holds the effective
# cooldown for the NEXT run; it starts at/resets to MF_COMPOSER_COOLDOWN and
# doubles (capped at MF_COMPOSER_BACKOFF_MAX) each time a run's outcome — the
# open-autopilot-issue set, mode and phase — is unchanged from the snapshot
# taken at the previous run. Any change resets it to base.
composer_snapshot(){ # $1=mode — state the backoff should be sensitive to
  local phase=""; [ -f "$CONTROL/phase" ] && phase=$(cat "$CONTROL/phase")
  { printf 'mode=%s\nphase=%s\n' "$1" "$phase"; jq -r '[.[].number]|sort|.[]' "$TICK_ISSUES" 2>/dev/null; }
}

composer_step(){ # $1=mode
  [ "$1" = run ] || return 0
  local count; count=$(runnable_issues | grep -c . || true)
  [ "$count" -lt $((WORKERS + 1)) ] || return 0
  local backoff; backoff=$(cat "$CONTROL/.composer-backoff" 2>/dev/null)
  case "$backoff" in ''|*[!0-9]*) backoff=$MF_COMPOSER_COOLDOWN;; esac
  [ "$(file_age "$CONTROL/.composer-last")" -ge "$backoff" ] || return 0

  local snap; snap=$(composer_snapshot "$1")
  local prev=""; [ -f "$CONTROL/.composer-snapshot" ] && prev=$(cat "$CONTROL/.composer-snapshot")
  local next=$MF_COMPOSER_COOLDOWN
  if [ -f "$CONTROL/.composer-snapshot" ] && [ "$snap" = "$prev" ]; then
    next=$(( backoff * 2 )); [ "$next" -le "$MF_COMPOSER_BACKOFF_MAX" ] || next=$MF_COMPOSER_BACKOFF_MAX
    log "composer idle-backoff: last run empty, next in ${next}s"
  elif [ -f "$CONTROL/.composer-snapshot" ] && [ "$backoff" != "$MF_COMPOSER_COOLDOWN" ]; then
    log "composer idle-backoff reset to ${MF_COMPOSER_COOLDOWN}s (issue set/mode/phase changed)"
  fi
  atomic_write "$CONTROL/.composer-backoff" "$next"
  atomic_write "$CONTROL/.composer-snapshot" "$snap"
  touch "$CONTROL/.composer-last"

  if [ "$MF_DRY_RUN" = 1 ]; then log "DRY: composer would run (runnable=$count)"; return 0; fi
  log "runnable=$count < $((WORKERS+1)) → running composer"
  mstatus composing
  ( cd "$REPO_DIR" \
    && git checkout -q main && git fetch -q origin main && git reset -q --hard origin/main \
    && node factory/knowledge/build.mjs 2>>"$LOG" ) || log "composer pre-sync failed (non-fatal)"
  CC_ISSUE=- mf_cc composer "$(role_diff composer)" "$(with_pack "$(sed "s/{{BATCH}}/$COMPOSER_BATCH/g" "$MF_PROMPTS/composer.md")")" || true
}

scheduler(){ # $1=mode — assigns runnable, non-conflicting issues to idle workers
  [ "$1" = close-down ] && return 0
  local inflight runnable w n claims wphase
  inflight=$(inflight_claims)
  runnable=$(runnable_issues)
  [ -n "$runnable" ] || return 0
  for w in $(seq 1 "$WORKERS"); do
    [ -f "$ASSIGN/worker-$w.json" ] && continue
    wphase=$(jq -r '.phase // "idle"' "$STATUS/worker-$w.json" 2>/dev/null || echo idle)
    [ "$wphase" = idle ] || continue
    for n in $runnable; do
      claims=$(issue_claims "$n")
      claimsets_conflict "$claims" "$inflight" && continue
      local touches payload
      touches=$(printf '%s\n' "$claims" | jq -R . | jq -cs 'map(select(length>0))')
      payload=$(jq -cn --argjson issue "$n" --argjson touches "$touches" \
        --arg at "$(date -Is)" \
        --argjson reloc "$(issue_has_label "$n" "mf:relocated" && echo true || echo false)" \
        '{issue:$issue,assigned_at:$at,touches:$touches,relocated:$reloc}')
      atomic_write "$ASSIGN/worker-$w.json" "$payload"
      gh issue edit "$n" --add-label "in-progress,mf:worker-$w" >/dev/null 2>&1 || true
      log "assigned issue #$n → worker $w"
      inflight=$(printf '%s\n%s' "$inflight" "$claims")
      runnable=$(grep -vx "$n" <<<"$runnable" || true)
      break
    done
  done
}

# One queue head per tick, non-blocking on pending CI: workers never babysit CI
# and the master keeps scheduling while checks run. LLM (ci-fix) and the rare
# BEHIND re-gate are the only blocking parts, by design (single sequential merger).
merger_step(){
  local head; head=$(ls "$QUEUE" 2>/dev/null | grep -E '^[0-9]+-pr[0-9]+\.json$' | sort -n | head -1)
  [ -n "$head" ] || return 0
  local f=$QUEUE/$head pr n marker
  pr=$(jq -r '.pr' "$f"); n=$(jq -r '.issue' "$f"); marker=$QUEUE/.cifix-pr$pr
  if [ "$MF_DRY_RUN" = 1 ]; then log "DRY: would merge PR #$pr (issue #$n)"; rm -f "$f"; return 0; fi
  local pstate
  pstate=$(gh pr view "$pr" --json state -q '.state' 2>/dev/null || echo unknown)
  case "$pstate" in
    MERGED) log "merger: PR #$pr already merged — finalizing"
            finalize_issue "$pr" "$n"; rm -f "$f" "$marker"; return 0;;
    OPEN)   ;;
    unknown) log "merger: cannot read PR #$pr (transient?) — retrying next tick"; return 0;;
    *)      mark_human "$n" "PR #$pr $pstate without merge"; rm -f "$f" "$marker"; return 0;;
  esac
  # Authoritative re-check: approval verdict must still stand.
  local verdict
  verdict=$(gh pr view "$pr" --json comments -q '.comments[].body' 2>/dev/null \
    | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1 || true)
  if [ "$verdict" != "FACTORY-VERDICT: APPROVE" ]; then
    mark_human "$n" "queued PR #$pr lost its approval"; rm -f "$f" "$marker"; return 0
  fi
  # CI rollup, non-blocking (empty rollup = checks not reported yet = pending).
  local rollup
  rollup=$(gh pr view "$pr" --json statusCheckRollup \
    -q '[.statusCheckRollup[]| .conclusion // .status // "PENDING"]|join(",")' 2>/dev/null || echo QUERY_FAILED)
  [ "$rollup" = QUERY_FAILED ] && { log "merger: rollup read failed for PR #$pr — retrying next tick"; return 0; }
  if grep -qE 'FAILURE|TIMED_OUT|CANCELLED|ACTION_REQUIRED' <<<"$rollup"; then
    if [ ! -f "$marker" ]; then
      touch "$marker"; log "merger: CI red on PR #$pr — one fix attempt"
      mstatus ci-fix "$pr"
      CC_ISSUE=$n mf_cc ci-fix "$(issue_difficulty "$n")" "CI failed on PR #$pr of $REPO. cd into the repo, check out the PR branch, run 'gh pr checks $pr' and 'gh run view --log-failed' to see why, fix it properly (no test-deletion, no skips), run the tests locally, push." || true
      return 0
    fi
    mark_human "$n" "CI red on PR #$pr after fix attempt"; rm -f "$f" "$marker"; return 0
  fi
  if [ -z "$rollup" ] || grep -qE 'PENDING|IN_PROGRESS|QUEUED|EXPECTED|WAITING' <<<"$rollup"; then
    return 0   # still running — check again next tick
  fi
  # Green — merge (BEHIND re-gate handled inside, retried once; proven block).
  mstatus merging "$pr"
  if merge_with_regate "$pr"; then
    finalize_issue "$pr" "$n"
  else
    mark_human "$n" "merge failed on PR #$pr"
  fi
  rm -f "$f" "$marker"
}

finalize_issue(){ # $1=pr $2=issue
  gh issue close "$2" >/dev/null 2>&1 || true
  gh issue edit "$2" --remove-label in-progress,autopilot >/dev/null 2>&1 || true
  notify "merged PR #$1 (issue #$2) ✅"; issue_cost "$2"
}

set_phase(){
  local p=$1 cur=""
  [ -f "$CONTROL/phase" ] && cur=$(cat "$CONTROL/phase")
  [ "$cur" = "$p" ] && return 0
  atomic_write "$CONTROL/phase" "$p"
  log "phase → $p"
  [ "$p" = drained ] && notify "multi-factory drained — no work left under current mode; safe to shut down"
  return 0
}

drained_check(){ # $1=mode
  local qcount acount
  case "$1" in run-out|close-down) ;; *) set_phase running; return 0;; esac
  qcount=$(ls "$QUEUE" 2>/dev/null | grep -cE '^[0-9]+-pr[0-9]+\.json$' || true)
  acount=$(ls "$ASSIGN"/worker-*.json 2>/dev/null | wc -l | tr -d ' ')
  if [ "$1" = run-out ]; then
    local open_count; open_count=$(jq 'length' "$TICK_ISSUES" 2>/dev/null || echo 1)
    if [ "$open_count" = 0 ] && [ "$acount" = 0 ] && [ "$qcount" = 0 ]
    then set_phase drained; else set_phase draining; fi
  else
    if [ "$acount" = 0 ] && [ "$qcount" = 0 ]
    then set_phase drained; else set_phase draining; fi
  fi
}

tick(){
  [ -f "$MFSTATE/STOP" ] && { notify "STOP file present — master exiting"; exit 0; }
  local mode; mode=$(cat "$CONTROL/mode" 2>/dev/null || echo run)
  date -Is >"$STATUS/master.hb" 2>/dev/null || true
  fetch_issues
  rm -rf "$TICK_DEPS"; mkdir -p "$TICK_DEPS"
  process_acks
  stall_check
  composer_step "$mode"
  # The composer (and merger LLM/regate paths) can block this tick for minutes;
  # re-read the mode so a close-down/run-out issued meanwhile is honored BEFORE
  # the scheduler hands out new work (caught live: stale 'run' assigned an issue
  # 6 minutes into close-down).
  mode=$(cat "$CONTROL/mode" 2>/dev/null || echo run)
  scheduler "$mode"
  merger_step
  drained_check "$mode"
  mstatus idle
}

# ---- boot + main loop (skipped when sourced for tests) -----------------------------
if [ "${MF_SOURCE_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

mkdir -p "$ASSIGN" "$STATUS" "$QUEUE" "$CONTROL" "$LOGS"
TICK_DEPS=${TICK_DEPS:-/tmp/mf-tick-deps}; mkdir -p "$TICK_DEPS"
[ -f "$CONTROL/mode" ] || atomic_write "$CONTROL/mode" run
set_phase running
[ -f "$MF_PROMPTS/composer.md" ] || { notify "FATAL: $MF_PROMPTS/composer.md missing"; exit 1; }
[ -f "$PROMPTS/writer.md" ] || { notify "FATAL: factory prompts missing in $PROMPTS"; exit 1; }
[ -d "$REPO_DIR/.git" ] || git clone "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$REPO_DIR"
cd "$REPO_DIR"
git config user.name "Christian Wiesinger"; git config user.email "chrisiclemi@gmail.com"
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
export GH_REPO="$REPO"
for w in $(seq 1 "$WORKERS"); do
  gh label create "mf:worker-$w" --color 5319E7 --description "multi-factory: assigned to worker $w" >/dev/null 2>&1 || true
done
gh label create "mf:relocated" --color BFD4F2 --description "multi-factory: issue spawned by checker RELOCATE (triage chain cap 1)" >/dev/null 2>&1 || true
mf_labels_boot
notify "multi-factory master started (workers=$WORKERS, mode=$(cat "$CONTROL/mode"), dry=$MF_DRY_RUN)"
# Claude capacity gates startup only while some difficulty actually routes to the
# claude provider — a codex/gemini-only configuration must start during a claude outage.
if [ "$MF_DRY_RUN" != 1 ] && mf_uses_claude; then wait_for_capacity "startup"; fi

while true; do
  tick
  sleep "$MF_TICK"
done
