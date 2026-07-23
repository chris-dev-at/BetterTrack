#!/usr/bin/env bash
# Offline regression tests for provider transport and role artifact contracts.
set -uo pipefail
cd "$(dirname "$0")"

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }
check(){
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi
}
expect_ok(){ if "$2"; then ok "$1"; else bad "$1"; fi; }
expect_fail(){ if "$2"; then bad "$1"; else ok "$1"; fi; }

export MFSTATE=$T/state STATE=$T/cstate REPO_DIR=$T/repo LOG=$T/provider.log
export REPO=stub/repo WORKERS=1 MF_DRY_RUN=0
mkdir -p "$MFSTATE/control" "$MFSTATE/assignments" "$MFSTATE/status" \
  "$MFSTATE/merge-queue" "$MFSTATE/logs" "$MFSTATE/ci-fix" "$MFSTATE/triage" \
  "$REPO_DIR" "$T/bin"

# Host macOS does not ship GNU timeout. This test shim preserves the child rc,
# including 124, which is exactly what the provider wrapper must observe.
cat >"$T/bin/timeout" <<'STUB'
#!/usr/bin/env bash
shift
exec "$@"
STUB
cat >"$T/bin/codex" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >"$CODEX_ARGS_FILE"
case "$CODEX_CASE" in
  ok)
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":9,"cached_input_tokens":2,"output_tokens":3}}'
    exit 0;;
  cachewrite)
    printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":20,"cache_write_input_tokens":10,"output_tokens":5,"reasoning_output_tokens":2}}'
    exit 0;;
  nonzero)
    printf '%s\n' '{"type":"turn.started"}'
    exit 7;;
  timeout)
    exit 124;;
  errorjson)
    printf '%s\n' '{"type":"error","message":"provider rejected request"}'
    printf '%s\n' '{"type":"turn.completed","usage":{}}'
    exit 0;;
esac
STUB
cat >"$T/bin/agy" <<'STUB'
#!/usr/bin/env bash
case "$AGY_CASE" in
  ok) echo ok; exit 0;;
  nonzero) echo "agy failed"; exit 9;;
esac
STUB
chmod +x "$T/bin/timeout" "$T/bin/codex" "$T/bin/agy"
export PATH=$T/bin:$PATH CODEX_ARGS_FILE=$T/codex.args

log(){ :; }; notify(){ :; }
ledger_record(){ LAST_LEDGER_RES=$4; LAST_LEDGER_OUTCOME=$6; }
cc_classify(){ echo genuine; }
export MF_PROVIDER_ATTEMPTS=1 MF_PROVIDER_RETRY_SLEEP=0 CC_TRANSIENT_MAX=0
export MF_ROLE_TIMEOUT=5 LIMIT_SLEEP=0
. ./mflib.sh

echo "— provider rc + Codex JSONL completion"
CODEX_CASE=ok; export CODEX_CASE
cc_codex gpt-5.6-sol low prompt; check "Codex rc=0 + turn.completed succeeds" 0 "$?"
check "Codex success ledger outcome" ok "$LAST_LEDGER_OUTCOME"
grep -q -- '--ephemeral' "$CODEX_ARGS_FILE" \
  && ok "Codex invocation is ephemeral" || bad "Codex invocation should use --ephemeral"
check "Codex telemetry tags provider" codex "$(jq -r .provider <<<"$LAST_LEDGER_RES")"
check "Codex telemetry carries usage schema marker" 2 \
  "$(jq -r .codex_usage_schema <<<"$LAST_LEDGER_RES")"
check "Codex telemetry marks output as reasoning-inclusive" inclusive-reasoning \
  "$(jq -r .output_tokens_semantics <<<"$LAST_LEDGER_RES")"
check "Codex ledger input is uncached/exclusive" 7 \
  "$(jq -r .usage.input_tokens <<<"$LAST_LEDGER_RES")"
check "Codex ledger retains cached input" 2 \
  "$(jq -r .usage.cache_read_input_tokens <<<"$LAST_LEDGER_RES")"
check "Codex API-equivalent estimate uses Sol standard rates" 0.000126 \
  "$(jq -r .api_equivalent_usd <<<"$LAST_LEDGER_RES")"

CODEX_CASE=cachewrite; export CODEX_CASE
cc_codex gpt-5.6-sol low prompt
CACHEWRITE_LEDGER_RES=$LAST_LEDGER_RES
check "Codex raw inclusive input subtracts cached + cache-write once" 70 \
  "$(jq -r .usage.input_tokens <<<"$LAST_LEDGER_RES")"
check "Codex cache-write telemetry is retained" 10 \
  "$(jq -r .usage.cache_creation_input_tokens <<<"$LAST_LEDGER_RES")"
check "Codex inclusive output is not increased by reasoning subset" 5 \
  "$(jq -r .usage.output_tokens <<<"$LAST_LEDGER_RES")"
check "Codex reasoning output is retained as diagnostic telemetry" 2 \
  "$(jq -r .usage.reasoning_output_tokens <<<"$LAST_LEDGER_RES")"
check "Codex API estimate bills inclusive output once and cache-write at 1.25x input" 0.000573 \
  "$(jq -r .api_equivalent_usd <<<"$LAST_LEDGER_RES")"

CODEX_CASE=ok; export CODEX_CASE
cc_codex gpt-future low prompt
check "unknown Codex model has no guessed estimate" null \
  "$(jq -r .api_equivalent_usd <<<"$LAST_LEDGER_RES")"
check "unknown Codex model records unavailable coverage" unknown-model \
  "$(jq -r .api_equivalent_coverage <<<"$LAST_LEDGER_RES")"

CODEX_CASE=ok; export CODEX_CASE
cc_codex gpt-5.6-sol low prompt
rm -f "$T/future-ledger.jsonl"
CODEX_LEDGER_RES=$LAST_LEDGER_RES LEDGER=$T/future-ledger.jsonl FACTORY_NAME=multi WORKER_ID=9 \
  bash -c '. ../factory/lib.sh; ledger_record 9 writer gpt-5.6-sol "$CODEX_LEDGER_RES" 4 ok'
FUTURE_ROW=$(<"$T/future-ledger.jsonl")
check "future ledger keeps subscription spend at zero" 0 "$(jq -r .cost_usd <<<"$FUTURE_ROW")"
check "future ledger writes provider separately" codex "$(jq -r .provider <<<"$FUTURE_ROW")"
check "future ledger persists usage schema marker" 2 \
  "$(jq -r .codex_usage_schema <<<"$FUTURE_ROW")"
check "future ledger persists inclusive-output semantics" inclusive-reasoning \
  "$(jq -r .output_tokens_semantics <<<"$FUTURE_ROW")"
check "future ledger writes API-equivalent estimate separately" 0.000126 \
  "$(jq -r .api_equivalent_usd <<<"$FUTURE_ROW")"
check "future ledger exposes cached input alias" 2 \
  "$(jq -r .cached_input_tokens <<<"$FUTURE_ROW")"

rm -f "$T/reasoning-ledger.jsonl"
CODEX_LEDGER_RES=$CACHEWRITE_LEDGER_RES LEDGER=$T/reasoning-ledger.jsonl FACTORY_NAME=multi \
  bash -c '. ../factory/lib.sh; ledger_record 10 reviewer gpt-5.6-sol "$CODEX_LEDGER_RES" 4 ok'
REASONING_ROW=$(<"$T/reasoning-ledger.jsonl")
check "future ledger output remains inclusive (no reasoning double count)" 5 \
  "$(jq -r .output_tokens <<<"$REASONING_ROW")"
check "future ledger preserves reasoning subset separately" 2 \
  "$(jq -r .reasoning_output_tokens <<<"$REASONING_ROW")"
check "future ledger estimate bills inclusive output once" 0.000573 \
  "$(jq -r .api_equivalent_usd <<<"$REASONING_ROW")"

CODEX_CASE=nonzero; export CODEX_CASE
cc_codex gpt-5.6-sol low prompt; check "Codex nonzero rc fails" 1 "$?"
check "Codex nonzero ledger outcome" fail "$LAST_LEDGER_OUTCOME"

CODEX_CASE=timeout; export CODEX_CASE
cc_codex gpt-5.6-sol low prompt; check "Codex rc=124 is a timeout failure" 1 "$?"

CODEX_CASE=errorjson; export CODEX_CASE
cc_codex gpt-5.6-sol low prompt; check "Codex error JSONL overrides rc=0/completed" 1 "$?"
check "Codex error JSONL ledger outcome" fail "$LAST_LEDGER_OUTCOME"

rm -f "$T/incomplete-ledger.jsonl"
CODEX_LEDGER_RES=$LAST_LEDGER_RES LEDGER=$T/incomplete-ledger.jsonl FACTORY_NAME=multi \
  bash -c '. ../factory/lib.sh; ledger_record 11 checker gpt-5.6-sol "$CODEX_LEDGER_RES" 4 fail'
INCOMPLETE_ROW=$(<"$T/incomplete-ledger.jsonl")
check "failed Codex ledger preserves explicit incomplete telemetry" false \
  "$(jq -r .codex_telemetry_complete <<<"$INCOMPLETE_ROW")"
check "failed Codex ledger estimate remains unavailable" null \
  "$(jq -r .api_equivalent_usd <<<"$INCOMPLETE_ROW")"
INCOMPLETE_ANALYTICS=$(
  INCOMPLETE_LEDGER_FILE=$T/incomplete-ledger.jsonl node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { aggregateCodexUsage } from "./control/usage-analytics.mjs";
    const row = JSON.parse(readFileSync(process.env.INCOMPLETE_LEDGER_FILE, "utf8"));
    const data = aggregateCodexUsage([row], {
      now: "2026-07-24T12:00:00Z",
      range: "all",
    });
    process.stdout.write(JSON.stringify(data.totals));
  '
)
check "actual failed ledger row is not counted as priced" 0 \
  "$(jq -r .pricedRecords <<<"$INCOMPLETE_ANALYTICS")"
check "actual failed ledger row is not laundered to a zero estimate" null \
  "$(jq -r .estimatedUsd <<<"$INCOMPLETE_ANALYTICS")"
check "actual failed ledger row reports unavailable coverage" unavailable \
  "$(jq -r .coverage <<<"$INCOMPLETE_ANALYTICS")"

AGY_CASE=ok; export AGY_CASE
cc_gemini gemini-test prompt; check "Gemini rc=0 succeeds" 0 "$?"
AGY_CASE=nonzero; export AGY_CASE
cc_gemini gemini-test prompt; check "Gemini nonzero rc is preserved" 1 "$?"

echo "— composer issue contracts"
RUN=run-1
VALID_BODY='## Context
quoted spec

## Scope
files

## Acceptance criteria
- [ ] works

## Out of scope
extras

<!-- mf-meta
factory-run: run-1
touches: apps/api/**
-->'
issue_json(){
  jq -cn --arg body "$1" --argjson labels "$2" \
    '{number:101,title:"x",body:$body,labels:$labels,created_at:"now"}'
}
VALID=$(issue_json "$VALID_BODY" '["autopilot","diff:hard"]')
BARE=$(issue_json "$VALID_BODY" '[]')
MULTI=$(issue_json "$VALID_BODY" '["autopilot","diff:easy","diff:hard"]')
BAD_META=$(issue_json "${VALID_BODY%-->*}depends-on: nope
-->" '["autopilot","diff:hard"]')
mf_issue_json_valid "$VALID" "$RUN" false \
  && ok "valid composer issue accepted" || bad "valid composer issue rejected"
mf_issue_json_valid "$BARE" "$RUN" false \
  && bad "bare issue must fail" || ok "bare issue rejected"
mf_issue_json_valid "$MULTI" "$RUN" false \
  && bad "multi-diff issue must fail" || ok "multi-diff issue rejected"
mf_issue_json_valid "$BAD_META" "$RUN" false \
  && bad "bad mf-meta must fail" || ok "bad terminal mf-meta rejected"

printf 'ISSUE 101 autopilot\n' >"$T/manifest"
mf_manifest_validate "$T/manifest" '[]' "[$VALID]" "$RUN" autopilot \
  && ok "new valid manifest issue accepted" || bad "new valid manifest issue rejected"
mf_manifest_validate "$T/manifest" "[$VALID]" "[$VALID]" "$RUN" autopilot \
  && bad "pre-existing issue must not be claimable" || ok "pre-existing manifest issue rejected"
printf 'NONE\n' >"$T/none-manifest"
mf_manifest_validate "$T/none-manifest" '[]' "[$BARE]" "$RUN" "" \
  && bad "NONE must reject an unmanifested bare issue" || ok "NONE rejects a bare #704/#705-style artifact"
EXTRA_BARE=$(jq '.number=102' <<<"$BARE")
mf_manifest_validate "$T/manifest" '[]' "[$VALID,$EXTRA_BARE]" "$RUN" autopilot \
  && bad "manifest must reject an extra unclaimed issue" || ok "manifest covers every pre/post new issue"
AWAITING=$(issue_json "$VALID_BODY" '["awaiting-owner","diff:hard"]' | jq '.number=103')
printf 'ISSUE 103 awaiting-owner\n' >"$T/awaiting-manifest"
mf_manifest_validate "$T/awaiting-manifest" '[]' "[$AWAITING]" "$RUN" awaiting-owner \
  && ok "guarded awaiting-owner issue accepted" || bad "valid awaiting-owner issue rejected"

echo "— fresh canonical reviewer/checker comments"
REVIEW_OK='review
FACTORY-REVIEW-HEAD: abc
FACTORY-VERDICT: APPROVE'
REVIEW_NONFINAL='FACTORY-REVIEW-HEAD: abc
FACTORY-VERDICT: APPROVE
trailing prose'
before='[{"id":1,"body":"old\nFACTORY-REVIEW-HEAD: abc\nFACTORY-VERDICT: APPROVE"}]'
after_stale=$before
after_ok=$(jq -cn --arg body "$REVIEW_OK" '[{id:2,body:$body}]')
after_multi=$(jq -cn --arg body "$REVIEW_OK" '[{id:2,body:$body},{id:3,body:$body}]')
after_nonfinal=$(jq -cn --arg body "$REVIEW_NONFINAL" '[{id:2,body:$body}]')
mf_new_canonical_comment "$before" "$after_stale" review abc \
  && bad "stale comment must fail" || ok "stale reviewer comment rejected"
mf_new_canonical_comment '[]' "$after_multi" review abc \
  && bad "multiple canonical comments must fail" || ok "multiple reviewer comments rejected"
mf_new_canonical_comment '[]' "$after_nonfinal" review abc \
  && bad "non-final marker must fail" || ok "non-final reviewer marker rejected"
mf_new_canonical_comment '[]' "$after_ok" review abc \
  && ok "one fresh final reviewer marker accepted" || bad "valid reviewer marker rejected"

TRIAGE_MULTI='FACTORY-TRIAGE-HEAD: abc
FACTORY-TRIAGE: RETRY_ESCALATED
FACTORY-TRIAGE: NEEDS_HUMAN'
mf_comment_marker_valid triage abc "$TRIAGE_MULTI" \
  && bad "multiple triage markers must fail" || ok "multiple triage markers rejected"

# Source orchestration functions without booting loops or loading live auth.
log(){ :; }; notify(){ :; }; mark_human(){ :; }; issue_cost(){ :; }
export MF_SOURCE_ONLY=1 TICK_ISSUES=$T/issues.json TICK_DEPS=$T/deps
mkdir -p "$T/deps"
. ./master.sh

printf '%s\n' "[
  $(issue_json "$VALID_BODY" '["autopilot","diff:hard"]'),
  {\"number\":102,\"title\":\"unsafe\",\"body\":\"plain\",\"labels\":[\"autopilot\"]},
  $AWAITING
]" >"$TICK_ISSUES"
check "scheduler never infers difficulty for bare autopilot issue" "101" "$(runnable_issues | xargs)"
grep -q -- '--mode awaiting-owner' prompts/composer.md \
  && ok "composer prompt uses guarded awaiting-owner mode" || bad "composer prompt missing awaiting-owner mode"

echo "— composer protocol backoff cadence"
MF_PROMPTS=$(pwd)/prompts
MF_COMPOSER_COOLDOWN=0
MF_COMPOSER_PROTOCOL_COOLDOWN=120
MF_COMPOSER_PROTOCOL_BACKOFF_MAX=900
MF_COMPOSER_PROTOCOL_ATTEMPTS=2
rm -f "$MFSTATE/control"/.composer-{last,backoff,snapshot,protocol-last,protocol-backoff}
echo '[]' >"$TICK_ISSUES"
COMPOSER_CALLS=0
runnable_issues(){ :; }
mf_recent_issues_json(){ echo '[]'; }
mf_cc(){ COMPOSER_CALLS=$((COMPOSER_CALLS+1)); return 0; }
role_diff(){ echo hard; }
with_pack(){ printf '%s' "$1"; }
fetch_issues(){ :; }
composer_step run
check "one malformed composer run uses only its designed attempts" 2 "$COMPOSER_CALLS"
check "composer protocol failure records separate cooldown" 120 \
  "$(cat "$MFSTATE/control/.composer-protocol-backoff")"
composer_step run
check "next 15-second-style tick does not call composer again" 2 "$COMPOSER_CALLS"
backdate_protocol(){
  local ts=$(( $(date +%s) - $2 ))
  touch -d "@$ts" "$1" 2>/dev/null || touch -t "$(date -r "$ts" +%Y%m%d%H%M.%S)" "$1"
}
backdate_protocol "$MFSTATE/control/.composer-protocol-last" 121
composer_step run
check "composer retries only after protocol cooldown" 4 "$COMPOSER_CALLS"
check "repeated protocol failure backs off independently" 240 \
  "$(cat "$MFSTATE/control/.composer-protocol-backoff")"

echo "— queue approval head/comment binding"
QUEUE_FILE=$MFSTATE/merge-queue/1-pr10.json
printf '%s\n' '{"pr":10,"issue":9,"touches":[],"approved_head":"abc","approval_kind":"reviewer","approval_comment_id":"2"}' >"$QUEUE_FILE"
mf_pr_comments_json(){ printf '%s\n' "$after_ok"; }
mf_pr_head(){ printf '%s\n' "${TEST_HEAD:-abc}"; }
TEST_HEAD=abc queue_approval_check "$QUEUE_FILE"
check "matching head + canonical approval valid" valid "$QUEUE_APPROVAL_STATE"
new_request='new finding
FACTORY-REVIEW-HEAD: abc
FACTORY-VERDICT: REQUEST_CHANGES'
comments_with_request=$(jq -cn --arg approve "$REVIEW_OK" --arg request "$new_request" \
  '[{id:2,body:$approve},{id:3,body:$request}]')
mf_pr_comments_json(){ printf '%s\n' "$comments_with_request"; }
TEST_HEAD=abc queue_approval_check "$QUEUE_FILE"
check "newer request-changes invalidates older approval" invalid "$QUEUE_APPROVAL_STATE"
mf_pr_comments_json(){ printf '%s\n' "$after_ok"; }
TEST_HEAD=def queue_approval_check "$QUEUE_FILE"
check "changed head invalidates approval" changed "$QUEUE_APPROVAL_STATE"
mf_pr_head(){ return 1; }
queue_approval_check "$QUEUE_FILE"
check "approval head read failure is transient" 1 "$?"

echo "— fix loop always reviews the second fixer"
export WORKER_ID=9
. ./worker.sh
review_floor(){ echo intermediate; }
CYCLE_DIFF=easy
wstatus(){ :; }
RCOUNT=0; FCOUNT=0
run_reviewer(){
  RCOUNT=$((RCOUNT+1))
  LAST_REVIEW_VERDICT="FACTORY-VERDICT: REQUEST_CHANGES"
  LAST_REVIEW_HEAD=h$RCOUNT
  LAST_REVIEW_COMMENT_ID=$RCOUNT
  return 0
}
run_fixer(){ FCOUNT=$((FCOUNT+1)); return 0; }
review_fix_cycle 9 10
check "initial + two post-fix reviews executed" 3 "$RCOUNT"
check "at most two fixers executed" 2 "$FCOUNT"
check "two valid rejections reach triage" rejected "$REVIEW_CYCLE_RESULT"

RCOUNT=0; FCOUNT=0
run_reviewer(){
  RCOUNT=$((RCOUNT+1))
  if [ "$RCOUNT" -eq 3 ]; then LAST_REVIEW_VERDICT="FACTORY-VERDICT: APPROVE"
  else LAST_REVIEW_VERDICT="FACTORY-VERDICT: REQUEST_CHANGES"; fi
  LAST_REVIEW_HEAD=h$RCOUNT
  LAST_REVIEW_COMMENT_ID=$RCOUNT
  return 0
}
review_fix_cycle 9 10
check "second fixer receives a fresh approving review" 3 "$RCOUNT"
check "approval after second fixer accepted" approved "$REVIEW_CYCLE_RESULT"

echo "— linked alternate PR discovery"
ALT_MODE=one
gh(){
  case "$1 $2" in
    "pr list") echo '[]';;
    "issue view")
      if [ "$ALT_MODE" = one ]; then
        echo '{"closedByPullRequestsReferences":[{"number":77,"headRefName":"cod/provider-fix","state":"OPEN"}]}'
      else
        echo '{"closedByPullRequestsReferences":[{"number":77,"headRefName":"a","state":"OPEN"},{"number":78,"headRefName":"b","state":"OPEN"}]}'
      fi;;
    *) :;;
  esac
}
discover_issue_pr_once 9
check "unique linked alternate branch is salvaged" unique "$DISCOVER_STATUS"
check "alternate linked PR number discovered" 77 "$DISCOVER_PR"
ALT_MODE=two discover_issue_pr_once 9
check "multiple linked PRs stay conservative" ambiguous "$DISCOVER_STATUS"

echo "— quarantined relocation helper + worker publication"
mkdir -p "$T/helper-bin"
cat >"$T/helper-bin/gh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$HELPER_CALLS"
if [ "$1 $2" = "issue create" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --body-file) cp "$2" "$HELPER_CREATED_BODY"; shift 2;;
      *) shift;;
    esac
  done
  echo "https://github.test/stub/repo/issues/501"
  exit 0
fi
exit 0
STUB
chmod +x "$T/helper-bin/gh"
sed '/^[[:space:]]*factory-run:/d' <<<"$VALID_BODY" >"$T/helper-body.md"
: >"$T/helper-calls"
HELPER_CALLS=$T/helper-calls HELPER_CREATED_BODY=$T/helper-created.md \
  PATH="$T/helper-bin:$PATH" ./create-issue.sh \
  --run-id helper-run --manifest "$T/helper-manifest" --mode relocated \
  --difficulty hard --title "relocated child" --body-file "$T/helper-body.md" \
  --relocated-from 9 >/dev/null
check "relocation helper records quarantined manifest mode" "ISSUE 501 relocated" \
  "$(<"$T/helper-manifest")"
grep -q -- '--label diff:hard --label mf:relocated' "$T/helper-calls" \
  && ok "relocation helper creates diff + relocated labels" || bad "relocation helper labels malformed"
grep -q -- '--label autopilot' "$T/helper-calls" \
  && bad "relocation helper must not publish autopilot" || ok "relocation child starts without autopilot"
grep -qE '^issue (edit|comment)' "$T/helper-calls" \
  && bad "relocation helper must not mutate child/parent after create" || ok "helper does not mutate parent/backlinks"

: >"$T/awaiting-helper-calls"
HELPER_CALLS=$T/awaiting-helper-calls HELPER_CREATED_BODY=$T/awaiting-created.md \
  PATH="$T/helper-bin:$PATH" ./create-issue.sh \
  --run-id awaiting-run --manifest "$T/awaiting-helper-manifest" --mode awaiting-owner \
  --difficulty hard --title "owner decision" --body-file "$T/helper-body.md" >/dev/null
check "helper records explicit awaiting-owner manifest mode" "ISSUE 501 awaiting-owner" \
  "$(<"$T/awaiting-helper-manifest")"
grep -q -- '--label diff:hard --label awaiting-owner' "$T/awaiting-helper-calls" \
  && ok "awaiting-owner helper applies validated non-runnable labels" \
  || bad "awaiting-owner helper labels malformed"
grep -qE '^issue edit|--label autopilot' "$T/awaiting-helper-calls" \
  && bad "awaiting-owner helper must never publish autopilot" \
  || ok "awaiting-owner helper stays unschedulable"

PUB_AUTO=0; PUB_PARENT=0; PUB_SEQUENCE=""
issue_json_read(){
  local labels='["diff:hard","mf:relocated"]'
  [ "$PUB_AUTO" -eq 0 ] || labels='["diff:hard","mf:relocated","autopilot"]'
  jq -cn --arg body "$(<"$T/helper-created.md")" --argjson labels "$labels" \
    '{number:501,title:"relocated child",body:$body,labels:$labels,created_at:"now"}'
}
mf_pr_comments_json(){
  if [ "$PUB_PARENT" -eq 1 ]; then
    jq -cn '[{id:44,body:"Checker triage relocated follow-up work to #501.\n\nFACTORY-RELOCATE-RUN: helper-run"}]'
  else
    echo '[]'
  fi
}
gh(){
  case "$1 $2 $3" in
    "issue comment 9") PUB_PARENT=1; PUB_SEQUENCE="${PUB_SEQUENCE}P";;
    "issue edit 501") PUB_AUTO=1; PUB_SEQUENCE="${PUB_SEQUENCE}A";;
    *) return 1;;
  esac
}
publish_relocation 501 9 helper-run \
  && ok "worker publishes a fully validated relocation" || bad "worker rejected valid relocation"
check "parent backlink is committed before autopilot publication" PA "$PUB_SEQUENCE"
mf_issue_json_valid "$(issue_json_read 501)" helper-run true required forbidden >/dev/null 2>&1
check "published relocation has validated autopilot contract" 0 "$?"

echo "— malformed relocation never mutates parent/PR"
RELOC_BAD=$(issue_json "$VALID_BODY" '["autopilot","diff:hard"]')
printf 'ISSUE 101 relocated\n' >"$T/reloc-manifest"
mf_manifest_validate "$T/reloc-manifest" '[]' "[$RELOC_BAD]" "$RUN" relocated \
  && bad "relocation without mf:relocated must fail" || ok "malformed relocation rejected"
MUTATIONS=0
gh(){ MUTATIONS=$((MUTATIONS+1)); return 0; }
hb_ensure(){ :; }; wstatus(){ :; }; run_checker(){ return 1; }
rm -rf "$MFSTATE/triage"; mkdir -p "$MFSTATE/triage"
triage 9 10 false
check "checker protocol failure routes terminally without replay" 1 "$?"
check "malformed checker artifacts cause no GitHub mutation" 0 "$MUTATIONS"

echo "— durable checker/escalated stage resume"
rm -rf "$MFSTATE/triage"; mkdir -p "$MFSTATE/triage"
CHECKER_CALLS=0; ESC_FIXER_CALLS=0; ESC_REVIEW_CALLS=0; ESC_ENQUEUES=0
run_checker(){ CHECKER_CALLS=$((CHECKER_CALLS+1)); return 1; }
run_escalated_fixer_once(){
  ESC_FIXER_CALLS=$((ESC_FIXER_CALLS+1))
  LAST_FIXER_HEAD=def
  return 0
}
run_reviewer(){
  ESC_REVIEW_CALLS=$((ESC_REVIEW_CALLS+1))
  if [ "$ESC_REVIEW_CALLS" -eq 1 ]; then return 1; fi
  LAST_REVIEW_VERDICT="FACTORY-VERDICT: APPROVE"
  LAST_REVIEW_HEAD=def
  LAST_REVIEW_COMMENT_ID=77
  return 0
}
enqueue_merge(){ ESC_ENQUEUES=$((ESC_ENQUEUES+1)); return 0; }
mf_pr_head(){ echo abc; }
review_floor(){ echo intermediate; }
mark_human(){ :; }
CYCLE_DIFF=easy
LAST_CHECKER_VERDICT="FACTORY-TRIAGE: RETRY_ESCALATED"
LAST_CHECKER_BODY="root cause"
LAST_CHECKER_COMMENT_ID=51
LAST_CHECKER_HEAD=abc
LAST_CHECKER_NEW=""
LAST_CHECKER_PR_DISPOSITION=""
LAST_CHECKER_RUN_ID=checker-run
TRIAGE_ESC_DIFF=normal
TRIAGE_FIXER_BASE_HEAD=""
TRIAGE_FIXER_HEAD=""
TRIAGE_OUTCOME=""
TRIAGE_FILE=$(triage_state_file 9 10)
triage_state_save "$TRIAGE_FILE" 9 10 escalated-fix-pending
triage 9 10 false
check "review protocol failure leaves exact escalated-review stage" 2 "$?"
triage 9 10 false
check "reassignment resumes and eventually enqueues" 0 "$?"
check "accepted checker is never replayed" 0 "$CHECKER_CALLS"
check "one escalated fixer globally across reassignments" 1 "$ESC_FIXER_CALLS"
check "only fresh reviewer stage is retried" 2 "$ESC_REVIEW_CALLS"
check "resumed approval enqueues once" 1 "$ESC_ENQUEUES"

CHECKER_CALLS=0; ESC_FIXER_CALLS=0; ESC_REVIEW_CALLS=0; ESC_ENQUEUES=0
LAST_CHECKER_VERDICT="FACTORY-TRIAGE: RETRY_ESCALATED"
LAST_CHECKER_BODY="root cause"
LAST_CHECKER_COMMENT_ID=61
LAST_CHECKER_HEAD=abc
LAST_CHECKER_RUN_ID=checker-run-2
TRIAGE_ESC_DIFF=normal
TRIAGE_FIXER_BASE_HEAD=abc
TRIAGE_FIXER_HEAD=""
TRIAGE_OUTCOME=""
TRIAGE_FILE=$(triage_state_file 10 20)
triage_state_save "$TRIAGE_FILE" 10 20 escalated-fix-running
mf_pr_head(){ echo def; }
run_reviewer(){
  ESC_REVIEW_CALLS=$((ESC_REVIEW_CALLS+1))
  LAST_REVIEW_VERDICT="FACTORY-VERDICT: APPROVE"
  LAST_REVIEW_HEAD=def
  LAST_REVIEW_COMMENT_ID=88
  return 0
}
triage 10 20 false
check "restart reconciles fixer push then reviews" 0 "$?"
check "running fixer state never invokes a second fixer" 0 "$ESC_FIXER_CALLS"
check "running fixer state never invokes checker" 0 "$CHECKER_CALLS"
check "reconciled fixer head receives one review" 1 "$ESC_REVIEW_CALLS"

CHECKER_CALLS=0; RELOC_PUBLISH_CALLS=0; ESC_ENQUEUES=0
LAST_CHECKER_VERDICT="FACTORY-TRIAGE: RELOCATE"
LAST_CHECKER_BODY="scope"
LAST_CHECKER_COMMENT_ID=71
LAST_CHECKER_HEAD=abc
LAST_CHECKER_NEW=501
LAST_CHECKER_PR_DISPOSITION=MERGEABLE
LAST_CHECKER_RUN_ID=checker-reloc
TRIAGE_ESC_DIFF=""
TRIAGE_FIXER_BASE_HEAD=""
TRIAGE_FIXER_HEAD=""
TRIAGE_OUTCOME=""
TRIAGE_FILE=$(triage_state_file 11 21)
triage_state_save "$TRIAGE_FILE" 11 21 relocate-publish-pending
publish_relocation(){
  RELOC_PUBLISH_CALLS=$((RELOC_PUBLISH_CALLS+1))
  [ "$RELOC_PUBLISH_CALLS" -gt 1 ]
}
triage 11 21 false
check "publication failure safely requeues exact relocation stage" 2 "$?"
triage 11 21 false
check "relocation publication resumes without checker replay" 0 "$?"
check "relocation retry never invokes checker" 0 "$CHECKER_CALLS"
check "relocation publication retried idempotently" 2 "$RELOC_PUBLISH_CALLS"

echo "— queue write acknowledgement + CI-fix approval invalidation"
# Restore production worker helpers after the stage-resume stubs above.
. ./worker.sh
AF=$MFSTATE/assignments/worker-9.json
printf '%s\n' '{"issue":9,"touches":[]}' >"$AF"
rm -f "$MFSTATE/merge-queue"/*
atomic_write(){ return 1; }
enqueue_merge 10 9 abc reviewer 2
check "failed atomic queue write is reported" 1 "$?"

# Restore a queue and drive the merger with deterministic stubs. A CI-fix push
# must dequeue/requeue for review and must never call merge on the stale approval.
atomic_write(){
  local tmp
  tmp=$(mktemp "$(dirname "$1")/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" >"$tmp" && mv -f "$tmp" "$1"
}
rm -f "$MFSTATE/merge-queue"/* "$MFSTATE/ci-fix"/*
printf '%s\n' '{"pr":10,"issue":9,"touches":[],"approved_head":"abc","approval_kind":"reviewer","approval_comment_id":"2"}' >"$MFSTATE/merge-queue/2-pr10.json"
MERGES=0; CIFIX_CALLS=0; HUMANS=0; PR10_HEAD=abc; PR13_HEAD=abc
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in state) echo OPEN;; statusCheckRollup) echo FAILURE;; esac
    return 0
  fi
  [ "$1 $2" = "pr merge" ] && { MERGES=$((MERGES+1)); return 0; }
  return 0
}
queue_approval_check(){ QUEUE_APPROVAL_STATE=valid; return 0; }
mf_cc(){
  CIFIX_CALLS=$((CIFIX_CALLS+1))
  [ "${CC_ISSUE:-}" = 9 ] && PR10_HEAD=def
  return 0
}
mf_pr_head(){
  case "$1" in 10) echo "$PR10_HEAD";; 13) echo "$PR13_HEAD";; *) echo abc;; esac
}
issue_difficulty(){ echo easy; }
mstatus(){ :; }
mark_human(){ HUMANS=$((HUMANS+1)); }
merger_step
check "CI-fix push removes stale approval queue item" 0 "$(find "$MFSTATE/merge-queue" -name '*-pr10.json' | wc -l | tr -d ' ')"
check "CI-fix push is not merged without fresh review" 0 "$MERGES"
check "pushed CI-fix consumes exactly one real attempt" 1 "$CIFIX_CALLS"
check "pushed CI-fix state survives dequeue" true \
  "$(jq -r .valid_fix_used "$MFSTATE/ci-fix/issue-9-pr10.json")"

# Fresh approval of that pushed head does not reset the global CI-fix budget.
printf '%s\n' '{"pr":10,"issue":9,"touches":[],"approved_head":"def","approval_kind":"reviewer","approval_comment_id":"3"}' >"$MFSTATE/merge-queue/3-pr10.json"
merger_step
check "still-red fresh review is routed human without another fixer" 1 "$HUMANS"
check "valid CI-fix cap remains one across fresh review" 1 "$CIFIX_CALLS"
check "still-red PR leaves merge queue terminally" 0 \
  "$(find "$MFSTATE/merge-queue" -name '*-pr10.json' | wc -l | tr -d ' ')"

# A no-head provider artifact gets one delayed protocol retry, not one call per
# merger tick. The second no-head result exhausts the state durably.
CIFIX_CALLS=0; HUMANS=0
printf '%s\n' '{"pr":12,"issue":12,"touches":[],"approved_head":"abc","approval_kind":"reviewer","approval_comment_id":"4"}' >"$MFSTATE/merge-queue/4-pr12.json"
merger_step
check "first no-head CI-fix invokes provider once" 1 "$CIFIX_CALLS"
check "first no-head CI-fix keeps queue while delayed" 1 \
  "$(find "$MFSTATE/merge-queue" -name '*-pr12.json' | wc -l | tr -d ' ')"
merger_step
check "immediate next merger tick does not call provider" 1 "$CIFIX_CALLS"
CI12_STATE=$MFSTATE/ci-fix/issue-12-pr12.json
jq '.next_at=0' "$CI12_STATE" >"$CI12_STATE.tmp" && mv "$CI12_STATE.tmp" "$CI12_STATE"
merger_step
check "one designed no-head protocol retry is invoked" 2 "$CIFIX_CALLS"
check "two no-head invocations exhaust to human" 1 "$HUMANS"
check "no-head exhaustion removes queue item" 0 \
  "$(find "$MFSTATE/merge-queue" -name '*-pr12.json' | wc -l | tr -d ' ')"
check "no-head exhaustion is durable" exhausted "$(jq -r .status "$CI12_STATE")"
merger_step
check "exhausted CI-fix never receives a third invocation" 2 "$CIFIX_CALLS"

# A late push during the no-head backoff is reconciled as the one real fix and
# cannot earn another fixer after its fresh review.
CIFIX_CALLS=0; HUMANS=0; PR13_HEAD=abc
printf '%s\n' '{"pr":13,"issue":13,"touches":[],"approved_head":"abc","approval_kind":"reviewer","approval_comment_id":"5"}' >"$MFSTATE/merge-queue/5-pr13.json"
merger_step
check "late-push scenario begins with one no-head invocation" 1 "$CIFIX_CALLS"
rm -f "$MFSTATE/merge-queue/5-pr13.json"
PR13_HEAD=def
printf '%s\n' '{"pr":13,"issue":13,"touches":[],"approved_head":"def","approval_kind":"reviewer","approval_comment_id":"6"}' >"$MFSTATE/merge-queue/6-pr13.json"
merger_step
check "late push consumes valid-fix cap before protocol retry" 1 "$CIFIX_CALLS"
check "late pushed head still red after review routes human" 1 "$HUMANS"

printf '%s\n' '{"pr":11,"issue":9,"touches":[],"approved_head":"abc","approval_kind":"reviewer","approval_comment_id":"2"}' >"$MFSTATE/merge-queue/3-pr11.json"
gh(){
  case "$1 $2 $3 $4" in "pr view 11 --json") echo OPEN;; *) :;; esac
}
queue_approval_check(){ return 1; }
merger_step
check "transient approval read retains queue item" 1 "$(find "$MFSTATE/merge-queue" -name '*-pr11.json' | wc -l | tr -d ' ')"

echo
echo "protocol passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
