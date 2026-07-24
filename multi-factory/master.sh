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
#   control/composer-request.json  optional one-shot owner composition brief
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
CONTROL=$MFSTATE/control; LOGS=$MFSTATE/logs; CIFIX=$MFSTATE/ci-fix
: "${WORKERS:=2}"
: "${MF_TICK:=15}"                # seconds between master loop ticks
: "${MF_STALL_SECS:=3600}"        # heartbeat silence that counts as a worker stall
: "${COMPOSER_BATCH:=10}"         # issues per composer run (owner 2026-07-16: big batches — amortize the per-cycle cost of the priciest role)
: "${MF_COMPOSER_COOLDOWN:=900}"  # min seconds between composer runs (base; also the floor after a reset)
: "${MF_COMPOSER_BACKOFF_MAX:=14400}"  # cap on the idle-backoff cooldown (empty composer runs)
: "${MF_COMPOSER_PROTOCOL_ATTEMPTS:=2}" # one corrective retry for a missing/malformed manifest
: "${MF_COMPOSER_PROTOCOL_COOLDOWN:=120}" # malformed runs retry separately from valid empty runs
: "${MF_COMPOSER_PROTOCOL_BACKOFF_MAX:=900}"
: "${MF_COMPOSER_DISCOVERY_ATTEMPTS:=6}" # no-cache post-create snapshots (GitHub lists can lag)
: "${MF_COMPOSER_DISCOVERY_SLEEP:=2}" # seconds between post-create snapshots
: "${MF_CIFIX_PROTOCOL_BACKOFF:=300}" # delay before the one no-head protocol retry
: "${MF_DRY_RUN:=0}"
if [ -z "${MF_MASTER_SESSION:-}" ]; then
  MF_MASTER_NONCE=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  [ -n "$MF_MASTER_NONCE" ] || MF_MASTER_NONCE="${RANDOM:-0}-${RANDOM:-0}"
  MF_MASTER_SESSION="${HOSTNAME:-master}-$(date +%s)-$$-$MF_MASTER_NONCE"
  unset MF_MASTER_NONCE
fi
export LOG_TAG="[master]"
export MF_EVENTLOG=$LOGS/events.log

COMPOSER_REQUEST_LOADED=0
COMPOSER_REQUEST_ID=
COMPOSER_REQUEST_EXACT_COUNT=
COMPOSER_REQUEST_BRIEF=

MF_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$MF_SCRIPT_DIR/contracts.sh"

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

# Difficulty is never inferred for scheduling. New diff:* issues must satisfy the
# full issue contract; legacy tier:* issues retain their pre-multi-factory
# behavior (including conservative wildcard serialization for missing mf-meta).
issue_schedule_contract_valid(){ # $1=issue
  local n=$1 issue labels diff_count valid_diff_count tier_count valid_tier_count body
  issue=$(jq -c --argjson n "$n" '.[]|select(.number==$n)' "$TICK_ISSUES")
  [ -n "$issue" ] || return 1
  labels=$(jq -r '.labels[]?' <<<"$issue")
  diff_count=$(grep -c '^diff:' <<<"$labels" || true)
  valid_diff_count=$(grep -cE '^diff:(easy|normal|intermediate|hard|max)$' <<<"$labels" || true)
  if [ "$diff_count" -gt 0 ]; then
    [ "$diff_count" -eq 1 ] && [ "$valid_diff_count" -eq 1 ] || return 1
    body=$(jq -r '.body // ""' <<<"$issue")
    mf_issue_body_valid "$body" ""
    return
  fi
  tier_count=$(grep -c '^tier:' <<<"$labels" || true)
  valid_tier_count=$(grep -cE '^tier:(sonnet|opus|fable)$' <<<"$labels" || true)
  [ "$tier_count" -eq 1 ] && [ "$valid_tier_count" -eq 1 ]
}

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
    grep -qx "$n" "$CONTROL/composer-quarantine" 2>/dev/null && continue
    issue_has_label "$n" autopilot || continue
    issue_has_label "$n" awaiting-owner && continue
    issue_schedule_contract_valid "$n" || continue
    # Dry-run cycles don't close real issues; skip ones already fake-completed.
    [ "$MF_DRY_RUN" = 1 ] && grep -qx "$n" "$CONTROL/dry-done" 2>/dev/null && continue
    deps=$(issue_body "$n" | mf_meta_deps)
    if [ -n "$deps" ]; then deps_closed "$deps" || continue; fi
    echo "$n"
  done
}

# ---- merge queue -----------------------------------------------------------------
enqueue_merge(){ # $1=pr $2=issue $3=claims $4=head $5=kind $6=comment id
  local pr=$1 issue=$2 claims=$3 approved_head=$4 approval_kind=$5 approval_comment_id=$6
  local existing touches payload
  existing=$(find "$QUEUE" -maxdepth 1 -type f -name "*-pr$pr.json" -print -quit 2>/dev/null)
  if [ -n "$existing" ]; then
    jq -e --arg h "$approved_head" --arg k "$approval_kind" --arg id "$approval_comment_id" \
      '.approved_head==$h and .approval_kind==$k and (.approval_comment_id|tostring)==$id' \
      "$existing" >/dev/null 2>&1
    return
  fi
  touches=$(printf '%s\n' "$claims" | jq -R . | jq -cs 'map(select(length>0))')
  payload=$(jq -cn --argjson pr "$pr" --argjson issue "$issue" --argjson touches "$touches" \
    --arg h "$approved_head" --arg k "$approval_kind" --arg id "$approval_comment_id" \
    --arg at "$(date -Is)" \
    '{pr:$pr,issue:$issue,touches:$touches,approved_head:$h,approval_kind:$k,
      approval_comment_id:$id,enqueued_at:$at}')
  atomic_write "$QUEUE/$(date +%s)-pr$pr.json" "$payload" || return 1
  log "merge-queue ← PR #$pr (issue #$issue, head ${approved_head:0:12}, $approval_kind)"
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
  local w af sf n age sphase smtime skip pr comments phead
  for w in $(seq 1 "$WORKERS"); do
    af=$ASSIGN/worker-$w.json; [ -f "$af" ] || continue
    sf=$STATUS/worker-$w.json; skip=$STATUS/.stallskip-$w
    age=$(file_age "$STATUS/worker-$w.hb")
    if [ "$age" -lt "$MF_STALL_SECS" ]; then rm -f "$skip"; continue; fi
    n=$(jq -r '.issue' "$af")
    # False-stall guard (issue #497): a live worker whose heartbeat toucher died is
    # not a dead worker. If its status file shows an ACTIVE phase AND was itself
    # written within the stall window, treat the worker as alive — skip the reset,
    # log once. Only a truly dead worker (stale hb AND stale status mtime) recovers.
    sphase=$(jq -r '.phase // ""' "$sf" 2>/dev/null)
    smtime=$(file_age "$sf")
    case "$sphase" in
      writing|reviewing|fixing|triage)
        if [ "$smtime" -lt "$MF_STALL_SECS" ]; then
          [ -f "$skip" ] || { log "worker $w heartbeat stale (${age}s) but status active ($sphase, ${smtime}s) — treating as alive, skipping reset"; : >"$skip"; }
          continue
        fi;;
    esac
    rm -f "$skip"
    log "worker $w STALLED on issue #$n (heartbeat ${age}s old) — recovering"
    # Killed-mid-run recovery semantics: authoritative re-check, then reset/reassign.
    case "$(gh api "repos/$REPO/issues/$n" --jq .state 2>/dev/null || echo unknown)" in
      closed) rm -f "$af"; log "  issue #$n already closed — assignment cleared"; continue;;
    esac
    pr=$(gh pr list --head "task/$n" --state open --json number -q '.[0].number' 2>/dev/null || true)
    if [ -n "$pr" ]; then
      if comments=$(mf_pr_comments_json "$pr") && phead=$(mf_pr_head "$pr") \
        && mf_latest_approval_for_head "$comments" "$phead"; then
        if enqueue_merge "$pr" "$n" "$(jq -r '.touches[]?' "$af")" "$phead" \
          "$MF_APPROVAL_KIND" "$MF_APPROVAL_ID"; then
          rm -f "$af"; log "  approved PR #$pr salvaged to merge queue"; continue
        fi
        log "  merge-queue write failed; keeping stalled assignment for retry"
        continue
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

composer_record_outcome(){ # $1=created|idle $2=snapshot $3=current backoff
  local outcome=$1 snap=$2 backoff=$3 prev="" next=$MF_COMPOSER_COOLDOWN
  [ -f "$CONTROL/.composer-snapshot" ] && prev=$(<"$CONTROL/.composer-snapshot")
  if [ "$outcome" = idle ] && [ -f "$CONTROL/.composer-snapshot" ] && [ "$snap" = "$prev" ]; then
    next=$(( backoff * 2 ))
    [ "$next" -le "$MF_COMPOSER_BACKOFF_MAX" ] || next=$MF_COMPOSER_BACKOFF_MAX
    log "composer idle-backoff: valid empty run, next in ${next}s"
  elif [ "$backoff" != "$MF_COMPOSER_COOLDOWN" ]; then
    log "composer idle-backoff reset to ${MF_COMPOSER_COOLDOWN}s ($outcome)"
  fi
  atomic_write "$CONTROL/.composer-backoff" "$next" || return 1
  atomic_write "$CONTROL/.composer-snapshot" "$snap" || return 1
  touch "$CONTROL/.composer-last"
  rm -f "$CONTROL/.composer-protocol-last" "$CONTROL/.composer-protocol-backoff"
}

composer_protocol_ready(){
  local wait; wait=$(cat "$CONTROL/.composer-protocol-backoff" 2>/dev/null)
  case "$wait" in ''|*[!0-9]*) wait=$MF_COMPOSER_PROTOCOL_COOLDOWN;; esac
  [ "$(file_age "$CONTROL/.composer-protocol-last")" -ge "$wait" ]
}

composer_record_protocol_failure(){
  local current next
  current=$(cat "$CONTROL/.composer-protocol-backoff" 2>/dev/null)
  case "$current" in ''|*[!0-9]*) current=$MF_COMPOSER_PROTOCOL_COOLDOWN;; esac
  if [ -f "$CONTROL/.composer-protocol-last" ]; then
    next=$((current * 2))
    [ "$next" -le "$MF_COMPOSER_PROTOCOL_BACKOFF_MAX" ] || next=$MF_COMPOSER_PROTOCOL_BACKOFF_MAX
  else
    next=$current
  fi
  atomic_write "$CONTROL/.composer-protocol-backoff" "$next" || return 1
  touch "$CONTROL/.composer-protocol-last"
}

composer_quarantine(){ # space-separated issue ids
  local ids=$1 current="" merged
  [ -n "$ids" ] || return 0
  [ -f "$CONTROL/composer-quarantine" ] && current=$(<"$CONTROL/composer-quarantine")
  merged=$(printf '%s\n%s\n' "$current" "$(tr ' ' '\n' <<<"$ids")" \
    | grep -E '^[0-9]+$' | sort -un)
  atomic_write "$CONTROL/composer-quarantine" "$merged"
  log "composer quarantine: issues [$ids] are not schedulable"
}

# One-shot owner composition requests live entirely in gitignored control state:
#   composer-request.json                  ready (owner-written atomically)
#   .composer-request-active.json          claimed, original request preserved
#   .composer-request-claim/session        process/session replay guard
#   composer-request-archive/<id>-<run>.json  consumed only after exact success
#
# The claim directory is the cross-process mutex. A different master session
# encountering an active claim fails closed: it must not replay a request whose
# first process may already have created GitHub issues. tick() also suppresses
# scheduling in that state so unvalidated crash-window artifacts cannot run.
composer_request_validate(){ # $1=request file
  local file=$1 max=$COMPOSER_BATCH
  case "$max" in ''|*[!0-9]*|0) return 1;; esac
  jq -e --argjson max "$max" '
    type == "object"
    and ((keys_unsorted - ["approved","brief","exact_count","id","version"]) | length == 0)
    and .version == 1
    and .approved == true
    and (.id | type == "string"
      and test("^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$"))
    and (.brief | type == "string" and length > 0 and length <= 20000)
    and (.exact_count | type == "number" and . == floor and . >= 1)
    and .exact_count <= $max
  ' "$file" >/dev/null 2>&1
}

composer_request_alert_once(){ # $1=reason key $2=message
  local key=$1 message=$2 claim="$CONTROL/.composer-request-claim"
  local marker="$claim/alerted" previous=""
  [ -f "$marker" ] && previous=$(<"$marker")
  [ "$previous" = "$key" ] && return 0
  atomic_write "$marker" "$key" 2>/dev/null || true
  log "$message"
  notify "$message"
}

composer_request_mark_blocked(){ # $1=terminal reason after bounded attempts
  local reason=$1 claim="$CONTROL/.composer-request-claim"
  if ! atomic_write "$claim/blocked" "$reason"; then
    # Poison the session owner as a second fail-closed guard. The current master
    # then looks foreign on its next tick rather than replaying the request.
    atomic_write "$claim/session" "blocked-$MF_MASTER_SESSION" 2>/dev/null || true
  fi
  composer_request_alert_once "blocked:$reason" \
    "composer request retained for owner review after $reason — automatic replay disabled"
}

composer_request_prepare(){ # $1=allow ready→active claim (default 1); 0=none/loaded, 2=unsafe
  local allow_ready_claim=${1:-1}
  local ready active claim session_file
  ready="$CONTROL/composer-request.json"
  active="$CONTROL/.composer-request-active.json"
  claim="$CONTROL/.composer-request-claim"
  session_file="$claim/session"
  local owner=""
  COMPOSER_REQUEST_LOADED=0
  COMPOSER_REQUEST_ID=
  COMPOSER_REQUEST_EXACT_COUNT=
  COMPOSER_REQUEST_BRIEF=

  # An active file without its mutex is an indeterminate crash window. Never
  # adopt/replay it automatically.
  if [ -f "$active" ] && [ ! -d "$claim" ]; then
    # There is no claim dir in which to persist an alert marker, so only log.
    log "composer request needs owner reconciliation — active request has no replay guard"
    return 2
  fi

  if [ -d "$claim" ]; then
    [ -f "$session_file" ] && owner=$(<"$session_file")
    if [ "$owner" != "$MF_MASTER_SESSION" ]; then
      # A completed archive can leave only an empty/stale claim if the process
      # died between mv and rmdir. With no ready/active request, cleanup is safe.
      if [ ! -f "$active" ] && [ ! -f "$ready" ]; then
        rm -f "$session_file" "$claim/alerted" "$claim/blocked"
        rmdir "$claim" 2>/dev/null || true
        return 0
      fi
      composer_request_alert_once foreign-session \
        "composer request needs owner reconciliation — refusing restart replay (${owner:-unknown})"
      return 2
    fi
    if [ -f "$claim/blocked" ]; then
      composer_request_alert_once "blocked:$(<"$claim/blocked")" \
        "composer request is retained for owner review — automatic replay disabled"
      return 2
    fi
  else
    mkdir "$claim" 2>/dev/null || {
      log "composer request blocked: concurrent claim acquisition"
      return 2
    }
    atomic_write "$session_file" "$MF_MASTER_SESSION" || {
      log "composer request blocked: cannot persist replay guard"
      return 2
    }
    rm -f "$claim/alerted"
  fi

  if [ ! -f "$active" ]; then
    if [ ! -f "$ready" ]; then
      rm -f "$session_file" "$claim/alerted" "$claim/blocked"
      rmdir "$claim" 2>/dev/null || true
      return 0
    fi
    if [ "$allow_ready_claim" != 1 ]; then
      composer_request_alert_once composition-disabled \
        "composer request remains ready — refusing to claim while composition is disabled"
      return 2
    fi
    mv "$ready" "$active" || {
      log "composer request blocked: cannot claim ready request"
      return 2
    }
  fi

  if ! composer_request_validate "$active"; then
    composer_request_mark_blocked invalid-request
    return 2
  fi

  COMPOSER_REQUEST_ID=$(jq -r '.id' "$active")
  COMPOSER_REQUEST_EXACT_COUNT=$(jq -r '.exact_count' "$active")
  # The sentinel prevents command substitution from stripping trailing newlines
  # out of the owner text. Strip only the sentinel we appended ourselves.
  COMPOSER_REQUEST_BRIEF=$(jq -jr '.brief, "__MF_BRIEF_SENTINEL__"' "$active")
  COMPOSER_REQUEST_BRIEF=${COMPOSER_REQUEST_BRIEF%__MF_BRIEF_SENTINEL__}
  COMPOSER_REQUEST_LOADED=1
  return 0
}

composer_request_archive(){ # $1=validated composer run id
  local run_id=$1 active claim archive_dir archive
  active="$CONTROL/.composer-request-active.json"
  claim="$CONTROL/.composer-request-claim"
  archive_dir="$CONTROL/composer-request-archive"
  archive="$archive_dir/${COMPOSER_REQUEST_ID}-${run_id}.json"
  [ "$COMPOSER_REQUEST_LOADED" -eq 1 ] && [ -f "$active" ] || return 1
  mkdir -p "$archive_dir" || return 1
  [ ! -e "$archive" ] || return 1
  mv "$active" "$archive" || return 1
  rm -f "$claim/session" "$claim/alerted" "$claim/blocked"
  rmdir "$claim" 2>/dev/null || {
    log "composer request archived but stale claim directory remains: $claim"
  }
  log "composer request $COMPOSER_REQUEST_ID archived after exact manifest success"
  COMPOSER_REQUEST_LOADED=0
  return 0
}

# GitHub's collection endpoint can briefly lag a successful `gh issue create`.
# The helper-written manifest is authoritative enough to identify the expected
# issue numbers, but it is not sufficient by itself: we still accumulate
# no-cache collection snapshots so an extra, unmanifested issue fails the
# before/after contract. Direct reads fill only manifest IDs that the list has
# not exposed yet. Every outcome consumes the full bounded grace period so a
# delayed unmanifested artifact can never arrive after an early acceptance.
composer_discovery_after(){ # $1=manifest
  local manifest=$1 attempts=$MF_COMPOSER_DISCOVERY_ATTEMPTS
  local pause=$MF_COMPOSER_DISCOVERY_SLEEP attempt after issue merged n
  local ids="" accumulated='[]'
  case "$attempts" in ''|*[!0-9]*|0) attempts=6;; esac
  case "$pause" in ''|*[!0-9]*) pause=2;; esac
  if [ -s "$manifest" ]; then
    ids=$(awk '/^ISSUE [0-9]+ (autopilot|awaiting-owner|relocated)$/{print $2}' \
      "$manifest" | sort -un)
  fi

  for attempt in $(seq 1 "$attempts"); do
    after=$(mf_recent_issues_json) || return 1
    jq -e 'type=="array"' <<<"$after" >/dev/null 2>&1 || return 1
    merged=$(jq -cn --argjson seen "$accumulated" --argjson latest "$after" \
      '$seen + $latest | unique_by(.number)') || return 1
    accumulated=$merged

    # A just-created issue is immediately addressable by number even when the
    # collection response is still stale. Never synthesize data from the
    # manifest: the direct API object must satisfy the normal validator.
    for n in $ids; do
      if ! jq -e --argjson n "$n" 'map(.number) | index($n) != null' \
        <<<"$accumulated" >/dev/null 2>&1; then
        issue=$(mf_issue_json_by_number "$n") || continue
        jq -e 'type=="object" and (.number|type=="number")' \
          <<<"$issue" >/dev/null 2>&1 || continue
        merged=$(jq -cn --argjson seen "$accumulated" --argjson issue "$issue" \
          '$seen + [$issue] | unique_by(.number)') || return 1
        accumulated=$merged
      fi
    done

    [ "$attempt" -eq "$attempts" ] || [ "$pause" -eq 0 ] || sleep "$pause"
  done
  printf '%s\n' "$accumulated"
}

composer_step(){ # $1=mode
  local mode=$1 allow_ready_claim=0
  [ "$mode" = run ] && allow_ready_claim=1
  # Reconcile an already-active request before the mode gate. run-out still
  # assigns queued issues, so it must not expose crash-window artifacts from an
  # unresolved request. close-down does not assign, but returns the same
  # fail-closed signal in case the mode changes before tick() reaches scheduler.
  if [ "$MF_DRY_RUN" != 1 ] \
    && { [ -f "$CONTROL/.composer-request-active.json" ] \
      || [ -d "$CONTROL/.composer-request-claim" ]; }; then
    composer_request_prepare "$allow_ready_claim"
    case "$?" in
      0) ;;
      2) return 2;;
      *) return 1;;
    esac
  else
    # Keep the in-memory view aligned when an owner has reconciled retained
    # state without restarting this master process.
    COMPOSER_REQUEST_LOADED=0
    COMPOSER_REQUEST_ID=
    COMPOSER_REQUEST_EXACT_COUNT=
    COMPOSER_REQUEST_BRIEF=
  fi
  if [ "$mode" != run ]; then
    # A valid same-session active request was loaded but cannot be resumed while
    # composition is disabled. It remains unresolved, so scheduling must pause.
    [ "$COMPOSER_REQUEST_LOADED" -eq 1 ] && return 2
    return 0
  fi
  local count; count=$(runnable_issues | grep -c . || true)
  [ "$count" -lt $((WORKERS + 1)) ] || return 0
  composer_protocol_ready || return 0
  # Claim a new ready request only once the normal composer capacity gate says
  # this tick can run it and its protocol cooldown has elapsed. This avoids
  # holding a request across an unrelated backlog drain/backoff (and turning an
  # otherwise harmless restart into a replay lock).
  if [ "$MF_DRY_RUN" != 1 ] && [ "$COMPOSER_REQUEST_LOADED" -ne 1 ]; then
    composer_request_prepare 1
    case "$?" in
      0) ;;
      2) return 2;;
      *) return 1;;
    esac
  fi
  local backoff; backoff=$(cat "$CONTROL/.composer-backoff" 2>/dev/null)
  case "$backoff" in ''|*[!0-9]*) backoff=$MF_COMPOSER_COOLDOWN;; esac
  # A freshly owner-approved request is an explicit re-arm and carries its own
  # exact per-run batch. Normal composition retains the idle cooldown unchanged.
  if [ "$COMPOSER_REQUEST_LOADED" -ne 1 ]; then
    [ "$(file_age "$CONTROL/.composer-last")" -ge "$backoff" ] || return 0
  fi

  local snap; snap=$(composer_snapshot "$mode")

  if [ "$MF_DRY_RUN" = 1 ]; then
    log "DRY: composer would run (runnable=$count)"
    composer_record_outcome idle "$snap" "$backoff"
    return
  fi
  log "runnable=$count < $((WORKERS+1)) → running composer"
  mstatus composing
  ( cd "$REPO_DIR" \
    && git checkout -q main && git fetch -q origin main && git reset -q --hard origin/main \
    && node factory/knowledge/build.mjs 2>>"$LOG" ) || log "composer pre-sync failed (non-fatal)"
  local attempt before after manifest run_id transport outcome=protocol newnums prompt
  local prompt_batch=$COMPOSER_BATCH manifest_issue_count
  local outcome_recorded=0
  [ "$COMPOSER_REQUEST_LOADED" -eq 1 ] \
    && prompt_batch=$COMPOSER_REQUEST_EXACT_COUNT
  local invalid_new_seen=0
  mkdir -p "$CONTROL/composer-manifests"
  for attempt in $(seq 1 "$MF_COMPOSER_PROTOCOL_ATTEMPTS"); do
    before=$(mf_recent_issues_json) || {
      log "composer protocol: cannot snapshot repository issues — retrying next tick"
      break
    }
    run_id="composer-$(date +%s)-$$-$attempt"
    manifest="$CONTROL/composer-manifests/$run_id"
    : >"$manifest"
    prompt=$(sed \
      -e "s/{{BATCH}}/$prompt_batch/g" \
      -e "s|{{RUN_ID}}|$run_id|g" \
      -e "s|{{MANIFEST}}|$manifest|g" \
      "$MF_PROMPTS/composer.md")
    if [ "$COMPOSER_REQUEST_LOADED" -eq 1 ]; then
      prompt="$prompt

<<< OWNER-APPROVED COMPOSITION BRIEF BEGIN: $COMPOSER_REQUEST_ID (EXACT_COUNT=$COMPOSER_REQUEST_EXACT_COUNT) >>>
$COMPOSER_REQUEST_BRIEF
<<< OWNER-APPROVED COMPOSITION BRIEF END: $COMPOSER_REQUEST_ID >>>"
    fi
    [ "$attempt" -gt 1 ] && prompt="$prompt

PROTOCOL CORRECTION RETRY: the previous invocation did not produce a valid
manifest/artifact set. Do not claim or edit unmarked issues from that attempt;
targeted duplicate searches will find them. Use only the required helper and
finish the manifest contract this time."
    if CC_ISSUE=- mf_cc composer "$(role_diff composer)" "$(with_pack "$prompt")"; then
      transport=0
    else
      transport=$?
    fi
    after=$(composer_discovery_after "$manifest") || {
      log "composer protocol: post-run issue discovery failed; suppressing corrective model retry"
      break
    }
    newnums=$(mf_new_issue_numbers "$before" "$after" | xargs)
    log "composer discovery ($run_id): new repository issues [${newnums:-none}]"
    if mf_manifest_validate "$manifest" "$before" "$after" "$run_id" ""; then
      case "$MF_MANIFEST_KIND" in
        issues)
          if [ "$COMPOSER_REQUEST_LOADED" -eq 1 ]; then
            manifest_issue_count=$(grep -cE '^ISSUE [0-9]+ (autopilot|awaiting-owner|relocated)$' \
              "$manifest" || true)
            if [ "$manifest_issue_count" -ne "$COMPOSER_REQUEST_EXACT_COUNT" ]; then
              log "composer request $COMPOSER_REQUEST_ID: expected $COMPOSER_REQUEST_EXACT_COUNT issues, got $manifest_issue_count"
              notify "composer request exact-count mismatch — artifacts quarantined; brief retained"
            elif [ "$invalid_new_seen" -ne 0 ]; then
              log "composer request $COMPOSER_REQUEST_ID: earlier attempt created invalid artifacts"
              notify "composer request had prior artifacts — current issues quarantined; brief retained"
            elif composer_record_outcome created "$snap" "$backoff"; then
              # Persist the cooldown BEFORE consuming the request. If the master
              # dies immediately after the archive move, the next process sees
              # the new issues but cannot compose an accidental extra batch.
              outcome_recorded=1
              if composer_request_archive "$run_id"; then
                outcome=created
                log "composer contract accepted issues: $MF_MANIFEST_ISSUES"
                break
              fi
              log "composer request $COMPOSER_REQUEST_ID: exact result valid but archive failed"
              notify "composer request archive failed — artifacts quarantined; brief retained"
            else
              log "composer request $COMPOSER_REQUEST_ID: cannot persist exact result"
              notify "composer request outcome persistence failed — artifacts quarantined; brief retained"
            fi
          else
            outcome=created
            log "composer contract accepted issues: $MF_MANIFEST_ISSUES"
            break
          fi
          ;;
        none)
          if [ "$COMPOSER_REQUEST_LOADED" -eq 1 ]; then
            log "composer request $COMPOSER_REQUEST_ID: NONE rejected for exact-count request"
            notify "composer request returned NONE — brief retained for bounded retry"
          elif [ "$transport" -eq 0 ] && [ "$invalid_new_seen" -eq 0 ]; then
            outcome=idle
            break
          fi
          ;;
      esac
    fi
    if [ -n "$newnums" ]; then
      invalid_new_seen=1
      composer_quarantine "$newnums" || true
    fi
    log "composer protocol failure (attempt $attempt/$MF_COMPOSER_PROTOCOL_ATTEMPTS, transport=$transport)"
  done

  if [ "$outcome" = protocol ]; then
    # A malformed run does not advance the valid-empty cooldown, but it has its
    # own bounded backoff so a bad provider cannot fire twice every 15-second tick.
    composer_record_protocol_failure || true
    if [ "$COMPOSER_REQUEST_LOADED" -eq 1 ]; then
      composer_request_mark_blocked protocol-failure
      return 2
    fi
    notify "composer protocol failed — artifacts quarantined; bounded retry remains armed"
    return 1
  fi
  if [ "$outcome_recorded" -ne 1 ]; then
    composer_record_outcome "$outcome" "$snap" "$backoff" || {
      log "composer: failed to persist cooldown outcome"
      return 1
    }
  fi
  [ "$outcome" = created ] && fetch_issues
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
requeue_for_review(){ # $1=queue file $2=issue $3=reason
  local f=$1 n=$2 why=$3
  log "merger: approval invalidated for issue #$n — $why; requeueing for fresh review"
  rm -f "$f"
  gh issue edit "$n" --remove-label in-progress >/dev/null 2>&1 || true
}

ci_fix_state_file(){ printf '%s/issue-%s-pr%s.json' "$CIFIX" "$1" "$2"; }

ci_fix_state_write(){ # $1=file $2=issue $3=pr $4=invocations $5=used $6=status $7=next_at $8=source_head
  local f=$1 n=$2 pr=$3 invocations=$4 used=$5 status=$6 next_at=$7 source_head=$8
  mkdir -p "$CIFIX"
  atomic_write "$f" "$(jq -cn \
    --argjson issue "$n" --argjson pr "$pr" --argjson invocations "$invocations" \
    --argjson valid_fix_used "$used" --arg status "$status" --argjson next_at "$next_at" \
    --arg source_head "$source_head" --arg at "$(date -Is)" \
    '{issue:$issue,pr:$pr,invocations:$invocations,valid_fix_used:$valid_fix_used,
      status:$status,next_at:$next_at,source_head:$source_head,updated_at:$at}')"
}

ci_fix_exhaust(){ # $1=queue file $2=state file $3=issue $4=pr $5=invocations $6=source head
  local f=$1 sf=$2 n=$3 pr=$4 invocations=$5 source_head=$6
  ci_fix_state_write "$sf" "$n" "$pr" "$invocations" false exhausted 0 "$source_head" || return 1
  log "merger: CI-fix protocol exhausted on PR #$pr after $invocations no-head invocations"
  mark_human "$n" "CI-fix produced no pushed head after its bounded protocol retry"
  rm -f "$f"
}

ci_fix_red_step(){ # $1=queue file $2=issue $3=pr $4=approved head
  local f=$1 n=$2 pr=$3 approved_head=$4 sf now invocations used status next_at source_head current
  local fixed_head ci_transport
  sf=$(ci_fix_state_file "$n" "$pr")
  now=$(date +%s)
  invocations=0; used=false; status=ready; next_at=0; source_head="$approved_head"
  if [ -f "$sf" ]; then
    invocations=$(jq -r '.invocations // 0' "$sf" 2>/dev/null || echo 0)
    used=$(jq -r '.valid_fix_used // false' "$sf" 2>/dev/null || echo false)
    status=$(jq -r '.status // "ready"' "$sf" 2>/dev/null || echo ready)
    next_at=$(jq -r '.next_at // 0' "$sf" 2>/dev/null || echo 0)
    source_head=$(jq -r '.source_head // ""' "$sf" 2>/dev/null || true)
    case "$invocations:$next_at" in
      *[!0-9:]*|:) log "merger: malformed CI-fix state for issue #$n/PR #$pr"; return 1;;
    esac
  fi

  # Reconcile a master death after invoking the fixer but before recording its
  # postcondition. A changed head consumes the sole real fix; an unchanged head
  # consumes only this invocation and arms at most one delayed protocol retry.
  if [ "$status" = running ] || [ "$status" = protocol-backoff ]; then
    current=$(mf_pr_head "$pr") || {
      log "merger: cannot reconcile in-flight CI-fix state for PR #$pr"
      return 0
    }
    if [ -n "$source_head" ] && [ "$current" != "$source_head" ]; then
      ci_fix_state_write "$sf" "$n" "$pr" "$invocations" true pushed 0 "$source_head" || return 1
      used=true; status=pushed
    elif [ "$status" = running ] && [ "$invocations" -lt 2 ]; then
      ci_fix_state_write "$sf" "$n" "$pr" "$invocations" false protocol-backoff \
        "$((now + MF_CIFIX_PROTOCOL_BACKOFF))" "$source_head" || return 1
      status=protocol-backoff; next_at=$((now + MF_CIFIX_PROTOCOL_BACKOFF))
    elif [ "$status" = running ]; then
      ci_fix_exhaust "$f" "$sf" "$n" "$pr" "$invocations" "$source_head"
      return
    fi
  fi

  if [ "$used" = true ] || [ "$status" = pushed ]; then
    ci_fix_state_write "$sf" "$n" "$pr" "$invocations" true exhausted 0 "$source_head" || return 1
    log "merger: CI still red after the one pushed CI-fix on PR #$pr"
    mark_human "$n" "CI still failing after the factory's one CI-fix attempt and fresh review"
    rm -f "$f"
    return 0
  fi
  [ "$status" = exhausted ] && { rm -f "$f"; return 0; }
  if [ "$status" = protocol-backoff ] && [ "$now" -lt "$next_at" ]; then
    log "merger: CI-fix protocol retry for PR #$pr is delayed until epoch $next_at"
    return 0
  fi
  if [ "$invocations" -ge 2 ]; then
    ci_fix_exhaust "$f" "$sf" "$n" "$pr" "$invocations" "$source_head"
    return
  fi

  invocations=$((invocations + 1))
  source_head=$approved_head
  ci_fix_state_write "$sf" "$n" "$pr" "$invocations" false running 0 "$source_head" || return 1
  log "merger: CI red on PR #$pr — CI-fix invocation $invocations/2"
  mstatus ci-fix "$pr"
  if CC_ISSUE=$n mf_cc ci-fix "$(issue_difficulty "$n")" \
    "CI failed on PR #$pr of $REPO at approved head $approved_head. cd into the repo, check out the PR branch, run 'gh pr checks $pr' and 'gh run view --log-failed' to see why, fix it properly (no test-deletion, no skips), run the tests locally, and push. A pushed head always requires a fresh factory review."; then
    ci_transport=0
  else
    ci_transport=$?
  fi
  fixed_head=$(mf_pr_head "$pr") || {
    log "merger: cannot read head after CI-fix invocation $invocations — durable running state retained"
    return 0
  }
  if [ "$fixed_head" != "$approved_head" ]; then
    ci_fix_state_write "$sf" "$n" "$pr" "$invocations" true pushed 0 "$approved_head" || return 1
    requeue_for_review "$f" "$n" "CI-fix pushed ${fixed_head:0:12}"
  elif [ "$invocations" -lt 2 ]; then
    ci_fix_state_write "$sf" "$n" "$pr" "$invocations" false protocol-backoff \
      "$((now + MF_CIFIX_PROTOCOL_BACKOFF))" "$approved_head" || return 1
    log "merger: CI-fix produced no new head (transport=$ci_transport) — one delayed protocol retry armed"
  else
    ci_fix_exhaust "$f" "$sf" "$n" "$pr" "$invocations" "$approved_head"
  fi
}

queue_approval_check(){ # $1=queue JSON; sets QUEUE_APPROVAL_STATE
  local f=$1 pr head kind comment_id comments current
  QUEUE_APPROVAL_STATE=invalid
  pr=$(jq -r '.pr' "$f")
  head=$(jq -r '.approved_head // ""' "$f")
  kind=$(jq -r '.approval_kind // ""' "$f")
  comment_id=$(jq -r '.approval_comment_id // ""' "$f")
  [ -n "$head" ] && [ -n "$comment_id" ] || return 0
  current=$(mf_pr_head "$pr") || return 1
  if [ "$current" != "$head" ]; then
    QUEUE_APPROVAL_STATE=changed
    return 0
  fi
  comments=$(mf_pr_comments_json "$pr") || return 1
  if mf_approval_comment_valid "$comments" "$comment_id" "$kind" "$head"; then
    QUEUE_APPROVAL_STATE=valid
  fi
  return 0
}

merger_step(){
  local head; head=$(ls "$QUEUE" 2>/dev/null | grep -E '^[0-9]+-pr[0-9]+\.json$' | sort -n | head -1)
  [ -n "$head" ] || return 0
  local f=$QUEUE/$head pr n approved_head ci_state
  pr=$(jq -r '.pr' "$f"); n=$(jq -r '.issue' "$f")
  ci_state=$(ci_fix_state_file "$n" "$pr")
  approved_head=$(jq -r '.approved_head // ""' "$f")
  if [ "$MF_DRY_RUN" = 1 ]; then log "DRY: would merge PR #$pr (issue #$n)"; rm -f "$f"; return 0; fi
  local pstate
  pstate=$(gh pr view "$pr" --json state -q '.state' 2>/dev/null || echo unknown)
  case "$pstate" in
    MERGED) log "merger: PR #$pr already merged — finalizing"
            finalize_issue "$pr" "$n"; rm -f "$f" "$ci_state"; return 0;;
    OPEN)   ;;
    unknown) log "merger: cannot read PR #$pr (transient?) — retrying next tick"; return 0;;
    *)      mark_human "$n" "PR #$pr $pstate without merge"; rm -f "$f" "$ci_state"; return 0;;
  esac

  # Approval is bound to both one canonical comment and the exact code SHA.
  # Read failures are transient and never consume/drop the queue record.
  if ! queue_approval_check "$f"; then
    log "merger: approval read failed for PR #$pr — retrying next tick"
    return 0
  fi
  case "$QUEUE_APPROVAL_STATE" in
    changed) requeue_for_review "$f" "$n" "head changed from ${approved_head:0:12}"; return 0;;
    invalid) requeue_for_review "$f" "$n" "canonical approval missing/malformed"; return 0;;
  esac

  # CI rollup, non-blocking (empty rollup = checks not reported yet = pending).
  local rollup
  rollup=$(gh pr view "$pr" --json statusCheckRollup \
    -q '[.statusCheckRollup[]| .conclusion // .status // "PENDING"]|join(",")' 2>/dev/null || echo QUERY_FAILED)
  [ "$rollup" = QUERY_FAILED ] && { log "merger: rollup read failed for PR #$pr — retrying next tick"; return 0; }
  if grep -qE 'FAILURE|TIMED_OUT|CANCELLED|ACTION_REQUIRED' <<<"$rollup"; then
    ci_fix_red_step "$f" "$n" "$pr" "$approved_head"
    return 0
  fi
  if [ -z "$rollup" ] || grep -qE 'PENDING|IN_PROGRESS|QUEUED|EXPECTED|WAITING' <<<"$rollup"; then
    return 0   # still running — check again next tick
  fi

  # Green. A strict-BEHIND update changes code and therefore invalidates review;
  # update now, then let the normal head check requeue it for a fresh review.
  local merge_state current_head
  merge_state=$(gh pr view "$pr" --json mergeStateStatus -q .mergeStateStatus 2>/dev/null) || {
    log "merger: merge-state read failed for PR #$pr — retrying next tick"
    return 0
  }
  current_head=$(mf_pr_head "$pr") || return 0
  if [ "$current_head" != "$approved_head" ]; then
    requeue_for_review "$f" "$n" "head changed before merge"
    return 0
  fi
  if [ "$merge_state" = BEHIND ]; then
    if gh pr update-branch "$pr" >/dev/null 2>&1; then
      log "merger: updated BEHIND PR #$pr; fresh review required"
    else
      log "merger: update-branch failed for PR #$pr — retrying next tick"
    fi
    return 0
  fi

  mstatus merging "$pr"
  if gh pr merge "$pr" --squash --delete-branch; then
    finalize_issue "$pr" "$n"
  else
    current_head=$(mf_pr_head "$pr" 2>/dev/null || true)
    if [ -n "$current_head" ] && [ "$current_head" != "$approved_head" ]; then
      requeue_for_review "$f" "$n" "head changed during merge attempt"
      return 0
    fi
    log "merger: merge command failed without a head change — retaining queue record"
    return 0
  fi
  rm -f "$f" "$ci_state"
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
  local composer_rc=0
  composer_step "$mode" || composer_rc=$?
  # The composer (and merger LLM/regate paths) can block this tick for minutes;
  # re-read the mode so a close-down/run-out issued meanwhile is honored BEFORE
  # the scheduler hands out new work (caught live: stale 'run' assigned an issue
  # 6 minutes into close-down).
  mode=$(cat "$CONTROL/mode" 2>/dev/null || echo run)
  if [ "$composer_rc" -eq 2 ]; then
    log "scheduler paused: unresolved one-shot composer request"
  else
    scheduler "$mode"
  fi
  merger_step
  drained_check "$mode"
  mstatus idle
}

# ---- boot + main loop (skipped when sourced for tests) -----------------------------
if [ "${MF_SOURCE_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi

mkdir -p "$ASSIGN" "$STATUS" "$QUEUE" "$CONTROL" "$LOGS" "$CIFIX"
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
