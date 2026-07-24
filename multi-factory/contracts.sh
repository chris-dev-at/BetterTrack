#!/usr/bin/env bash
# Provider-neutral artifact contracts for the BetterTrack multi-factory.
#
# This file is intentionally side-effect free when sourced.  The composer helper,
# master, worker and offline tests all use the same validators so a model's prose
# is never treated as proof that it completed a role.

MF_DIFF_ORDER="easy normal intermediate hard max"

mf_meta_block(){
  awk '
    /^[[:space:]]*<!--[[:space:]]*mf-meta[[:space:]]*$/ { in_meta=1; next }
    in_meta && /^[[:space:]]*-->[[:space:]]*$/ { exit }
    in_meta { print }
  '
}

mf_meta_deps(){
  mf_meta_block | grep -i '^[[:space:]]*depends-on:' | head -1 \
    | sed 's/^[^:]*://; s/[^0-9 ]/ /g' | xargs -n1 2>/dev/null | sort -un | xargs || true
}

mf_meta_touches(){
  mf_meta_block | grep -i '^[[:space:]]*touches:' \
    | sed 's/^[^:]*:[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' || true
}

# Validate one and only one terminal mf-meta block.  Unknown fields are rejected:
# orchestration may only act on metadata whose meaning it understands.
mf_meta_valid(){ # $1=required factory-run token, or empty
  local required_run=${1:-}
  awk -v required_run="$required_run" '
    function trim(s) {
      sub(/^[[:space:]]+/, "", s)
      sub(/[[:space:]]+$/, "", s)
      return s
    }
    {
      line=$0
      sub(/\r$/, "", line)
      if (line !~ /^[[:space:]]*$/) last_nonblank=NR

      if (line ~ /^[[:space:]]*<!--[[:space:]]*mf-meta[[:space:]]*$/) {
        opens++
        if (inside) bad=1
        inside=1
        next
      }
      if (inside && line ~ /^[[:space:]]*-->[[:space:]]*$/) {
        closes++
        inside=0
        close_line=NR
        next
      }
      if (!inside) next

      value=line
      if (value ~ /^[[:space:]]*$/) next
      if (value ~ /^[[:space:]]*depends-on:[[:space:]]*/) {
        deps++
        sub(/^[[:space:]]*depends-on:[[:space:]]*/, "", value)
        value=trim(value)
        if (value !~ /^[0-9]+([[:space:]]*,[[:space:]]*[0-9]+)*$/) bad=1
        next
      }
      if (value ~ /^[[:space:]]*touches:[[:space:]]*/) {
        touches++
        sub(/^[[:space:]]*touches:[[:space:]]*/, "", value)
        value=trim(value)
        if (value == "" || value ~ /[[:space:]]/) bad=1
        next
      }
      if (value ~ /^[[:space:]]*factory-run:[[:space:]]*/) {
        runs++
        sub(/^[[:space:]]*factory-run:[[:space:]]*/, "", value)
        run_value=trim(value)
        if (run_value !~ /^[A-Za-z0-9._-]+$/) bad=1
        next
      }
      bad=1
    }
    END {
      if (inside || opens != 1 || closes != 1 || close_line != last_nonblank) bad=1
      if (touches < 1 || deps > 1 || runs > 1) bad=1
      if (required_run != "" && (runs != 1 || run_value != required_run)) bad=1
      exit bad ? 1 : 0
    }
  '
}

mf_issue_body_valid(){ # $1=body $2=required factory-run token, or empty
  local body=$1 required_run=${2:-}
  local context scope acceptance outscope
  context=$(grep -n -m1 '^## Context[[:space:]]*$' <<<"$body" | cut -d: -f1)
  scope=$(grep -n -m1 '^## Scope[[:space:]]*$' <<<"$body" | cut -d: -f1)
  acceptance=$(grep -n -m1 '^## Acceptance criteria[[:space:]]*$' <<<"$body" | cut -d: -f1)
  outscope=$(grep -n -m1 '^## Out of scope[[:space:]]*$' <<<"$body" | cut -d: -f1)
  [ -n "$context" ] && [ -n "$scope" ] && [ -n "$acceptance" ] && [ -n "$outscope" ] \
    && [ "$context" -lt "$scope" ] && [ "$scope" -lt "$acceptance" ] \
    && [ "$acceptance" -lt "$outscope" ] \
    && mf_meta_valid "$required_run" <<<"$body"
}

mf_issue_json_valid(){ # $1=json $2=run $3=relocated $4=autopilot(required|forbidden) $5=awaiting(required|forbidden)
  local issue=$1 required_run=${2:-} relocated=${3:-false}
  local autopilot=${4:-required} awaiting=${5:-forbidden}
  jq -e '
    (.number | type == "number")
    and (.body | type == "string")
    and ([.labels[]? | if type=="object" then .name else . end] as $l
         | ($l | map(select(test("^diff:(easy|normal|intermediate|hard|max)$"))) | length) == 1)
  ' <<<"$issue" >/dev/null 2>&1 || return 1
  local auto_count awaiting_count relocated_count
  auto_count=$(jq '[.labels[]? | if type=="object" then .name else . end] | map(select(.=="autopilot")) | length' <<<"$issue")
  awaiting_count=$(jq '[.labels[]? | if type=="object" then .name else . end] | map(select(.=="awaiting-owner")) | length' <<<"$issue")
  relocated_count=$(jq '[.labels[]? | if type=="object" then .name else . end] | map(select(.=="mf:relocated")) | length' <<<"$issue")
  case "$autopilot" in required) [ "$auto_count" = 1 ];; forbidden) [ "$auto_count" = 0 ];; *) return 1;; esac || return 1
  case "$awaiting" in required) [ "$awaiting_count" = 1 ];; forbidden) [ "$awaiting_count" = 0 ];; *) return 1;; esac || return 1
  if [ "$relocated" = true ]; then [ "$relocated_count" = 1 ]; else [ "$relocated_count" = 0 ]; fi || return 1
  mf_issue_body_valid "$(jq -r '.body' <<<"$issue")" "$required_run"
}

mf_manifest_validate(){ # $1=manifest $2=before JSON $3=after JSON $4=run $5=expected mode(optional)
  local manifest=$1 before=$2 after=$3 run=$4 expected_mode=${5:-}
  MF_MANIFEST_KIND=invalid
  MF_MANIFEST_ISSUES=""
  MF_MANIFEST_MODES=""
  [ -s "$manifest" ] || return 1

  local lines new_ids
  lines=$(sed '/^[[:space:]]*$/d' "$manifest")
  new_ids=$(mf_new_issue_numbers "$before" "$after")
  if [ "$lines" = NONE ]; then
    [ -z "$new_ids" ] || return 1
    MF_MANIFEST_KIND=none
    return 0
  fi
  grep -Eqv '^ISSUE [0-9]+ (autopilot|awaiting-owner|relocated)$' <<<"$lines" && return 1

  local ids n mode issue
  ids=$(awk '/^ISSUE /{print $2}' <<<"$lines")
  [ -n "$ids" ] || return 1
  [ "$(wc -l <<<"$ids" | tr -d ' ')" = "$(sort -un <<<"$ids" | wc -l | tr -d ' ')" ] || return 1
  [ "$(sort -un <<<"$ids")" = "$(sort -un <<<"$new_ids")" ] || return 1

  while read -r _ n mode; do
    [ -z "$expected_mode" ] || [ "$mode" = "$expected_mode" ] || return 1
    jq -e --argjson n "$n" '[.[].number] | index($n) == null' <<<"$before" >/dev/null 2>&1 \
      || return 1
    issue=$(jq -c --argjson n "$n" '.[] | select(.number==$n)' <<<"$after")
    [ -n "$issue" ] || return 1
    case "$mode" in
      autopilot) mf_issue_json_valid "$issue" "$run" false required forbidden || return 1;;
      awaiting-owner) mf_issue_json_valid "$issue" "$run" false forbidden required || return 1;;
      relocated) mf_issue_json_valid "$issue" "$run" true forbidden forbidden || return 1;;
    esac
  done <<<"$lines"

  MF_MANIFEST_KIND=issues
  MF_MANIFEST_ISSUES=$(sort -un <<<"$ids" | xargs)
  MF_MANIFEST_MODES=$(awk '{print $3}' <<<"$lines" | sort -u | xargs)
  return 0
}

mf_comment_marker_valid(){ # $1=review|triage $2=expected head SHA $3=body
  local kind=$1 head=$2 body=$3 prefix marker_re head_prefix
  case "$kind" in
    review)
      prefix='FACTORY-VERDICT:'
      marker_re='^FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)$'
      head_prefix='FACTORY-REVIEW-HEAD:';;
    triage)
      prefix='FACTORY-TRIAGE:'
      marker_re='^FACTORY-TRIAGE: (RETRY_ESCALATED|RELOCATE|NEEDS_HUMAN)$'
      head_prefix='FACTORY-TRIAGE-HEAD:';;
    *) return 1;;
  esac

  local occurrences marker_count last head_count
  occurrences=$(grep -o "$prefix" <<<"$body" | wc -l | tr -d ' ')
  marker_count=$(grep -cE "$marker_re" <<<"$body" || true)
  last=$(awk 'NF { line=$0; sub(/\r$/, "", line); last=line } END { print last }' <<<"$body")
  head_count=$(grep -cE "^${head_prefix} ${head}\$" <<<"$body" || true)
  [ "$occurrences" = 1 ] && [ "$marker_count" = 1 ] \
    && grep -qE "$marker_re" <<<"$last" && [ "$head_count" = 1 ]
}

# Select exactly one newly-added comment that satisfies the canonical contract.
# Results are returned in MF_COMMENT_ID / MF_COMMENT_BODY / MF_COMMENT_MARKER.
mf_new_canonical_comment(){ # $1=before comments JSON $2=after JSON $3=kind $4=head
  local before=$1 after=$2 kind=$3 head=$4 obj body count=0
  MF_COMMENT_ID=""; MF_COMMENT_BODY=""; MF_COMMENT_MARKER=""
  while IFS= read -r obj; do
    [ -n "$obj" ] || continue
    body=$(jq -r '.body // ""' <<<"$obj")
    if mf_comment_marker_valid "$kind" "$head" "$body"; then
      count=$((count+1))
      MF_COMMENT_ID=$(jq -r '.id' <<<"$obj")
      MF_COMMENT_BODY=$body
    fi
  done < <(jq -c --argjson before "$before" '
    .[] | . as $c
    | select(($before | map(.id) | index($c.id)) == null)
  ' <<<"$after" 2>/dev/null)
  [ "$count" -eq 1 ] || return 1
  MF_COMMENT_MARKER=$(awk 'NF { line=$0; sub(/\r$/, "", line); last=line } END { print last }' \
    <<<"$MF_COMMENT_BODY")
}

mf_comment_by_id_valid(){ # $1=comments JSON $2=id $3=kind $4=head
  local comments=$1 id=$2 kind=$3 head=$4 body
  body=$(jq -r --arg id "$id" '.[] | select((.id|tostring)==$id) | .body' <<<"$comments")
  [ -n "$body" ] && mf_comment_marker_valid "$kind" "$head" "$body"
}

mf_latest_decision_for_head(){ # $1=comments JSON $2=head; sets MF_DECISION_*
  local comments=$1 head=$2 obj id body last
  MF_DECISION_ID=""; MF_DECISION_KIND=""; MF_DECISION_APPROVED=false
  while IFS= read -r obj; do
    id=$(jq -r '.id' <<<"$obj")
    body=$(jq -r '.body // ""' <<<"$obj")
    last=$(awk 'NF{line=$0; sub(/\r$/, "", line); last=line} END{print last}' <<<"$body")
    if mf_comment_marker_valid review "$head" "$body"; then
      MF_DECISION_ID=$id
      MF_DECISION_KIND=reviewer
      [ "$last" = "FACTORY-VERDICT: APPROVE" ] && MF_DECISION_APPROVED=true
      return 0
    fi
    if mf_comment_marker_valid triage "$head" "$body"; then
      MF_DECISION_ID=$id
      MF_DECISION_KIND=checker
      if [ "$last" = "FACTORY-TRIAGE: RELOCATE" ] \
        && [ "$(grep -c '^FACTORY-TRIAGE-PR: MERGEABLE$' <<<"$body" || true)" = 1 ]; then
        MF_DECISION_APPROVED=true
      fi
      return 0
    fi
  done < <(jq -c 'reverse[]' <<<"$comments" 2>/dev/null)
  return 1
}

mf_approval_comment_valid(){ # $1=comments $2=id $3=reviewer|checker $4=head
  local comments=$1 id=$2 kind=$3 head=$4
  mf_latest_decision_for_head "$comments" "$head" || return 1
  [ "$MF_DECISION_APPROVED" = true ] \
    && [ "$MF_DECISION_KIND" = "$kind" ] \
    && [ "$MF_DECISION_ID" = "$id" ]
}

mf_latest_approval_for_head(){ # $1=comments JSON $2=head; sets MF_APPROVAL_*
  MF_APPROVAL_ID=""; MF_APPROVAL_KIND=""
  mf_latest_decision_for_head "$1" "$2" || return 1
  [ "$MF_DECISION_APPROVED" = true ] || return 1
  MF_APPROVAL_ID=$MF_DECISION_ID
  MF_APPROVAL_KIND=$MF_DECISION_KIND
}

mf_pr_comments_json(){ # $1=PR number
  local out
  out=$(gh api --paginate "repos/$REPO/issues/$1/comments?per_page=100" \
    --jq '.[] | {id,body,created_at}' 2>/dev/null) || return 1
  jq -cs '.' <<<"$out"
}

mf_pr_head(){ gh pr view "$1" --json headRefOid -q .headRefOid 2>/dev/null; }

mf_recent_issues_json(){
  gh api -H 'Cache-Control: no-cache' \
    "repos/$REPO/issues?state=all&sort=created&direction=desc&per_page=100" \
    --jq '[.[] | select(.pull_request==null) | {number,title,body,labels:[.labels[].name],created_at}]' \
    2>/dev/null
}

mf_issue_json_by_number(){ # $1=issue number; direct reads avoid list eventual consistency
  gh api -H 'Cache-Control: no-cache' "repos/$REPO/issues/$1" \
    --jq 'select(.pull_request==null)
      | {number,title,body,labels:[.labels[].name],created_at}' \
    2>/dev/null
}

mf_new_issue_numbers(){ # $1=before JSON $2=after JSON
  jq -r --argjson before "$1" '
    .[] | .number as $n | select(($before | map(.number) | index($n)) == null) | .number
  ' <<<"$2" 2>/dev/null | sort -un
}
