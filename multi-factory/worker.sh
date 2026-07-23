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
LOGS=$MFSTATE/logs; TRIAGE=$MFSTATE/triage
AF=$ASSIGN/worker-$WORKER_ID.json
HB=$STATUS/worker-$WORKER_ID.hb
: "${MF_DRY_RUN:=0}"; : "${MF_DRY_SECS:=8}"
: "${MF_PROTOCOL_ATTEMPTS:=2}"; : "${MF_PROTOCOL_RETRY_SLEEP:=20}"
: "${MF_GH_READ_ATTEMPTS:=3}"; : "${MF_GH_READ_RETRY_SLEEP:=10}"
export LOG_TAG="[w$WORKER_ID]"
export MF_EVENTLOG=$LOGS/events.log
export WORKER_ID

MF_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$MF_SCRIPT_DIR/contracts.sh"

# Pure helpers below (salvage_branch) are unit-tested on the host: test.sh sets
# MF_SOURCE_ONLY=1, stubs gh/log/git, and sources this file (lib.sh + boot + main
# loop skipped).
if [ "${MF_SOURCE_ONLY:-0}" != 1 ]; then
  . /work/mf/lib.sh
  . /work/mf/mflib.sh
fi

# owner 2026-07-22 (b): Fable meter critical — EVERY stage of diff:max issues runs at hard (Opus),
# writer included; only the composer (master, rare ≤2-issues runs) still spends Fable.
post_write_diff(){ local d="$1"; [ "$d" = max ] && d=hard; echo "$d"; }

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

enqueue_merge(){ # $1=pr $2=issue $3=approved head $4=reviewer|checker $5=comment id
  local pr=$1 issue=$2 approved_head=$3 approval_kind=$4 approval_comment_id=$5
  local existing touches payload
  existing=$(find "$QUEUE" -maxdepth 1 -type f -name "*-pr$pr.json" -print -quit 2>/dev/null)
  if [ -n "$existing" ]; then
    jq -e --arg h "$approved_head" --arg k "$approval_kind" --arg id "$approval_comment_id" \
      '.approved_head==$h and .approval_kind==$k and (.approval_comment_id|tostring)==$id' \
      "$existing" >/dev/null 2>&1
    return
  fi
  touches=$(jq -c '.touches // []' "$AF" 2>/dev/null || echo '[]')
  payload=$(jq -cn --argjson pr "$pr" --argjson issue "$issue" --argjson touches "$touches" \
    --arg h "$approved_head" --arg k "$approval_kind" --arg id "$approval_comment_id" \
    --arg at "$(date -Is)" \
    '{pr:$pr,issue:$issue,touches:$touches,approved_head:$h,approval_kind:$k,
      approval_comment_id:$id,enqueued_at:$at}')
  atomic_write "$QUEUE/$(date +%s)-pr$pr.json" "$payload" || {
    log "merge-queue write FAILED for PR #$pr"
    return 1
  }
  log "merge-queue ← PR #$pr (issue #$issue, head ${approved_head:0:12}, $approval_kind)"
}

# Difficulty of the current cycle — resolved once per assignment (mflib.sh).
CYCLE_DIFF=intermediate

# Append a dependency into an issue's mf-meta block (RELOCATE/BLOCKED path) so the
# scheduler's existing depends-on gating un-blocks it automatically when the new
# issue closes.
add_dep_to_issue(){ # $1=issue $2=dep-number
  local body new deps
  body=$(gh api "repos/$REPO/issues/$1" --jq .body 2>/dev/null) || return 1
  deps=$(mf_meta_deps <<<"$body")
  grep -qw "$2" <<<"$deps" && return 0
  if grep -q 'mf-meta' <<<"$body"; then
    if grep -qi '^[[:space:]]*depends-on:' <<<"$body"; then
      new=$(awk -v d="$2" 'BEGIN{done=0} {if(!done && $0 ~ /^[[:space:]]*depends-on:/){$0=$0", "d; done=1} print}' <<<"$body")
    else
      new=$(awk -v d="$2" 'BEGIN{done=0} {print; if(!done && $0 ~ /<!--[[:space:]]*mf-meta/){print "depends-on: "d; done=1}}' <<<"$body")
    fi
  else
    new=$(printf '%s\n\n<!-- mf-meta\ndepends-on: %s\ntouches: **\n-->' "$body" "$2")
  fi
  gh api -X PATCH "repos/$REPO/issues/$1" -f body="$new" >/dev/null 2>&1
}

issue_json_read(){ # $1=issue number
  gh api "repos/$REPO/issues/$1" \
    --jq '{number,title,body,labels:[.labels[].name],created_at}' 2>/dev/null
}

# A checker-created relocation is deliberately born without `autopilot`. Only
# this worker-side publication gate may make it schedulable, and only after the
# complete checker verdict, child contract and parent backlink are validated.
publish_relocation(){ # $1=child $2=parent $3=checker run id
  local child=$1 parent=$2 run_id=$3 issue comments marker body quarantine=false
  marker="FACTORY-RELOCATE-RUN: $run_id"
  issue=$(issue_json_read "$child") || return 1
  if mf_issue_json_valid "$issue" "$run_id" true forbidden forbidden; then
    quarantine=true
  elif mf_issue_json_valid "$issue" "$run_id" true required forbidden; then
    quarantine=false
  else
    log "relocation publish: child #$child contract changed before publication"
    return 1
  fi
  jq -e --arg needle "Relocated from #$parent by checker triage." \
    '(.body // "") | contains($needle)' <<<"$issue" >/dev/null 2>&1 \
    || { log "relocation publish: child #$child does not link parent #$parent"; return 1; }

  comments=$(mf_pr_comments_json "$parent") || return 1
  if ! jq -e --arg marker "$marker" --arg child "#$child" \
    '[.[] | select((.body // "") | split("\n") | index($marker) != null)
          | select((.body // "") | contains($child))] | length >= 1' \
    <<<"$comments" >/dev/null 2>&1; then
    body="Checker triage relocated follow-up work to #$child.

$marker"
    gh issue comment "$parent" --body "$body" >/dev/null 2>&1 || return 1
    comments=$(mf_pr_comments_json "$parent") || return 1
    jq -e --arg marker "$marker" --arg child "#$child" \
      '[.[] | select((.body // "") | split("\n") | index($marker) != null)
            | select((.body // "") | contains($child))] | length >= 1' \
      <<<"$comments" >/dev/null 2>&1 || return 1
  fi

  if [ "$quarantine" = true ]; then
    gh issue edit "$child" --add-label autopilot >/dev/null 2>&1 || return 1
  fi
  issue=$(issue_json_read "$child") || return 1
  mf_issue_json_valid "$issue" "$run_id" true required forbidden
}

# ---- authoritative PR/comment reads + role postconditions ------------------------
pr_snapshot(){
  local pr=$1 try comments head
  for try in $(seq 1 "$MF_GH_READ_ATTEMPTS"); do
    if comments=$(mf_pr_comments_json "$pr") && head=$(mf_pr_head "$pr") && [ -n "$head" ]; then
      PR_SNAPSHOT_COMMENTS=$comments
      PR_SNAPSHOT_HEAD=$head
      return 0
    fi
    [ "$try" -lt "$MF_GH_READ_ATTEMPTS" ] && sleep "$MF_GH_READ_RETRY_SLEEP"
  done
  return 1
}

run_reviewer(){ # $1=issue $2=pr $3=difficulty
  local n=$1 pr=$2 difficulty=$3 attempt before head after transport prompt
  for attempt in $(seq 1 "$MF_PROTOCOL_ATTEMPTS"); do
    pr_snapshot "$pr" || { log "review protocol: pre-read failed"; continue; }
    before=$PR_SNAPSHOT_COMMENTS; head=$PR_SNAPSHOT_HEAD
    prompt=$(sed \
      -e "s/{{PR}}/$pr/g" -e "s/{{N}}/$n/g" -e "s/{{HEAD}}/$head/g" \
      "$MF_PROMPTS/reviewer.md")
    if mf_cc reviewer "$difficulty" "$(with_pack "$prompt")"; then transport=0; else transport=$?; fi
    pr_snapshot "$pr" || { log "review protocol: post-read failed"; continue; }
    after=$PR_SNAPSHOT_COMMENTS
    if [ "$PR_SNAPSHOT_HEAD" != "$head" ]; then
      log "review protocol: PR head changed during review; discarding comment and reviewing fresh"
    elif mf_new_canonical_comment "$before" "$after" review "$head"; then
      LAST_REVIEW_VERDICT=$MF_COMMENT_MARKER
      LAST_REVIEW_BODY=$MF_COMMENT_BODY
      LAST_REVIEW_COMMENT_ID=$MF_COMMENT_ID
      LAST_REVIEW_HEAD=$head
      return 0
    else
      log "review protocol: no unique new canonical comment"
    fi
    log "review protocol failure (attempt $attempt/$MF_PROTOCOL_ATTEMPTS, transport=$transport)"
    [ "$attempt" -lt "$MF_PROTOCOL_ATTEMPTS" ] && sleep "$MF_PROTOCOL_RETRY_SLEEP"
  done
  return 1
}

run_fixer(){ # $1=issue $2=pr $3=difficulty $4=optional diagnosis prefix
  local n=$1 pr=$2 difficulty=$3 prefix=${4:-} attempt before after transport prompt
  for attempt in $(seq 1 "$MF_PROTOCOL_ATTEMPTS"); do
    before=$(mf_pr_head "$pr") || { log "fixer protocol: pre-head read failed"; continue; }
    prompt="${prefix}${prefix:+

}$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")"
    if mf_cc fixer "$difficulty" "$(with_pack "$prompt")"; then transport=0; else transport=$?; fi
    after=$(mf_pr_head "$pr") || { log "fixer protocol: post-head read failed"; continue; }
    if [ -n "$after" ] && [ "$after" != "$before" ]; then
      LAST_FIXER_HEAD=$after
      return 0
    fi
    log "fixer protocol failure: no new PR head (attempt $attempt/$MF_PROTOCOL_ATTEMPTS, transport=$transport)"
    [ "$attempt" -lt "$MF_PROTOCOL_ATTEMPTS" ] && sleep "$MF_PROTOCOL_RETRY_SLEEP"
  done
  return 1
}

# Initial review, then at most two fixer → fresh-review attempts.  In particular,
# the second fixer is never allowed to fall through to triage unreviewed.
review_fix_cycle(){ # $1=issue $2=pr
  local n=$1 pr=$2 review_diff round
  review_diff=$(post_write_diff "$(diff_at_least "$CYCLE_DIFF" "$(review_floor)")")
  REVIEW_CYCLE_RESULT=protocol
  run_reviewer "$n" "$pr" "$review_diff" || return 1
  if [ "$LAST_REVIEW_VERDICT" = "FACTORY-VERDICT: APPROVE" ]; then
    REVIEW_CYCLE_RESULT=approved
    return 0
  fi
  for round in 1 2; do
    log "fix round $round/2: changes requested"
    wstatus fixing "$n" "$pr"
    run_fixer "$n" "$pr" "$(post_write_diff "$CYCLE_DIFF")" || return 1
    wstatus reviewing "$n" "$pr"
    run_reviewer "$n" "$pr" "$review_diff" || return 1
    if [ "$LAST_REVIEW_VERDICT" = "FACTORY-VERDICT: APPROVE" ]; then
      REVIEW_CYCLE_RESULT=approved
      return 0
    fi
  done
  REVIEW_CYCLE_RESULT=rejected
  return 0
}

checker_materials(){ # $1=issue $2=pr
  local n=$1 pr=$2
  {
    echo "## Issue #$n"
    gh issue view "$n" --json title,body -q '"\(.title)\n\n\(.body)"' 2>/dev/null
    echo; echo "## Final validated review comment"
    printf '%s\n' "${LAST_REVIEW_BODY:-(none)}"
    echo; echo "## PR #$pr diff stat (not the full diff)"
    gh pr diff "$pr" --stat 2>/dev/null | tail -40
    echo; echo "## Changed files"
    gh pr view "$pr" --json files -q '.files[].path' 2>/dev/null
    echo; echo "## Last fixer replies"
    gh pr view "$pr" --json comments -q \
      '[.comments[].body|select(test("FACTORY-VERDICT:")|not)][-2:]|join("\n---\n")' 2>/dev/null
  }
}

run_checker(){ # $1=issue $2=pr $3=optional durable checkpoint file
  local n=$1 pr=$2 checkpoint=${3:-} attempt before_comments before_parent before_issues head
  local after_comments after_parent after_issues run_id manifest transport prompt newnums verdict
  mkdir -p "$MFSTATE/control/checker-manifests"
  for attempt in $(seq 1 "$MF_PROTOCOL_ATTEMPTS"); do
    pr_snapshot "$pr" || { log "checker protocol: pre-PR read failed"; continue; }
    before_comments=$PR_SNAPSHOT_COMMENTS; head=$PR_SNAPSHOT_HEAD
    before_parent=$(mf_pr_comments_json "$n") || { log "checker protocol: parent-comment snapshot failed"; continue; }
    before_issues=$(mf_recent_issues_json) || { log "checker protocol: issue snapshot failed"; continue; }
    run_id="checker-$n-$(date +%s)-$$-$attempt"
    manifest="$MFSTATE/control/checker-manifests/$run_id"
    : >"$manifest"
    prompt=$(sed \
      -e "s/{{N}}/$n/g" -e "s/{{PR}}/$pr/g" -e "s/{{HEAD}}/$head/g" \
      -e "s|{{RUN_ID}}|$run_id|g" -e "s|{{MANIFEST}}|$manifest|g" \
      "$MF_PROMPTS/checker.md")
    prompt="$prompt

$(checker_materials "$n" "$pr")"
    if mf_cc checker "$(role_diff checker)" "$(with_pack "$prompt")"; then transport=0; else transport=$?; fi
    pr_snapshot "$pr" || { log "checker protocol: post-PR read failed; suppressing model retry"; return 1; }
    after_comments=$PR_SNAPSHOT_COMMENTS
    after_parent=$(mf_pr_comments_json "$n") \
      || { log "checker protocol: parent-comment post-read failed; suppressing model retry"; return 1; }
    after_issues=$(mf_recent_issues_json) \
      || { log "checker protocol: issue post-read failed; suppressing model retry"; return 1; }
    newnums=$(mf_new_issue_numbers "$before_issues" "$after_issues" | xargs)

    if [ "$PR_SNAPSHOT_HEAD" != "$head" ]; then
      log "checker protocol: PR head changed during triage"
    elif mf_new_canonical_comment "$before_comments" "$after_comments" triage "$head"; then
      verdict=$MF_COMMENT_MARKER
      if [ "$verdict" = "FACTORY-TRIAGE: RELOCATE" ]; then
        if mf_manifest_validate "$manifest" "$before_issues" "$after_issues" "$run_id" relocated \
          && [ "$MF_MANIFEST_KIND" = issues ] \
          && [ "$(wc -w <<<"$MF_MANIFEST_ISSUES" | tr -d ' ')" = 1 ]; then
          local newnum=$MF_MANIFEST_ISSUES prline new_line_count pr_line_count
          new_line_count=$(grep -cE '^FACTORY-TRIAGE-NEW: #[0-9]+$' <<<"$MF_COMMENT_BODY" || true)
          pr_line_count=$(grep -cE '^FACTORY-TRIAGE-PR: (MERGEABLE|BLOCKED)$' <<<"$MF_COMMENT_BODY" || true)
          prline=$(grep -E '^FACTORY-TRIAGE-PR: (MERGEABLE|BLOCKED)$' <<<"$MF_COMMENT_BODY")
          if [ "$new_line_count" = 1 ] && [ "$pr_line_count" = 1 ] \
            && grep -qx "FACTORY-TRIAGE-NEW: #$newnum" <<<"$MF_COMMENT_BODY" \
            && jq -e --argjson before "$before_parent" '. == $before' \
              <<<"$after_parent" >/dev/null 2>&1 \
            && jq -e --argjson n "$newnum" \
              --arg needle "Relocated from #$n by checker triage." \
              '.[]|select(.number==$n)|(.body // "")|contains($needle)' \
              <<<"$after_issues" >/dev/null 2>&1; then
            LAST_CHECKER_VERDICT=$verdict
            LAST_CHECKER_BODY=$MF_COMMENT_BODY
            LAST_CHECKER_COMMENT_ID=$MF_COMMENT_ID
            LAST_CHECKER_HEAD=$head
            LAST_CHECKER_NEW=$newnum
            LAST_CHECKER_PR_DISPOSITION=${prline##*: }
            LAST_CHECKER_RUN_ID=$run_id
            [ -z "$checkpoint" ] || triage_accept_checkpoint "$checkpoint" "$n" "$pr" || return 1
            return 0
          fi
        fi
        # An invalid relocation may already have created an issue. Do not run a
        # second checker that could duplicate it; safely requeue the parent.
        log "checker protocol: malformed RELOCATE artifacts (new issues: ${newnums:-none})"
        return 1
      fi

      # Non-relocation verdicts must not have created/claimed an issue.
      if [ -s "$manifest" ] || ! jq -e --arg run "$run_id" \
        '[.[]|select((.body // "")|contains("factory-run: \($run)"))]|length==0' \
        <<<"$after_issues" >/dev/null 2>&1; then
        log "checker protocol: non-RELOCATE verdict wrote an issue manifest/artifact"
        return 1
      fi
      if [ "$verdict" = "FACTORY-TRIAGE: NEEDS_HUMAN" ]; then
        local decision_comments
        decision_comments=$(jq --argjson before "$before_parent" --arg marker "FACTORY-DECISION-RUN: $run_id" '
          [.[] | . as $c
           | select(($before | map(.id) | index($c.id)) == null)
           | select((.body // "") | split("\n") | index($marker) != null)] | length
        ' <<<"$after_parent" 2>/dev/null || echo 0)
        [ "$decision_comments" -ge 1 ] || {
          log "checker protocol: NEEDS_HUMAN omitted the issue decision comment"
          continue
        }
      fi
      LAST_CHECKER_VERDICT=$verdict
      LAST_CHECKER_BODY=$MF_COMMENT_BODY
      LAST_CHECKER_COMMENT_ID=$MF_COMMENT_ID
      LAST_CHECKER_HEAD=$head
      LAST_CHECKER_NEW=""
      LAST_CHECKER_PR_DISPOSITION=""
      LAST_CHECKER_RUN_ID=$run_id
      [ -z "$checkpoint" ] || triage_accept_checkpoint "$checkpoint" "$n" "$pr" || return 1
      return 0
    fi
    log "checker protocol failure (attempt $attempt/$MF_PROTOCOL_ATTEMPTS, transport=$transport)"
    # A partial helper-created issue is deliberately left non-schedulable or is
    # captured by its manifest. Never run another checker that might duplicate it.
    if [ -s "$manifest" ] || jq -e --arg run "$run_id" \
      '[.[]|select((.body // "")|contains("factory-run: \($run)"))]|length>0' \
      <<<"$after_issues" >/dev/null 2>&1; then
      log "checker protocol: partial issue artifact present; suppressing corrective retry"
      return 1
    fi
    [ "$attempt" -lt "$MF_PROTOCOL_ATTEMPTS" ] && sleep "$MF_PROTOCOL_RETRY_SLEEP"
  done
  return 1
}

# ---- durable triage — one checker stage, one escalated fixer globally -----------
triage_state_file(){ printf '%s/issue-%s-pr%s.json' "$TRIAGE" "$1" "$2"; }

triage_state_save(){ # $1=file $2=issue $3=pr $4=stage
  local f=$1 n=$2 pr=$3 stage=$4
  mkdir -p "$TRIAGE"
  atomic_write "$f" "$(jq -cn \
    --argjson issue "$n" --argjson pr "$pr" --arg stage "$stage" \
    --arg verdict "${LAST_CHECKER_VERDICT:-}" --arg body "${LAST_CHECKER_BODY:-}" \
    --arg comment_id "${LAST_CHECKER_COMMENT_ID:-}" --arg head "${LAST_CHECKER_HEAD:-}" \
    --arg new_issue "${LAST_CHECKER_NEW:-}" \
    --arg disposition "${LAST_CHECKER_PR_DISPOSITION:-}" \
    --arg run_id "${LAST_CHECKER_RUN_ID:-}" --arg difficulty "${TRIAGE_ESC_DIFF:-}" \
    --arg fixer_base_head "${TRIAGE_FIXER_BASE_HEAD:-}" \
    --arg fixer_head "${TRIAGE_FIXER_HEAD:-}" --arg outcome "${TRIAGE_OUTCOME:-}" \
    --arg at "$(date -Is)" \
    '{issue:$issue,pr:$pr,stage:$stage,
      checker:{verdict:$verdict,body:$body,comment_id:$comment_id,head:$head,
        new_issue:$new_issue,disposition:$disposition,run_id:$run_id},
      escalated:{difficulty:$difficulty,fixer_base_head:$fixer_base_head,fixer_head:$fixer_head},
      outcome:$outcome,updated_at:$at}')"
}

triage_state_load(){ # $1=file
  local f=$1
  TRIAGE_STAGE=$(jq -r '.stage // ""' "$f") || return 1
  LAST_CHECKER_VERDICT=$(jq -r '.checker.verdict // ""' "$f")
  LAST_CHECKER_BODY=$(jq -r '.checker.body // ""' "$f")
  LAST_CHECKER_COMMENT_ID=$(jq -r '.checker.comment_id // ""' "$f")
  LAST_CHECKER_HEAD=$(jq -r '.checker.head // ""' "$f")
  LAST_CHECKER_NEW=$(jq -r '.checker.new_issue // ""' "$f")
  LAST_CHECKER_PR_DISPOSITION=$(jq -r '.checker.disposition // ""' "$f")
  LAST_CHECKER_RUN_ID=$(jq -r '.checker.run_id // ""' "$f")
  TRIAGE_ESC_DIFF=$(jq -r '.escalated.difficulty // ""' "$f")
  TRIAGE_FIXER_BASE_HEAD=$(jq -r '.escalated.fixer_base_head // ""' "$f")
  TRIAGE_FIXER_HEAD=$(jq -r '.escalated.fixer_head // ""' "$f")
  TRIAGE_OUTCOME=$(jq -r '.outcome // ""' "$f")
}

triage_accept_checkpoint(){ # $1=state file $2=issue $3=pr
  local f=$1 n=$2 pr=$3 stage
  case "$LAST_CHECKER_VERDICT" in
    "FACTORY-TRIAGE: RETRY_ESCALATED")
      TRIAGE_ESC_DIFF=$(diff_next "$CYCLE_DIFF")
      stage=escalated-fix-pending;;
    "FACTORY-TRIAGE: RELOCATE") stage=relocate-publish-pending;;
    "FACTORY-TRIAGE: NEEDS_HUMAN") stage=needs-human-pending;;
    *) return 1;;
  esac
  triage_state_save "$f" "$n" "$pr" "$stage"
}

run_escalated_fixer_once(){ # $1=issue $2=pr $3=difficulty $4=known base head $5=diagnosis
  local n=$1 pr=$2 difficulty=$3 before=$4 prefix=$5 after transport prompt
  prompt="${prefix}${prefix:+

}$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")"
  if mf_cc fixer "$difficulty" "$(with_pack "$prompt")"; then transport=0; else transport=$?; fi
  after=$(mf_pr_head "$pr") || {
    log "escalated fixer: post-head read failed (transport=$transport)"
    return 1
  }
  if [ -n "$after" ] && [ "$after" != "$before" ]; then
    LAST_FIXER_HEAD=$after
    return 0
  fi
  log "escalated fixer: one allowed invocation produced no head (transport=$transport)"
  return 1
}

close_pr_idempotent(){ # $1=pr
  local state
  state=$(gh pr view "$1" --json state -q .state 2>/dev/null) || return 1
  case "$state" in
    CLOSED|MERGED) return 0;;
    OPEN) gh pr close "$1" --delete-branch >/dev/null 2>&1 \
      || gh pr close "$1" >/dev/null 2>&1;;
    *) return 1;;
  esac
}

triage(){ # $1=issue $2=pr $3=relocated(true|false); 0=enqueued, 1=human/blocked, 2=protocol
  local n=$1 pr=$2 reloc=$3 sf current esc
  sf=$(triage_state_file "$n" "$pr")
  if [ "$reloc" = true ] && [ ! -f "$sf" ]; then
    mark_human "$n" "relocated issue rejected again — triage chain cap (depth 1)"
    return 1
  fi
  hb_ensure
  wstatus triage "$n" "$pr"

  if [ -f "$sf" ]; then
    triage_state_load "$sf" || return 2
  else
    LAST_CHECKER_VERDICT=""; LAST_CHECKER_BODY=""; LAST_CHECKER_COMMENT_ID=""
    LAST_CHECKER_HEAD=""; LAST_CHECKER_NEW=""; LAST_CHECKER_PR_DISPOSITION=""
    LAST_CHECKER_RUN_ID=""; TRIAGE_ESC_DIFF=""; TRIAGE_FIXER_BASE_HEAD=""
    TRIAGE_FIXER_HEAD=""; TRIAGE_OUTCOME=""
    triage_state_save "$sf" "$n" "$pr" checker-running || return 2
    if ! run_checker "$n" "$pr" "$sf"; then
      TRIAGE_OUTCOME=human
      triage_state_save "$sf" "$n" "$pr" checker-protocol-failed || return 2
      mark_human "$n" "checker artifact contract failed; checker stage is not repeated"
      triage_state_save "$sf" "$n" "$pr" complete || return 2
      return 1
    fi
    triage_state_load "$sf" || return 2
    [ "$TRIAGE_STAGE" != checker-running ] || return 2
  fi

  while :; do
    case "$TRIAGE_STAGE" in
      complete)
        [ "$TRIAGE_OUTCOME" = enqueued ] && return 0
        return 1;;
      checker-running)
        # The process died with a checker in flight. Never issue a second checker:
        # exact recovery of an uncommitted remote side effect is impossible.
        TRIAGE_OUTCOME=human
        mark_human "$n" "checker was interrupted before durable artifact acceptance"
        triage_state_save "$sf" "$n" "$pr" complete || return 2
        return 1;;
      checker-protocol-failed)
        TRIAGE_OUTCOME=human
        mark_human "$n" "checker artifact contract failed; checker stage is not repeated"
        triage_state_save "$sf" "$n" "$pr" complete || return 2
        return 1;;
      escalated-fix-pending)
        esc=$TRIAGE_ESC_DIFF
        [ -n "$esc" ] || return 2
        TRIAGE_FIXER_BASE_HEAD=$(mf_pr_head "$pr") || return 2
        TRIAGE_STAGE=escalated-fix-running
        triage_state_save "$sf" "$n" "$pr" "$TRIAGE_STAGE" || return 2
        log "triage: one escalated fixer at diff:$esc (was diff:$CYCLE_DIFF)"
        wstatus fixing "$n" "$pr"
        if run_escalated_fixer_once "$n" "$pr" "$(post_write_diff "$esc")" \
          "$TRIAGE_FIXER_BASE_HEAD" \
          "TRIAGE DIAGNOSIS BRIEF (address this root cause):
$LAST_CHECKER_BODY"; then
          TRIAGE_FIXER_HEAD=$LAST_FIXER_HEAD
          TRIAGE_STAGE=escalated-review-pending
          triage_state_save "$sf" "$n" "$pr" "$TRIAGE_STAGE" || return 2
          continue
        fi
        current=$(mf_pr_head "$pr") || return 2
        if [ "$current" != "$TRIAGE_FIXER_BASE_HEAD" ]; then
          TRIAGE_FIXER_HEAD=$current
          TRIAGE_STAGE=escalated-review-pending
          triage_state_save "$sf" "$n" "$pr" "$TRIAGE_STAGE" || return 2
          continue
        fi
        TRIAGE_OUTCOME=human
        mark_human "$n" "the one escalated fixer produced no pushed head"
        triage_state_save "$sf" "$n" "$pr" complete || return 2
        return 1;;
      escalated-fix-running)
        current=$(mf_pr_head "$pr") || return 2
        if [ -n "$TRIAGE_FIXER_BASE_HEAD" ] && [ "$current" != "$TRIAGE_FIXER_BASE_HEAD" ]; then
          TRIAGE_FIXER_HEAD=$current
          TRIAGE_STAGE=escalated-review-pending
          triage_state_save "$sf" "$n" "$pr" "$TRIAGE_STAGE" || return 2
          continue
        fi
        TRIAGE_OUTCOME=human
        mark_human "$n" "escalated fixer was interrupted without a pushed head; it is not repeated"
        triage_state_save "$sf" "$n" "$pr" complete || return 2
        return 1;;
      escalated-review-pending)
        wstatus reviewing "$n" "$pr"
        run_reviewer "$n" "$pr" \
          "$(post_write_diff "$(diff_at_least "$TRIAGE_ESC_DIFF" "$(review_floor)")")" \
          || return 2
        if [ "$LAST_REVIEW_VERDICT" = "FACTORY-VERDICT: APPROVE" ]; then
          enqueue_merge "$pr" "$n" "$LAST_REVIEW_HEAD" reviewer "$LAST_REVIEW_COMMENT_ID" \
            || return 2
          TRIAGE_OUTCOME=enqueued
          triage_state_save "$sf" "$n" "$pr" complete || return 2
          return 0
        fi
        TRIAGE_OUTCOME=human
        mark_human "$n" "review not clean after escalated retry (no appeal)"
        triage_state_save "$sf" "$n" "$pr" complete || return 2
        return 1;;
      relocate-publish-pending)
        publish_relocation "$LAST_CHECKER_NEW" "$n" "$LAST_CHECKER_RUN_ID" || return 2
        TRIAGE_STAGE=relocate-action-pending
        triage_state_save "$sf" "$n" "$pr" "$TRIAGE_STAGE" || return 2
        continue;;
      relocate-action-pending)
        if [ "$LAST_CHECKER_PR_DISPOSITION" = MERGEABLE ]; then
          log "triage: RELOCATE, current PR mergeable as-is (follow-up: #$LAST_CHECKER_NEW)"
          enqueue_merge "$pr" "$n" "$LAST_CHECKER_HEAD" checker "$LAST_CHECKER_COMMENT_ID" \
            || return 2
          TRIAGE_OUTCOME=enqueued
          triage_state_save "$sf" "$n" "$pr" complete || return 2
          return 0
        fi
        [ "$LAST_CHECKER_PR_DISPOSITION" = BLOCKED ] || return 2
        log "triage: RELOCATE, PR blocked on #$LAST_CHECKER_NEW"
        add_dep_to_issue "$n" "$LAST_CHECKER_NEW" || return 2
        gh label create "blocked-by:#$LAST_CHECKER_NEW" --color D93F0B >/dev/null 2>&1 || true
        gh issue edit "$n" --add-label "blocked-by:#$LAST_CHECKER_NEW" >/dev/null 2>&1 || return 2
        close_pr_idempotent "$pr" || return 2
        gh issue edit "$n" --remove-label "in-progress,mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
        TRIAGE_OUTCOME=blocked
        triage_state_save "$sf" "$n" "$pr" complete || return 2
        notify "issue #$n blocked by new issue #$LAST_CHECKER_NEW (checker RELOCATE)"
        return 1;;
      needs-human-pending)
        mark_human "$n" "checker triage → needs a human decision"
        TRIAGE_OUTCOME=human
        triage_state_save "$sf" "$n" "$pr" complete || return 2
        return 1;;
      *) return 2;;
    esac
  done
}

# ---- PR discovery ---------------------------------------------------------------
# Writers are asked to use task/N, but the authoritative relationship is the
# issue's closing-link graph.  A uniquely-linked open PR on another branch is
# valid salvage; multiple candidates remain conservative/needs-human.
discover_issue_pr_once(){ # $1=issue; sets DISCOVER_* and returns 0 read / 1 transient
  local n=$1 task linked combined count
  task=$(gh pr list --head "task/$n" --state open \
    --json number,headRefName,state 2>/dev/null) || return 1
  linked=$(gh issue view "$n" --json closedByPullRequestsReferences 2>/dev/null) || return 1
  combined=$(jq -cn --argjson task "$task" --argjson linked "$linked" '
    [ $task[]? | {number,headRefName,state:(.state // "OPEN")} ]
    + [ $linked.closedByPullRequestsReferences[]?
        | select((.state // "") == "OPEN")
        | {number,headRefName,state} ]
    | unique_by(.number)
  ') || return 1
  count=$(jq 'length' <<<"$combined")
  case "$count" in
    0) DISCOVER_STATUS=none; DISCOVER_PR=""; DISCOVER_BRANCH="";;
    1) DISCOVER_STATUS=unique
       DISCOVER_PR=$(jq -r '.[0].number' <<<"$combined")
       DISCOVER_BRANCH=$(jq -r '.[0].headRefName // ""' <<<"$combined");;
    *) DISCOVER_STATUS=ambiguous
       DISCOVER_PR=$(jq -r 'map(.number|tostring)|join(",")' <<<"$combined")
       DISCOVER_BRANCH="";;
  esac
}

discover_issue_pr(){ # $1=issue
  local try
  for try in $(seq 1 "$MF_GH_READ_ATTEMPTS"); do
    discover_issue_pr_once "$1" && return 0
    log "PR discovery failed (attempt $try/$MF_GH_READ_ATTEMPTS)"
    [ "$try" -lt "$MF_GH_READ_ATTEMPTS" ] && sleep "$MF_GH_READ_RETRY_SLEEP"
  done
  DISCOVER_STATUS=transient
  DISCOVER_PR=""
  return 1
}

protocol_requeue(){ # $1=issue $2=reason $3=pr(optional)
  local n=$1 why=$2 pr=${3:-}
  log "issue #$n protocol failure → safe requeue ($why)"
  gh issue edit "$n" --remove-label "in-progress,mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
  wstatus failed "$n" "${pr:-null}"
  return 1
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

  # Requeued/head-invalidated work may already have a valid PR.  Resume it
  # directly instead of asking a writer to recreate it.
  discover_issue_pr "$n" || {
    protocol_requeue "$n" "cannot read linked PRs"
    hb_stop
    return 1
  }
  case "$DISCOVER_STATUS" in
    unique)
      pr=$DISCOVER_PR
      log "resuming linked PR #$pr (${DISCOVER_BRANCH:-unknown branch})";;
    ambiguous)
      mark_human "$n" "multiple open PRs linked to issue ($DISCOVER_PR)"
      gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
      wstatus failed "$n"; hb_stop; return 1;;
    none)
      local writer_transport=1 w_try
      for w_try in $(seq 1 "${WRITER_RETRIES:-2}"); do
        hb_ensure
        if mf_cc writer "$(post_write_diff "$CYCLE_DIFF")" \
          "$(with_pack "$(sed "s/{{N}}/$n/g" "$PROMPTS/writer.md")")"; then
          writer_transport=0
          break
        fi
        log "writer attempt $w_try/${WRITER_RETRIES:-2} transport failed"
        [ "$w_try" -lt "${WRITER_RETRIES:-2}" ] && sleep "${WRITER_RETRY_SLEEP:-60}"
      done

      # Artifact beats transport status: a provider may disconnect after opening
      # a complete PR. Discover before salvage so alternate linked branches are
      # not mistaken for missing task/N output.
      discover_issue_pr "$n" || {
        protocol_requeue "$n" "cannot verify writer PR"
        hb_stop
        return 1
      }
      if [ "$DISCOVER_STATUS" = none ]; then
        salvage_branch "$n"
        discover_issue_pr "$n" || {
          protocol_requeue "$n" "cannot verify salvaged writer output"
          hb_stop
          return 1
        }
      fi
      case "$DISCOVER_STATUS" in
        unique) pr=$DISCOVER_PR;;
        ambiguous)
          mark_human "$n" "writer left multiple linked PRs ($DISCOVER_PR)"
          gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
          wstatus failed "$n"; hb_stop; return 1;;
        none)
          local state labels
          state=$(gh issue view "$n" --json state -q '.state' 2>/dev/null)
          labels=$(gh issue view "$n" --json labels -q '.labels[].name' 2>/dev/null)
          if [ "$state" = CLOSED ] || grep -qx needs-human <<<"$labels"; then
            gh issue edit "$n" --remove-label "in-progress,autopilot,mf:worker-$WORKER_ID" \
              >/dev/null 2>&1 || true
            log "issue #$n self-resolved by writer (no PR needed)"
            issue_cost "$n"; wstatus done "$n"; hb_stop; return 0
          fi
          protocol_requeue "$n" \
            "writer produced no unique linked PR (transport=$writer_transport, salvaged=${SALVAGED:-0})"
          hb_stop
          return 1;;
      esac;;
  esac

  # A protocol requeue/restart with durable triage state resumes the exact
  # checker/escalation stage. It must not replay the ordinary review/fix cycle,
  # checker, or the single escalated fixer.
  local need_triage=0
  if [ -f "$(triage_state_file "$n" "$pr")" ]; then
    log "resuming durable triage state for issue #$n / PR #$pr"
    need_triage=1
  else
    # REVIEW → FIX: initial review, then no more than two fix+fresh-review attempts.
    hb_ensure
    wstatus reviewing "$n" "$pr"
    review_fix_cycle "$n" "$pr" || {
      protocol_requeue "$n" "review/fixer artifact contract failed" "$pr"
      hb_stop
      return 1
    }
    if [ "$REVIEW_CYCLE_RESULT" = approved ]; then
      enqueue_merge "$pr" "$n" "$LAST_REVIEW_HEAD" reviewer "$LAST_REVIEW_COMMENT_ID" || {
        protocol_requeue "$n" "merge-queue write failed" "$pr"
        hb_stop
        return 1
      }
    else
      need_triage=1
    fi
  fi

  if [ "$need_triage" -eq 1 ]; then
    # Escalation ladder instead of unbounded fix rounds.
    triage "$n" "$pr" "$reloc"
    local triage_rc=$?
    if [ "$triage_rc" -eq 2 ]; then
      protocol_requeue "$n" "checker/escalation artifact contract failed" "$pr"
      hb_stop
      return 1
    elif [ "$triage_rc" -ne 0 ]; then
      wstatus failed "$n" "$pr"; hb_stop
      gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
      return 1
    fi
  fi

  # Handed to the merge queue: this worker is done — free for the next issue.
  gh issue edit "$n" --remove-label "mf:worker-$WORKER_ID" >/dev/null 2>&1 || true
  wstatus done "$n" "$pr"; hb_stop; return 0
}

# ---- boot ------------------------------------------------------------------------
if [ "${MF_SOURCE_ONLY:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi
mkdir -p "$ASSIGN" "$STATUS" "$QUEUE" "$LOGS" "$TRIAGE"
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
