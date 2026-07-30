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
check "Codex telemetry tags OpenAI family" openai \
  "$(jq -r .provider_family <<<"$LAST_LEDGER_RES")"
check "Codex telemetry tags native harness" codex-cli \
  "$(jq -r .harness <<<"$LAST_LEDGER_RES")"
check "Codex telemetry tags subscription billing" subscription \
  "$(jq -r .billing <<<"$LAST_LEDGER_RES")"
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
check "future ledger persists OpenAI family" openai "$(jq -r .provider_family <<<"$FUTURE_ROW")"
check "future ledger persists native Codex harness" codex-cli "$(jq -r .harness <<<"$FUTURE_ROW")"
check "future ledger persists subscription billing" subscription "$(jq -r .billing <<<"$FUTURE_ROW")"
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

# depends-on arity: the pre-fix regex only accepted a two-number list under mawk,
# so single-dep and 3+-dep issues were silently unschedulable forever (the whole
# V5-P13 chain deadlocked behind #725). Every arity is asserted here, and the
# check must hold under whichever awk the host provides.
dep_issue(){ issue_json "${VALID_BODY%-->*}depends-on: $1
-->" '["autopilot","diff:hard"]'; }
for DEPS in "724" "724,725" "724, 725" "728,729,730" "723, 726, 730" "1, 2, 3, 4"; do
  mf_issue_json_valid "$(dep_issue "$DEPS")" "$RUN" false \
    && ok "depends-on accepted: $DEPS" || bad "depends-on rejected: $DEPS"
done
for DEPS in "nope" "" "724,,725" "724," ",724" "724 725" "-1" "724,abc"; do
  mf_issue_json_valid "$(dep_issue "$DEPS")" "$RUN" false \
    && bad "malformed depends-on must fail: '$DEPS'" || ok "malformed depends-on rejected: '$DEPS'"
done

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

# Real PR threads can contain formatter/test logs larger than the OS process
# argument limit. The selector must compare only compact IDs, never pass the
# complete baseline JSON to jq as an argv value.
arg_max=$(getconf ARG_MAX 2>/dev/null || printf '262144')
large_payload=$(LC_ALL=C head -c "$((arg_max + 4096))" /dev/zero | tr '\0' x)
large_before='[{"id":1,"body":"'"$large_payload"'"}]'
review_obj=$(jq -cn --arg body "$REVIEW_OK" '{id:2,body:$body}')
large_after="${large_before%]},$review_obj]"
mf_new_canonical_comment "$large_before" "$large_after" review abc \
  && ok "large PR history does not hide a fresh reviewer marker" \
  || bad "large PR history exceeded the reviewer selector argument limit"
unset arg_max large_payload large_before review_obj large_after

echo "— prior canonical review detection (reviewer1 vs completion routing)"
mf_has_canonical_review '[]' \
  && bad "empty thread must have no prior review" || ok "empty thread → no prior review"
# A dedicated fixture with a commit-SHA-shaped head: the body-declared head is
# untrusted and only plain hex shapes are accepted (see mf_has_canonical_review).
CANON_REVIEW='[{"id":8,"body":"review body\nFACTORY-REVIEW-HEAD: abc1234\nFACTORY-VERDICT: APPROVE"}]'
mf_has_canonical_review "$CANON_REVIEW" \
  && ok "canonical verdict counts as a prior review" \
  || bad "canonical verdict should count as a prior review"
NONHEX_HEAD='[{"id":9,"body":"r\nFACTORY-REVIEW-HEAD: .*\nFACTORY-VERDICT: APPROVE"}]'
mf_has_canonical_review "$NONHEX_HEAD" \
  && bad "regex-shaped head must never self-validate" \
  || ok "regex-shaped head is rejected"
unset CANON_REVIEW NONHEX_HEAD
OLDHEAD_REVIEW='[{"id":9,"body":"r\nFACTORY-REVIEW-HEAD: 0123abc\nFACTORY-VERDICT: REQUEST_CHANGES"}]'
mf_has_canonical_review "$OLDHEAD_REVIEW" \
  && ok "verdict for an older head still counts as a prior review" \
  || bad "older-head verdict should count as a prior review"
QUOTED_MARKER='[{"id":3,"body":"writer log: a FACTORY-VERDICT: APPROVE will be needed later"}]'
mf_has_canonical_review "$QUOTED_MARKER" \
  && bad "quoted marker prose must not count as a prior review" \
  || ok "quoted marker prose is not a prior review"
NONFINAL_REVIEW=$(jq -cn --arg body "$REVIEW_NONFINAL" '[{id:4,body:$body}]')
mf_has_canonical_review "$NONFINAL_REVIEW" \
  && bad "non-final marker must not count as a prior review" \
  || ok "non-final marker is not a prior review"
unset OLDHEAD_REVIEW QUOTED_MARKER NONFINAL_REVIEW

TRIAGE_MULTI='FACTORY-TRIAGE-HEAD: abc
FACTORY-TRIAGE: RETRY_ESCALATED
FACTORY-TRIAGE: NEEDS_HUMAN'
mf_comment_marker_valid triage abc "$TRIAGE_MULTI" \
  && bad "multiple triage markers must fail" || ok "multiple triage markers rejected"

# Source orchestration functions without booting loops or loading live auth.
log(){ :; }; notify(){ :; }; mark_human(){ :; }; issue_cost(){ :; }
export MF_SOURCE_ONLY=1 TICK_ISSUES=$T/issues.json TICK_DEPS=$T/deps
export MF_COMPOSER_DISCOVERY_ATTEMPTS=4 MF_COMPOSER_DISCOVERY_SLEEP=0
mkdir -p "$T/deps"
. ./master.sh

echo "— composer canonical manifest reconstruction"
printf 'NONE\n' >"$T/repair-manifest"
composer_manifest_validate_or_repair "$T/repair-manifest" '[]' "[$VALID]" "$RUN" "" 1 0 \
  && ok "canonical exact-count artifact repairs a damaged manifest" \
  || bad "canonical exact-count artifact should repair its manifest"
check "repaired manifest records the canonical issue" "ISSUE 101 autopilot" \
  "$(<"$T/repair-manifest")"

printf 'garbled\n' >"$T/repair-mixed-manifest"
composer_manifest_validate_or_repair "$T/repair-mixed-manifest" '[]' "[$VALID,$AWAITING]" \
  "$RUN" "" 2 0 \
  && ok "repair derives guarded modes from canonical labels" \
  || bad "repair should derive canonical artifact modes"
check "repair emits the complete exact artifact set" "ISSUE 101 autopilot
ISSUE 103 awaiting-owner" "$(<"$T/repair-mixed-manifest")"

printf 'keep-invalid\n' >"$T/repair-reject"
composer_manifest_validate_or_repair "$T/repair-reject" '[]' "[$VALID]" "$RUN" "" 2 0 \
  && bad "repair must reject an exact-count mismatch" \
  || ok "repair rejects an exact-count mismatch"
check "failed repair never overwrites the original manifest" keep-invalid "$(<"$T/repair-reject")"
composer_manifest_validate_or_repair "$T/repair-reject" '[]' "[$VALID]" "$RUN" "" 1 1 \
  && bad "repair must not launder an earlier-attempt artifact" \
  || ok "repair rejects a run with prior invalid artifacts"
composer_manifest_validate_or_repair "$T/repair-reject" '[]' "[$VALID,$EXTRA_BARE]" \
  "$RUN" "" 0 0 \
  && bad "repair must reject an extra noncanonical issue" \
  || ok "repair rejects an extra noncanonical issue"

printf '%s\n' "[
  $(issue_json "$VALID_BODY" '["autopilot","diff:hard"]'),
  {\"number\":102,\"title\":\"unsafe\",\"body\":\"plain\",\"labels\":[\"autopilot\"]},
  $AWAITING
]" >"$TICK_ISSUES"
check "scheduler never infers difficulty for bare autopilot issue" "101" "$(runnable_issues | xargs)"
grep -q -- '--mode awaiting-owner' prompts/composer.md \
  && ok "composer prompt uses guarded awaiting-owner mode" || bad "composer prompt missing awaiting-owner mode"
grep -q -- 'P0–P10' prompts/composer.md \
  && bad "composer prompt must not hard-code the legacy P0–P10 range" \
  || ok "composer prompt has no stale P0–P10 range"
grep -qi -- 'check v1' prompts/composer.md \
  && bad "composer prompt must not hard-code the legacy check-v1 gate" \
  || ok "composer prompt has no stale check-v1 gate"
grep -Fq -- 'explicit **current milestone** declaration' prompts/composer.md \
  && ok "composer prompt selects the milestone from the knowledge pack" \
  || bad "composer prompt must select the current milestone from the pack"
grep -q -- 'Derive the gate title from that current' prompts/composer.md \
  && ok "composer prompt derives the milestone gate dynamically" \
  || bad "composer prompt must derive the current milestone gate"
grep -q -- 'OWNER-APPROVED COMPOSITION BRIEF' prompts/composer.md \
  && ok "composer prompt defines the one-shot owner brief contract" \
  || bad "composer prompt missing owner brief contract"

echo "— composer post-create discovery tolerates a stale issue collection"
printf 'ISSUE 101 autopilot\n' >"$T/stale-list-manifest"
mf_recent_issues_json(){ printf '[]\n'; }
mf_issue_json_by_number(){
  [ "$1" = 101 ] && printf '%s\n' "$VALID"
}
DISCOVERED=$(composer_discovery_after "$T/stale-list-manifest")
check "direct issue read fills a helper manifest ID missing from the list" 101 \
  "$(jq -r '.[].number' <<<"$DISCOVERED")"
mf_manifest_validate "$T/stale-list-manifest" '[]' "$DISCOVERED" "$RUN" autopilot \
  && ok "stale-list manifest validates after direct reconciliation" \
  || bad "stale-list manifest should validate after direct reconciliation"
DISCOVERY_CALLS_FILE=$T/discovery.calls
printf '0\n' >"$DISCOVERY_CALLS_FILE"
mf_recent_issues_json(){
  local calls
  calls=$(<"$DISCOVERY_CALLS_FILE")
  calls=$((calls+1))
  printf '%s\n' "$calls" >"$DISCOVERY_CALLS_FILE"
  if [ "$calls" -lt "$MF_COMPOSER_DISCOVERY_ATTEMPTS" ]; then
    printf '[]\n'
  else
    printf '[%s]\n' "$EXTRA_BARE"
  fi
}
DISCOVERED_DELAYED_EXTRA=$(composer_discovery_after "$T/stale-list-manifest")
check "a final-snapshot artifact is retained beside the directly reconciled ID" "101 102" \
  "$(jq -r 'sort_by(.number) | map(.number) | join(" ")' <<<"$DISCOVERED_DELAYED_EXTRA")"
mf_manifest_validate "$T/stale-list-manifest" '[]' \
  "$DISCOVERED_DELAYED_EXTRA" "$RUN" autopilot \
  && bad "direct reconciliation must not hide a delayed unmanifested issue" \
  || ok "full discovery window rejects a delayed unmanifested issue"

echo "— composer discovery and manifest validation exceed Linux argv limits"
LARGE_BEFORE_FILE=$T/large-before.json
jq -n '
  [range(1; 101) as $n | {
    number: $n,
    title: ("existing-" + ($n | tostring)),
    body: ("x" * 12000),
    labels: ["autopilot", "diff:normal"],
    created_at: "before"
  }]
' >"$LARGE_BEFORE_FILE"
LARGE_BEFORE_BYTES=$(wc -c <"$LARGE_BEFORE_FILE" | tr -d ' ')
if [ "$LARGE_BEFORE_BYTES" -gt 1048576 ]; then
  ok "large issue snapshot fixture exceeds 1 MiB"
else
  bad "large issue snapshot fixture must exceed 1 MiB (got $LARGE_BEFORE_BYTES bytes)"
fi
LARGE_BEFORE=$(<"$LARGE_BEFORE_FILE")
LARGE_DIRECT=$(jq '.number=1201 | .title="direct-only"' <<<"$VALID")
printf 'ISSUE 1201 autopilot\n' >"$T/large-manifest"
mf_recent_issues_json(){ cat "$LARGE_BEFORE_FILE"; }
mf_issue_json_by_number(){
  [ "$1" = 1201 ] && printf '%s\n' "$LARGE_DIRECT"
}
LARGE_DISCOVERED=$(composer_discovery_after "$T/large-manifest")
check "large collection merge keeps every existing issue plus the direct ID" 101 \
  "$(jq 'length' <<<"$LARGE_DISCOVERED")"
check "large direct-manifest reconciliation retains its issue" 1201 \
  "$(jq -r 'map(select(.number == 1201)) | .[0].number' <<<"$LARGE_DISCOVERED")"
LARGE_NEW_IDS=$(mf_new_issue_numbers "$LARGE_BEFORE" "$LARGE_DISCOVERED")
check "large before/after comparison returns only the direct issue" 1201 \
  "$(xargs <<<"$LARGE_NEW_IDS")"
if mf_new_issue_numbers '{"not":"an array"}' "$LARGE_DISCOVERED" >/dev/null; then
  bad "issue comparison must reject a non-array snapshot"
else
  ok "issue comparison rejects a non-array snapshot"
fi
mf_manifest_validate "$T/large-manifest" "$LARGE_BEFORE" \
  "$LARGE_DISCOVERED" "$RUN" autopilot \
  && ok "large snapshot manifest validates without snapshot-sized argv" \
  || bad "large snapshot manifest should validate"

echo "— failed composer discovery persistently fences scheduling and reconciles"
rm -rf "$CONTROL/composer-discovery-fence" "$CONTROL/composer-manifests"
rm -f "$CONTROL"/.composer-{last,backoff,snapshot,protocol-last,protocol-backoff} \
  "$CONTROL/composer-quarantine" "$ASSIGN/worker-1.json"
mkdir -p "$CONTROL/composer-manifests"
printf 'run\n' >"$CONTROL/mode"
printf '[]\n' >"$TICK_ISSUES"
MF_PROMPTS=$(pwd)/prompts
MF_COMPOSER_COOLDOWN=0
MF_COMPOSER_PROTOCOL_ATTEMPTS=1
DISCOVERY_BROKEN=1
FENCE_MODEL_CALLS_FILE=$T/fence-model.calls
FENCE_SCHEDULER_CALLS_FILE=$T/fence-scheduler.calls
FENCE_ISSUE_FILE=$T/fence-issue.json
FENCE_NOTIFICATIONS=$T/fence-notifications
printf '0\n' >"$FENCE_MODEL_CALLS_FILE"
printf '0\n' >"$FENCE_SCHEDULER_CALLS_FILE"
: >"$FENCE_NOTIFICATIONS"
runnable_issues(){ printf '686\n'; }
mf_recent_issues_json(){
  if [ -d "$CONTROL/composer-discovery-fence" ] \
    && [ "$DISCOVERY_BROKEN" -eq 1 ]; then
    return 1
  fi
  printf '[]\n'
}
mf_issue_json_by_number(){
  [ "$1" = 901 ] && cat "$FENCE_ISSUE_FILE"
}
mf_cc(){
  local calls run manifest body
  calls=$(<"$FENCE_MODEL_CALLS_FILE")
  printf '%s\n' "$((calls + 1))" >"$FENCE_MODEL_CALLS_FILE"
  run=$(sed -n 's/^This invocation is `\([^`]*\)`. Issue creation.*/\1/p' \
    <<<"$3" | head -1)
  manifest=$(awk '
    index($0, "/work/mf/create-issue.sh --run-id ") {
      for (i=1; i<=NF; i++) if ($i == "--manifest") { print $(i+1); exit }
    }
  ' <<<"$3")
  body=$(printf '## Context\nquoted spec\n\n## Scope\nfiles\n\n## Acceptance criteria\n- [ ] works\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: apps/api/src/fenced.ts\n-->' "$run")
  jq -cn --arg body "$body" \
    '{number:901,title:"fenced",body:$body,
      labels:["autopilot","diff:normal"],created_at:"now"}' >"$FENCE_ISSUE_FILE"
  printf 'ISSUE 901 autopilot\n' >"$manifest"
  return 0
}
role_diff(){ echo hard; }
with_pack(){ printf '%s' "$1"; }
fetch_issues(){ :; }
process_acks(){ :; }
stall_check(){ :; }
scheduler(){
  local calls
  calls=$(<"$FENCE_SCHEDULER_CALLS_FILE")
  printf '%s\n' "$((calls + 1))" >"$FENCE_SCHEDULER_CALLS_FILE"
  printf '{"issue":686}\n' >"$ASSIGN/worker-1.json"
}
merger_step(){ :; }
drained_check(){ :; }
mstatus(){ :; }
notify(){ printf '%s\n' "$*" >>"$FENCE_NOTIFICATIONS"; }

tick
check "initial discovery failure invokes the model exactly once" 1 \
  "$(<"$FENCE_MODEL_CALLS_FILE")"
check "initial discovery failure does not invoke the scheduler" 0 \
  "$(<"$FENCE_SCHEDULER_CALLS_FILE")"
check "initial discovery failure creates no assignment" 0 \
  "$([ -e "$ASSIGN/worker-1.json" ] && echo 1 || echo 0)"
check "initial discovery failure leaves a durable fence" 1 \
  "$([ -d "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
grep -q -- 'scheduler fenced; automatic reconciliation will retry without replaying the model' \
  "$FENCE_NOTIFICATIONS" \
  && ok "discovery failure notification describes the durable scheduler fence" \
  || bad "discovery failure notification must describe the durable scheduler fence"

tick
check "failed reconciliation never replays the model" 1 \
  "$(<"$FENCE_MODEL_CALLS_FILE")"
check "failed reconciliation keeps the scheduler blocked" 0 \
  "$(<"$FENCE_SCHEDULER_CALLS_FILE")"
check "failed reconciliation keeps the fence across ticks" 1 \
  "$([ -d "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"

DISCOVERY_BROKEN=0
tick
check "successful direct reconciliation still never replays the model" 1 \
  "$(<"$FENCE_MODEL_CALLS_FILE")"
check "scheduler runs only after the validated fence clears" 1 \
  "$(<"$FENCE_SCHEDULER_CALLS_FILE")"
check "scheduler assignment appears only after reconciliation" 1 \
  "$([ -e "$ASSIGN/worker-1.json" ] && echo 1 || echo 0)"
check "successful reconciliation clears the durable fence" 0 \
  "$([ -e "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
check "valid directly reconciled issue is not dropped into quarantine" 0 \
  "$(grep -qx 901 "$CONTROL/composer-quarantine" 2>/dev/null && echo 1 || echo 0)"

# Restore production functions after the focused tick stubs.
log(){ :; }; notify(){ :; }; mark_human(){ :; }; issue_cost(){ :; }
MF_SOURCE_ONLY=1 . ./master.sh
rm -f "$ASSIGN/worker-1.json"

echo "— composer fence commits outcome/protocol state before clearing"
eval "$(declare -f composer_record_outcome \
  | sed '1s/composer_record_outcome/composer_record_outcome_real/')"
eval "$(declare -f composer_record_protocol_failure \
  | sed '1s/composer_record_protocol_failure/composer_record_protocol_failure_real/')"
OUTCOME_WRITE_FAIL=0
PROTOCOL_WRITE_FAIL=0
composer_record_outcome(){
  [ "$OUTCOME_WRITE_FAIL" -eq 0 ] || return 1
  composer_record_outcome_real "$@"
}
composer_record_protocol_failure(){
  [ "$PROTOCOL_WRITE_FAIL" -eq 0 ] || return 1
  composer_record_protocol_failure_real "$@"
}
composer_tx_reset(){
  rm -rf "$CONTROL/composer-discovery-fence" "$CONTROL/composer-manifests" \
    "$CONTROL/.composer-request-claim" "$CONTROL/composer-request-archive"
  rm -f "$CONTROL"/.composer-{last,backoff,snapshot,protocol-last,protocol-backoff} \
    "$CONTROL/composer-quarantine" "$CONTROL/composer-request.json" \
    "$CONTROL/.composer-request-active.json"
  mkdir -p "$CONTROL/composer-manifests"
  printf 'run\n' >"$CONTROL/mode"
  printf '[]\n' >"$TICK_ISSUES"
  COMPOSER_REQUEST_LOADED=0
  COMPOSER_REQUEST_ID=
  COMPOSER_REQUEST_EXACT_COUNT=
  COMPOSER_REQUEST_BRIEF=
  COMPOSER_TX_CALLS=0
  COMPOSER_TX_AFTER='[]'
}
MF_PROMPTS=$(pwd)/prompts
MF_COMPOSER_COOLDOWN=0
MF_COMPOSER_PROTOCOL_ATTEMPTS=1
COMPOSER_TX_CASE=valid
runnable_issues(){ :; }
mf_recent_issues_json(){ printf '%s\n' "$COMPOSER_TX_AFTER"; }
mf_issue_json_by_number(){ return 1; }
mf_cc(){
  local run manifest body
  COMPOSER_TX_CALLS=$((COMPOSER_TX_CALLS + 1))
  run=$(sed -n 's/^This invocation is `\([^`]*\)`. Issue creation.*/\1/p' \
    <<<"$3" | head -1)
  manifest=$(awk '
    index($0, "/work/mf/create-issue.sh --run-id ") {
      for (i=1; i<=NF; i++) if ($i == "--manifest") { print $(i+1); exit }
    }
  ' <<<"$3")
  case "$COMPOSER_TX_CASE" in
    none)
      printf 'NONE\n' >"$manifest"
      COMPOSER_TX_AFTER='[]'
      ;;
    valid)
      body=$(printf '## Context\nquoted\n\n## Scope\nvalid\n\n## Acceptance criteria\n- [ ] valid\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: valid\n-->' "$run")
      printf 'ISSUE 911 autopilot\n' >"$manifest"
      COMPOSER_TX_AFTER=$(jq -cn --arg body "$body" \
        '[{number:911,title:"valid",body:$body,
          labels:["autopilot","diff:normal"],created_at:"now"}]')
      ;;
    invalid)
      body=$(printf '## Context\nquoted\n\n## Scope\ninvalid\n\n## Acceptance criteria\n- [ ] invalid\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: invalid\n-->' "$run")
      printf 'ISSUE 913 autopilot\n' >"$manifest"
      COMPOSER_TX_AFTER=$(jq -cn --arg body "$body" \
        '[{number:913,title:"invalid",body:$body,
          labels:["diff:normal"],created_at:"now"}]')
      ;;
  esac
  return 0
}
role_diff(){ echo hard; }
with_pack(){ printf '%s' "$1"; }
fetch_issues(){ :; }

composer_tx_reset
COMPOSER_TX_CASE=valid
OUTCOME_WRITE_FAIL=1
TX_RC=0
composer_step run || TX_RC=$?
check "created outcome write failure is fail-closed" 2 "$TX_RC"
check "created outcome write failure retains the fence" 1 \
  "$([ -d "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
check "created outcome write failure invokes the model once" 1 "$COMPOSER_TX_CALLS"
OUTCOME_WRITE_FAIL=0
MF_MASTER_SESSION=tx-created-restart
composer_step run
check "created outcome restart reconciles without model replay" 1 "$COMPOSER_TX_CALLS"
check "created outcome restart clears only after persistence" 0 \
  "$([ -e "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
check "created outcome restart persists its cooldown" 1 \
  "$([ -f "$CONTROL/.composer-last" ] && echo 1 || echo 0)"

composer_tx_reset
COMPOSER_TX_CASE=none
OUTCOME_WRITE_FAIL=1
TX_RC=0
composer_step run || TX_RC=$?
check "NONE outcome write failure is fail-closed" 2 "$TX_RC"
check "NONE outcome write failure retains the fence" 1 \
  "$([ -d "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
OUTCOME_WRITE_FAIL=0
MF_MASTER_SESSION=tx-none-restart
composer_step run
check "NONE outcome restart reconciles without model replay" 1 "$COMPOSER_TX_CALLS"
check "NONE outcome restart persists before clearing" 0 \
  "$([ -e "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"

composer_tx_reset
COMPOSER_TX_CASE=invalid
PROTOCOL_WRITE_FAIL=1
TX_RC=0
composer_step run || TX_RC=$?
check "invalid artifact protocol write failure is fail-closed" 2 "$TX_RC"
check "invalid artifact is quarantined before failed persistence" 913 \
  "$(<"$CONTROL/composer-quarantine")"
check "invalid artifact write failure retains the fence" 1 \
  "$([ -d "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
PROTOCOL_WRITE_FAIL=0
MF_MASTER_SESSION=tx-invalid-restart
TX_RC=0
composer_step run || TX_RC=$?
check "invalid artifact restart finishes as a protocol failure" 1 "$TX_RC"
check "invalid artifact restart never replays the model" 1 "$COMPOSER_TX_CALLS"
check "invalid artifact restart persists protocol cooldown" 1 \
  "$([ -f "$CONTROL/.composer-protocol-last" ] && echo 1 || echo 0)"
check "invalid artifact restart clears only after persistence" 0 \
  "$([ -e "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"

composer_tx_reset
OUTCOME_WRITE_FAIL=0
touch(){
  [ "${1:-}" != "$CONTROL/.composer-last" ] || return 1
  command touch "$@"
}
if composer_record_outcome created "touch-failure" 0; then
  bad "composer outcome must fail when its cooldown timestamp cannot be touched"
else
  ok "composer outcome propagates cooldown timestamp failure"
fi
unset -f touch

# Restore production state writers and orchestration functions.
log(){ :; }; notify(){ :; }; mark_human(){ :; }; issue_cost(){ :; }
MF_SOURCE_ONLY=1 . ./master.sh

echo "— inconsistent persisted composer fences fail closed"
composer_corrupt_reset(){
  rm -rf "$CONTROL/composer-discovery-fence" "$CONTROL/composer-manifests" \
    "$CONTROL/.composer-request-claim" "$CONTROL/composer-request-archive"
  rm -f "$CONTROL/composer-request.json" "$CONTROL/.composer-request-active.json"
  mkdir -p "$CONTROL/composer-manifests"
  CORRUPT_RUN=composer-corrupt-1
  CORRUPT_MANIFEST="$CONTROL/composer-manifests/$CORRUPT_RUN"
  printf 'NONE\n' >"$CORRUPT_MANIFEST"
  COMPOSER_REQUEST_LOADED=0
  composer_discovery_fence_begin '[]' "$CORRUPT_MANIFEST" \
    "$CORRUPT_RUN" "snapshot" 0 0 1
  composer_discovery_fence_set_transport 0
}
composer_corrupt_meta(){
  local filter=$1 tmp
  tmp=$(mktemp "$CONTROL/.corrupt-meta.XXXXXX")
  jq "$filter" "$CONTROL/composer-discovery-fence/meta.json" >"$tmp" \
    && mv -f "$tmp" "$CONTROL/composer-discovery-fence/meta.json"
}

composer_corrupt_reset
composer_corrupt_meta '.exact_count = 2'
if composer_discovery_fence_load; then
  bad "empty owner id with a positive exact count must be rejected"
else
  ok "empty owner id with a positive exact count is rejected"
fi
CORRUPT_RC=0
composer_step run || CORRUPT_RC=$?
check "inconsistent exact-count fence keeps fail-closed return" 2 "$CORRUPT_RC"

composer_corrupt_reset
composer_corrupt_meta '.request_id = "owner-without-count"'
if composer_discovery_fence_load; then
  bad "owner id with zero exact count must be rejected"
else
  ok "owner id with zero exact count is rejected"
fi

composer_corrupt_reset
mkdir -p "$CONTROL/.composer-request-claim"
printf 'foreign-session\n' >"$CONTROL/.composer-request-claim/session"
jq -cn '{version:1,approved:true,id:"owner-downgrade",exact_count:1,brief:"owner"}' \
  >"$CONTROL/.composer-request-active.json"
if composer_discovery_fence_load; then
  bad "ordinary metadata must not downgrade coexisting active owner state"
else
  ok "ordinary metadata cannot downgrade coexisting active owner state"
fi
CORRUPT_SCHEDULER_CALLS=0
fetch_issues(){ :; }
process_acks(){ :; }
stall_check(){ :; }
scheduler(){ CORRUPT_SCHEDULER_CALLS=$((CORRUPT_SCHEDULER_CALLS + 1)); }
merger_step(){ :; }
drained_check(){ :; }
mstatus(){ :; }
tick
check "corrupt owner-downgrade fence never reaches scheduler" 0 \
  "$CORRUPT_SCHEDULER_CALLS"

rm -rf "$CONTROL/composer-discovery-fence" "$CONTROL/.composer-request-claim"
rm -f "$CONTROL/.composer-request-active.json"
log(){ :; }; notify(){ :; }; mark_human(){ :; }; issue_cost(){ :; }
MF_SOURCE_ONLY=1 . ./master.sh

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

echo "— exact-count one-shot owner composition request"
REQUEST_BRIEF=$T/owner-composer-brief.md
cat >"$REQUEST_BRIEF" <<'BRIEF'
Create exactly these two owner-approved tasks.
Keep this literal shell-looking text untouched: $HOME `not-a-command` "quotes".
BRIEF

# The host helper creates the request atomically and uses exact_count as the
# one-run batch without changing models.json or restarting the factory.
REQUEST_STATE=$T/request-helper-state
MFSTATE=$REQUEST_STATE COMPOSER_BATCH=2 ./request-compose.sh \
  2 "$REQUEST_BRIEF" exact-two >/dev/null
check "request helper records exact count" 2 \
  "$(jq -r .exact_count "$REQUEST_STATE/control/composer-request.json")"
check "request helper records explicit owner approval" true \
  "$(jq -r .approved "$REQUEST_STATE/control/composer-request.json")"
check "request helper preserves brief bytes as JSON text" "$(<"$REQUEST_BRIEF")" \
  "$(jq -r .brief "$REQUEST_STATE/control/composer-request.json")"
if MFSTATE=$T/request-too-large COMPOSER_BATCH=1 ./request-compose.sh \
  2 "$REQUEST_BRIEF" too-large >/dev/null 2>&1; then
  bad "request helper must reject exact count above COMPOSER_BATCH"
else
  ok "request helper rejects exact count above COMPOSER_BATCH"
fi
if MFSTATE=$REQUEST_STATE COMPOSER_BATCH=2 ./request-compose.sh \
  1 "$REQUEST_BRIEF" replay >/dev/null 2>&1; then
  bad "request helper must not overwrite a ready request"
else
  ok "request helper refuses to overwrite ready/active state"
fi

# Drive the real composer_step with a synthetic valid two-issue GitHub result.
# A recent 3600-second idle backoff proves the owner request explicitly re-arms
# composition; prompt capture proves the batch and brief delivered to the role.
rm -rf "$MFSTATE/control/.composer-request-claim" \
  "$MFSTATE/control/composer-request-archive"
rm -f "$MFSTATE/control/composer-request.json" \
  "$MFSTATE/control/.composer-request-active.json" \
  "$MFSTATE/control/.composer-protocol-last" \
  "$MFSTATE/control/.composer-protocol-backoff"
MFSTATE=$MFSTATE COMPOSER_BATCH=10 ./request-compose.sh \
  2 "$REQUEST_BRIEF" exact-two >/dev/null
MF_MASTER_SESSION=test-master-session
COMPOSER_BATCH=10
MF_COMPOSER_COOLDOWN=900
MF_COMPOSER_PROTOCOL_ATTEMPTS=2
printf '3600\n' >"$MFSTATE/control/.composer-backoff"
touch "$MFSTATE/control/.composer-last"
COMPOSER_CALLS=0
CAPTURED_COMPOSER_PROMPT=
AFTER_ISSUES='[]'
runnable_issues(){ printf '701\n702\n703\n'; }
mf_recent_issues_json(){ printf '%s\n' "$AFTER_ISSUES"; }
mf_cc(){
  local run manifest body_one body_two
  COMPOSER_CALLS=$((COMPOSER_CALLS+1))
  CAPTURED_COMPOSER_PROMPT=$3
  run=$(sed -n 's/^This invocation is `\([^`]*\)`. Issue creation.*/\1/p' <<<"$3" | head -1)
  manifest=$(awk '
    index($0, "/work/mf/create-issue.sh --run-id ") {
      for (i=1; i<=NF; i++) if ($i == "--manifest") { print $(i+1); exit }
    }
  ' <<<"$3")
  body_one=$(printf '## Context\nquoted current spec\n\n## Scope\none\n\n## Acceptance criteria\n- [ ] one\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: apps/api/src/services/tax/taxService.ts\n-->' "$run")
  body_two=$(printf '## Context\nquoted owner maintenance brief\n\n## Scope\ntwo\n\n## Acceptance criteria\n- [ ] two\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: multi-factory/autorun.sh\n-->' "$run")
  printf 'ISSUE 801 autopilot\nISSUE 802 autopilot\n' >"$manifest"
  AFTER_ISSUES=$(jq -cn \
    --arg one "$body_one" --arg two "$body_two" \
    '[
      {number:801,title:"one",body:$one,labels:["autopilot","diff:normal"],created_at:"now"},
      {number:802,title:"two",body:$two,labels:["autopilot","diff:normal"],created_at:"now"}
    ]')
  return 0
}
role_diff(){ echo max; }
with_pack(){ printf '%s' "$1"; }
fetch_issues(){ :; }
composer_step run
check "full normal queue does not claim a waiting owner request" 1 \
  "$([ -f "$MFSTATE/control/composer-request.json" ] && echo 1 || echo 0)"
check "full normal queue leaves no request replay lock" 0 \
  "$([ -d "$MFSTATE/control/.composer-request-claim" ] && echo 1 || echo 0)"
runnable_issues(){ :; }
composer_step run
check "owner request bypasses an existing idle cooldown" 1 "$COMPOSER_CALLS"
grep -q -- 'Create up to 2 new issues' <<<"$CAPTURED_COMPOSER_PROMPT" \
  && ok "exact count becomes the effective one-run composer batch" \
  || bad "owner exact count did not replace the rendered batch"
EXTRACTED_BRIEF=$(awk '
  /^<<< OWNER-APPROVED COMPOSITION BRIEF BEGIN:/ { inside=1; next }
  /^<<< OWNER-APPROVED COMPOSITION BRIEF END:/ { inside=0; exit }
  inside { print }
' <<<"$CAPTURED_COMPOSER_PROMPT")
check "owner brief is appended verbatim between visible delimiters" \
  "$(<"$REQUEST_BRIEF")" "$EXTRACTED_BRIEF"
check "successful request removes ready state" 0 \
  "$([ -e "$MFSTATE/control/composer-request.json" ] && echo 1 || echo 0)"
check "successful request removes active state" 0 \
  "$([ -e "$MFSTATE/control/.composer-request-active.json" ] && echo 1 || echo 0)"
check "successful request archives exactly once" 1 \
  "$(find "$MFSTATE/control/composer-request-archive" -type f | wc -l | tr -d ' ')"
check "archived request retains its id" exact-two \
  "$(jq -r .id "$MFSTATE"/control/composer-request-archive/*.json)"

echo "— owner discovery fence survives a fresh session and archive crash window"
rm -rf "$CONTROL/composer-discovery-fence" "$CONTROL/.composer-request-claim"
rm -f "$CONTROL/composer-request.json" "$CONTROL/.composer-request-active.json" \
  "$CONTROL/.composer-protocol-last" "$CONTROL/.composer-protocol-backoff"
MFSTATE=$MFSTATE COMPOSER_BATCH=10 ./request-compose.sh \
  1 "$REQUEST_BRIEF" fresh-reconcile >/dev/null
MF_MASTER_SESSION=owner-original-session
OWNER_FENCE_CALLS=0
OWNER_DISCOVERY_BROKEN=1
AFTER_ISSUES='[]'
mf_recent_issues_json(){
  if [ -d "$CONTROL/composer-discovery-fence" ] \
    && [ "$OWNER_DISCOVERY_BROKEN" -eq 1 ]; then
    return 1
  fi
  printf '%s\n' "$AFTER_ISSUES"
}
mf_cc(){
  local run manifest body
  OWNER_FENCE_CALLS=$((OWNER_FENCE_CALLS + 1))
  run=$(sed -n 's/^This invocation is `\([^`]*\)`. Issue creation.*/\1/p' \
    <<<"$3" | head -1)
  manifest=$(awk '
    index($0, "/work/mf/create-issue.sh --run-id ") {
      for (i=1; i<=NF; i++) if ($i == "--manifest") { print $(i+1); exit }
    }
  ' <<<"$3")
  body=$(printf '## Context\nowner brief\n\n## Scope\nfresh\n\n## Acceptance criteria\n- [ ] fresh\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: fresh\n-->' "$run")
  printf 'ISSUE 814 autopilot\n' >"$manifest"
  AFTER_ISSUES=$(jq -cn --arg body "$body" \
    '[{number:814,title:"fresh",body:$body,
      labels:["autopilot","diff:normal"],created_at:"now"}]')
  return 0
}
runnable_issues(){ :; }
OWNER_FENCE_RC=0
composer_step run || OWNER_FENCE_RC=$?
check "owner discovery failure is retained for reconciliation" 2 "$OWNER_FENCE_RC"
check "owner discovery failure calls the model once" 1 "$OWNER_FENCE_CALLS"
check "owner discovery failure preserves active request" fresh-reconcile \
  "$(jq -r .id "$CONTROL/.composer-request-active.json")"

eval "$(declare -f composer_discovery_fence_clear \
  | sed '1s/composer_discovery_fence_clear/composer_discovery_fence_clear_real/')"
RETAIN_OWNER_FENCE=1
composer_discovery_fence_clear(){
  [ "$RETAIN_OWNER_FENCE" -eq 0 ] || return 1
  composer_discovery_fence_clear_real "$@"
}
MF_MASTER_SESSION=owner-fresh-session
OWNER_DISCOVERY_BROKEN=0
OWNER_FENCE_RC=0
composer_step run || OWNER_FENCE_RC=$?
check "fresh session reconciles and archives before retained-fence failure" 2 \
  "$OWNER_FENCE_RC"
check "fresh session archives owner request exactly once" 1 \
  "$(find "$CONTROL/composer-request-archive" -type f \
    -name 'fresh-reconcile-*' | wc -l | tr -d ' ')"
check "post-archive crash window retains the discovery fence" 1 \
  "$([ -d "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"

RETAIN_OWNER_FENCE=0
composer_step run
check "already-archived remaining fence never replays the model" 1 \
  "$OWNER_FENCE_CALLS"
check "already-archived remaining fence does not archive twice" 1 \
  "$(find "$CONTROL/composer-request-archive" -type f \
    -name 'fresh-reconcile-*' | wc -l | tr -d ' ')"
check "already-archived remaining fence clears idempotently" 0 \
  "$([ -e "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
composer_discovery_fence_clear(){
  composer_discovery_fence_clear_real "$@"
}

echo "— owner replay block writes fail closed and retain discovery"
eval "$(declare -f atomic_write \
  | sed '1s/atomic_write/atomic_write_before_block_fault/')"
BLOCK_GUARD_WRITE_MODE=none
atomic_write(){
  if [ "$BLOCK_GUARD_WRITE_MODE" = both ] \
    && { [ "$1" = "$CONTROL/.composer-request-claim/blocked" ] \
      || [ "$1" = "$CONTROL/.composer-request-claim/session" ]; }; then
    return 1
  fi
  if [ "$BLOCK_GUARD_WRITE_MODE" = blocked ] \
    && [ "$1" = "$CONTROL/.composer-request-claim/blocked" ]; then
    return 1
  fi
  atomic_write_before_block_fault "$@"
}

# The primitive itself must not report success when neither durable guard
# changed. A session poison remains a valid fallback when only blocked fails.
rm -rf "$CONTROL/.composer-request-claim"
mkdir -p "$CONTROL/.composer-request-claim"
MF_MASTER_SESSION=block-fault-direct
printf '%s\n' "$MF_MASTER_SESSION" >"$CONTROL/.composer-request-claim/session"
BLOCK_GUARD_WRITE_MODE=both
BLOCK_MARK_RC=0
composer_request_mark_blocked injected-write-failure || BLOCK_MARK_RC=$?
check "block marker reports failure when both durable guards fail" 1 "$BLOCK_MARK_RC"
check "failed block marker creates no blocked guard" 0 \
  "$([ -f "$CONTROL/.composer-request-claim/blocked" ] && echo 1 || echo 0)"
check "failed block marker leaves the replayable session unpoisoned" \
  "$MF_MASTER_SESSION" "$(<"$CONTROL/.composer-request-claim/session")"

rm -f "$CONTROL/.composer-request-claim/blocked" \
  "$CONTROL/.composer-request-claim/alerted"
printf '%s\n' "$MF_MASTER_SESSION" >"$CONTROL/.composer-request-claim/session"
BLOCK_GUARD_WRITE_MODE=blocked
BLOCK_MARK_RC=0
composer_request_mark_blocked fallback-session-poison || BLOCK_MARK_RC=$?
check "session poison is an accepted durable fallback" 0 "$BLOCK_MARK_RC"
check "fallback poison makes the current session foreign" \
  "blocked-$MF_MASTER_SESSION" "$(<"$CONTROL/.composer-request-claim/session")"

# Exercise both orchestration callers. The final-invalid path must retain its
# fence when both writes fail; same-session reconciliation must do the same.
# Once writes recover after a restart, reconciliation blocks the request and
# clears the fence without invoking the model again.
rm -rf "$CONTROL/composer-discovery-fence" "$CONTROL/composer-manifests" \
  "$CONTROL/.composer-request-claim" "$CONTROL/composer-request-archive"
rm -f "$CONTROL/composer-request.json" "$CONTROL/.composer-request-active.json" \
  "$CONTROL/.composer-protocol-last" "$CONTROL/.composer-protocol-backoff"
mkdir -p "$CONTROL/composer-manifests"
MFSTATE=$MFSTATE COMPOSER_BATCH=10 ./request-compose.sh \
  1 "$REQUEST_BRIEF" block-write-restart >/dev/null
MF_MASTER_SESSION=block-fault-owner
COMPOSER_REQUEST_LOADED=0
COMPOSER_REQUEST_ID=
COMPOSER_REQUEST_EXACT_COUNT=
COMPOSER_REQUEST_BRIEF=
MF_COMPOSER_PROTOCOL_ATTEMPTS=1
BLOCK_GUARD_WRITE_MODE=none
BLOCK_GUARD_MODEL_CALLS=0
AFTER_ISSUES='[]'
runnable_issues(){ :; }
mf_recent_issues_json(){ printf '%s\n' "$AFTER_ISSUES"; }
mf_cc(){
  local manifest
  BLOCK_GUARD_MODEL_CALLS=$((BLOCK_GUARD_MODEL_CALLS + 1))
  manifest=$(awk '
    index($0, "/work/mf/create-issue.sh --run-id ") {
      for (i=1; i<=NF; i++) if ($i == "--manifest") { print $(i+1); exit }
    }
  ' <<<"$3")
  printf 'NONE\n' >"$manifest"
  BLOCK_GUARD_WRITE_MODE=both
  return 0
}
role_diff(){ echo max; }
with_pack(){ printf '%s' "$1"; }
fetch_issues(){ :; }

BLOCK_DIRECT_RC=0
composer_step run || BLOCK_DIRECT_RC=$?
check "direct invalid path carries fail-closed rc when block writes fail" 2 "$BLOCK_DIRECT_RC"
check "direct invalid path retains discovery fence on block-write failure" 1 \
  "$([ -d "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
check "direct invalid path invokes the owner request once" 1 "$BLOCK_GUARD_MODEL_CALLS"
check "direct invalid path did not claim a durable blocked guard" 0 \
  "$([ -f "$CONTROL/.composer-request-claim/blocked" ] && echo 1 || echo 0)"
check "direct invalid path did not poison the session after injected failures" \
  "$MF_MASTER_SESSION" "$(<"$CONTROL/.composer-request-claim/session")"

BLOCK_RECON_RC=0
composer_step run || BLOCK_RECON_RC=$?
check "same-session reconciliation carries fail-closed rc" 2 "$BLOCK_RECON_RC"
check "reconciliation retains fence when block writes still fail" 1 \
  "$([ -d "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
check "same-session reconciliation never replays the model" 1 "$BLOCK_GUARD_MODEL_CALLS"

MF_MASTER_SESSION=block-fault-restart
BLOCK_GUARD_WRITE_MODE=none
BLOCK_RESTART_RC=0
composer_step run || BLOCK_RESTART_RC=$?
check "restart reconciliation keeps the owner request fail closed" 2 "$BLOCK_RESTART_RC"
check "restart reconciliation clears fence only after durable blocking" 0 \
  "$([ -e "$CONTROL/composer-discovery-fence" ] && echo 1 || echo 0)"
check "restart reconciliation persists the blocked guard" \
  discovery-reconciliation-invalid "$(<"$CONTROL/.composer-request-claim/blocked")"
check "restart reconciliation does not replay the model" 1 "$BLOCK_GUARD_MODEL_CALLS"
composer_step run || true
check "blocked request remains non-replayable after fence cleanup" 1 "$BLOCK_GUARD_MODEL_CALLS"

atomic_write(){
  atomic_write_before_block_fault "$@"
}
rm -rf "$CONTROL/composer-discovery-fence" "$CONTROL/.composer-request-claim"
rm -f "$CONTROL/composer-request.json" "$CONTROL/.composer-request-active.json" \
  "$CONTROL/.composer-protocol-last" "$CONTROL/.composer-protocol-backoff"
COMPOSER_REQUEST_LOADED=0
COMPOSER_REQUEST_ID=
COMPOSER_REQUEST_EXACT_COUNT=
COMPOSER_REQUEST_BRIEF=
MF_COMPOSER_PROTOCOL_ATTEMPTS=2

# Composition-disabled modes must never claim a brand-new ready request. run-out
# can continue assigning ordinary queued issues; close-down cannot assign, but
# both modes leave the request ready for a future run-mode tick.
MFSTATE=$MFSTATE COMPOSER_BATCH=10 ./request-compose.sh \
  1 "$REQUEST_BRIEF" ready-non-run >/dev/null
composer_step run-out
check "run-out does not claim a brand-new owner request" ready-non-run \
  "$(jq -r .id "$MFSTATE/control/composer-request.json")"
check "run-out creates no replay guard for a ready request" 0 \
  "$([ -d "$MFSTATE/control/.composer-request-claim" ] && echo 1 || echo 0)"
composer_step close-down
check "close-down does not claim a brand-new owner request" ready-non-run \
  "$(jq -r .id "$MFSTATE/control/composer-request.json")"
rm -f "$MFSTATE/control/composer-request.json"

# NONE is valid for an ordinary composer run, but never satisfies an exact-count
# owner request. It gets the designed corrective attempt and remains active.
rm -rf "$MFSTATE/control/.composer-request-claim"
rm -f "$MFSTATE/control/.composer-request-active.json" \
  "$MFSTATE/control/composer-request.json" \
  "$MFSTATE/control/.composer-protocol-last" \
  "$MFSTATE/control/.composer-protocol-backoff"
MFSTATE=$MFSTATE COMPOSER_BATCH=10 ./request-compose.sh \
  2 "$REQUEST_BRIEF" none-retained >/dev/null
COMPOSER_CALLS=0
AFTER_ISSUES='[]'
mf_cc(){
  local manifest
  COMPOSER_CALLS=$((COMPOSER_CALLS+1))
  manifest=$(awk '
    index($0, "/work/mf/create-issue.sh --run-id ") {
      for (i=1; i<=NF; i++) if ($i == "--manifest") { print $(i+1); exit }
    }
  ' <<<"$3")
  printf 'NONE\n' >"$manifest"
  return 0
}
composer_step run
NONE_RC=$?
check "NONE fails closed for an exact-count owner request" 2 "$NONE_RC"
check "NONE receives only the bounded corrective attempt" 2 "$COMPOSER_CALLS"
check "NONE retains active request for owner review" 1 \
  "$([ -f "$MFSTATE/control/.composer-request-active.json" ] && echo 1 || echo 0)"
check "NONE never archives the exact-count request" 0 \
  "$(find "$MFSTATE/control/composer-request-archive" -type f -name 'none-retained-*' | wc -l | tr -d ' ')"

# A partial first attempt cannot be laundered by creating an exact second
# manifest: all artifacts remain quarantined and the request stays active.
rm -rf "$MFSTATE/control/.composer-request-claim"
rm -f "$MFSTATE/control/.composer-request-active.json" \
  "$MFSTATE/control/composer-request.json" \
  "$MFSTATE/control/.composer-protocol-last" \
  "$MFSTATE/control/.composer-protocol-backoff" \
  "$MFSTATE/control/composer-quarantine"
COMPOSER_REQUEST_LOADED=0
COMPOSER_REQUEST_ID=
COMPOSER_REQUEST_EXACT_COUNT=
COMPOSER_REQUEST_BRIEF=
MFSTATE=$MFSTATE COMPOSER_BATCH=10 ./request-compose.sh \
  2 "$REQUEST_BRIEF" partial-retained >/dev/null
COMPOSER_CALLS=0
AFTER_ISSUES='[]'
mf_cc(){
  local run manifest body_three body_four body_five
  COMPOSER_CALLS=$((COMPOSER_CALLS+1))
  run=$(sed -n 's/^This invocation is `\([^`]*\)`. Issue creation.*/\1/p' <<<"$3" | head -1)
  manifest=$(awk '
    index($0, "/work/mf/create-issue.sh --run-id ") {
      for (i=1; i<=NF; i++) if ($i == "--manifest") { print $(i+1); exit }
    }
  ' <<<"$3")
  body_three=$(printf '## Context\nquoted\n\n## Scope\nthree\n\n## Acceptance criteria\n- [ ] three\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: three\n-->' "$run")
  body_four=$(printf '## Context\nquoted\n\n## Scope\nfour\n\n## Acceptance criteria\n- [ ] four\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: four\n-->' "$run")
  body_five=$(printf '## Context\nquoted\n\n## Scope\nfive\n\n## Acceptance criteria\n- [ ] five\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: five\n-->' "$run")
  if [ "$COMPOSER_CALLS" -eq 1 ]; then
    printf 'ISSUE 803 autopilot\n' >"$manifest"
    AFTER_ISSUES=$(jq -cn --arg body "$body_three" \
      '[{number:803,title:"three",body:$body,labels:["autopilot","diff:normal"],created_at:"now"}]')
  else
    printf 'ISSUE 804 autopilot\nISSUE 805 autopilot\n' >"$manifest"
    AFTER_ISSUES=$(jq -cn \
      --arg three "$(jq -r '.[0].body' <<<"$AFTER_ISSUES")" \
      --arg four "$body_four" --arg five "$body_five" \
      '[
        {number:803,title:"three",body:$three,labels:["autopilot","diff:normal"],created_at:"now"},
        {number:804,title:"four",body:$four,labels:["autopilot","diff:normal"],created_at:"now"},
        {number:805,title:"five",body:$five,labels:["autopilot","diff:normal"],created_at:"now"}
      ]')
  fi
  return 0
}
composer_step run
PARTIAL_RC=$?
check "partial request remains a fail-closed protocol error" 2 "$PARTIAL_RC"
check "partial request uses only the bounded attempts" 2 "$COMPOSER_CALLS"
check "later exact manifest cannot launder earlier artifacts" partial-retained \
  "$(jq -r .id "$MFSTATE/control/.composer-request-active.json")"
check "all partial/retry artifacts stay quarantined" "803
804
805" "$(<"$MFSTATE/control/composer-quarantine")"
check "partial request is never archived" 0 \
  "$(find "$MFSTATE/control/composer-request-archive" -type f -name 'partial-retained-*' | wc -l | tr -d ' ')"
composer_request_prepare
SAME_SESSION_RC=$?
check "bounded failure disables same-session automatic replay" 2 "$SAME_SESSION_RC"
check "bounded failure records a durable blocked reason" protocol-failure \
  "$(<"$MFSTATE/control/.composer-request-claim/blocked")"

# A restarted/concurrent master gets a different session token. It must neither
# replay the active request nor schedule potentially unvalidated artifacts.
MF_MASTER_SESSION=other-master-session
composer_request_prepare
FOREIGN_RC=$?
check "foreign master session refuses active-request replay" 2 "$FOREIGN_RC"
check "foreign replay refusal preserves the active request" partial-retained \
  "$(jq -r .id "$MFSTATE/control/.composer-request-active.json")"
# Reproduce the reviewed crash window: an unquarantined issue is runnable while
# run-out would normally keep assigning. The foreign active claim must be
# reconciled before the mode gate and suppress the scheduler entirely.
if grep -qx '806' "$MFSTATE/control/composer-quarantine" 2>/dev/null; then
  bad "run-out crash-window fixture must remain unquarantined"
else
  ok "run-out crash-window fixture is unquarantined"
fi
runnable_issues(){ printf '806\n'; }
printf 'run-out\n' >"$MFSTATE/control/mode"
SCHEDULER_CALLS=0
fetch_issues(){ :; }
process_acks(){ :; }
stall_check(){ :; }
scheduler(){ SCHEDULER_CALLS=$((SCHEDULER_CALLS+1)); }
merger_step(){ :; }
drained_check(){ :; }
mstatus(){ :; }
tick
check "run-out foreign claim pauses crash-window artifact scheduling" 0 "$SCHEDULER_CALLS"
CLOSE_DOWN_RC=0
composer_step close-down || CLOSE_DOWN_RC=$?
check "close-down also reports an unresolved foreign claim" 2 "$CLOSE_DOWN_RC"
MF_MASTER_SESSION=test-master-session
# Restore the production master functions replaced by the focused tick stubs.
MF_SOURCE_ONLY=1 . ./master.sh

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

echo "— reviewer comment discovery converges before rerunning the model"
MF_COMMENT_DISCOVERY_ATTEMPTS=3
MF_COMMENT_DISCOVERY_SLEEP=0
DISCOVERY_READS=0
pr_snapshot(){
  DISCOVERY_READS=$((DISCOVERY_READS+1))
  PR_SNAPSHOT_HEAD=abc
  if [ "$DISCOVERY_READS" -lt 3 ]; then
    PR_SNAPSHOT_COMMENTS='[]'
  else
    PR_SNAPSHOT_COMMENTS=$after_ok
  fi
}
review_comment_discover '[]' 10 abc \
  && ok "review discovery accepts a canonical comment after list convergence" \
  || bad "review discovery rejected a converged canonical comment"
check "review discovery polls without rerunning the reviewer" 3 "$DISCOVERY_READS"
check "review discovery records acceptance" accepted "$REVIEW_DISCOVERY_STATE"

DISCOVERY_READS=0
pr_snapshot(){
  DISCOVERY_READS=$((DISCOVERY_READS+1))
  PR_SNAPSHOT_HEAD=def
  PR_SNAPSHOT_COMMENTS=$after_ok
}
review_comment_discover '[]' 10 abc \
  && bad "review discovery must reject a changed PR head" \
  || ok "review discovery rejects a changed PR head"
check "changed head aborts discovery immediately" 1 "$DISCOVERY_READS"
check "changed head has an explicit discovery state" head-changed "$REVIEW_DISCOVERY_STATE"

MF_PROMPTS=$T/reviewer-prompts
mkdir -p "$MF_PROMPTS"
printf 'review {{PR}} for {{N}} at {{HEAD}}\n' >"$MF_PROMPTS/reviewer.md"
MF_PROTOCOL_ATTEMPTS=2
MF_PROTOCOL_RETRY_SLEEP=0
MF_COMMENT_DISCOVERY_ATTEMPTS=4
MF_COMMENT_DISCOVERY_SLEEP=0
MODEL_CALLS=0
DISCOVERY_READS=0
pr_snapshot(){
  DISCOVERY_READS=$((DISCOVERY_READS+1))
  PR_SNAPSHOT_HEAD=abc
  if [ "$DISCOVERY_READS" -lt 6 ]; then
    PR_SNAPSHOT_COMMENTS='[]'
  else
    PR_SNAPSHOT_COMMENTS=$after_ok
  fi
}
mf_cc(){ MODEL_CALLS=$((MODEL_CALLS+1)); return 0; }
with_pack(){ printf '%s' "$1"; }
run_reviewer 9 10 hard \
  && ok "late first-attempt verdict is accepted before a second model turn" \
  || bad "late first-attempt verdict was lost across the outer retry boundary"
check "late verdict does not rerun the reviewer" 1 "$MODEL_CALLS"
check "late verdict retains its canonical comment id" 2 "$LAST_REVIEW_COMMENT_ID"

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
# The review stage now short-circuits on a live queue entry; earlier sections
# leave entries behind, so this battery starts from an empty queue.
rm -f "$MFSTATE"/merge-queue/*.json
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

echo "— stale enqueued triage state revalidates instead of looping"
# Merger invalidation (update-branch/conflict-fix) removes the queue entry and
# the in-progress label and expects a fresh review; a durable complete/enqueued
# state that keeps answering "done" makes the scheduler reassign the issue in
# an infinite no-op loop (live: issues #865/#878, 2026-07-28).
CHECKER_CALLS=0; ESC_FIXER_CALLS=0; ESC_REVIEW_CALLS=0; ESC_ENQUEUES=0; HUMANS=0
run_checker(){ CHECKER_CALLS=$((CHECKER_CALLS+1)); return 1; }
run_escalated_fixer_once(){ ESC_FIXER_CALLS=$((ESC_FIXER_CALLS+1)); return 1; }
run_reviewer(){
  ESC_REVIEW_CALLS=$((ESC_REVIEW_CALLS+1))
  LAST_REVIEW_VERDICT="FACTORY-VERDICT: APPROVE"
  LAST_REVIEW_HEAD=ghi
  LAST_REVIEW_COMMENT_ID=99
  return 0
}
enqueue_merge(){ ESC_ENQUEUES=$((ESC_ENQUEUES+1)); return 0; }
mark_human(){ HUMANS=$((HUMANS+1)); }
gh(){ [ "$1 $2" = "pr view" ] && echo OPEN; }
LAST_CHECKER_VERDICT="FACTORY-TRIAGE: RETRY_ESCALATED"
LAST_CHECKER_BODY="root cause"
LAST_CHECKER_COMMENT_ID=91
LAST_CHECKER_HEAD=abc
LAST_CHECKER_NEW=""
LAST_CHECKER_PR_DISPOSITION=""
LAST_CHECKER_RUN_ID=checker-stale
TRIAGE_ESC_DIFF=normal
TRIAGE_FIXER_BASE_HEAD=abc
TRIAGE_FIXER_HEAD=def
TRIAGE_OUTCOME=enqueued
TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
CYCLE_DIFF=easy
TRIAGE_FILE=$(triage_state_file 12 22)
triage_state_save "$TRIAGE_FILE" 12 22 complete

printf '%s\n' '{"pr":22}' >"$MFSTATE/merge-queue/5-pr22.json"
triage 12 22 false
check "live enqueue stays terminal" 0 "$?"
check "live enqueue reviews nothing" 0 "$ESC_REVIEW_CALLS"

rm -f "$MFSTATE/merge-queue/5-pr22.json"
gh(){ [ "$1 $2" = "pr view" ] && echo MERGED; }
triage 12 22 false
check "consumed enqueue on a merged PR stays terminal" 0 "$?"
check "merged PR reviews nothing" 0 "$ESC_REVIEW_CALLS"

gh(){ [ "$1 $2" = "pr view" ] && echo OPEN; }
triage 12 22 false
check "stale enqueue re-earns approval at the current head" 0 "$?"
check "stale enqueue runs exactly one fresh review" 1 "$ESC_REVIEW_CALLS"
check "fresh approval re-enqueues once" 1 "$ESC_ENQUEUES"
check "revalidation replays neither checker nor fixer" 0 "$((CHECKER_CALLS+ESC_FIXER_CALLS))"
check "revalidated state is durable complete/enqueued" enqueued "$(jq -r .outcome "$TRIAGE_FILE")"

run_reviewer(){
  ESC_REVIEW_CALLS=$((ESC_REVIEW_CALLS+1))
  LAST_REVIEW_VERDICT="FACTORY-VERDICT: REQUEST_CHANGES"
  LAST_REVIEW_HEAD=jkl
  LAST_REVIEW_COMMENT_ID=100
  return 0
}
triage 12 22 false
check "revalidation rejection routes to human with no appeal" 1 "$?"
check "revalidation rejection marks human once" 1 "$HUMANS"
triage 12 22 false
check "human outcome is terminal on further resumes" 1 "$?"
check "human outcome triggers no further review" 2 "$ESC_REVIEW_CALLS"
check "human outcome re-asserts the park" 2 "$HUMANS"

# A relocate-MERGEABLE enqueue has no escalated difficulty on record: the
# revalidating review must fall back to the cycle difficulty, floored.
ESC_REVIEW_CALLS=0; ESC_REVIEW_DIFF=""
run_reviewer(){
  ESC_REVIEW_CALLS=$((ESC_REVIEW_CALLS+1)); ESC_REVIEW_DIFF=$3
  LAST_REVIEW_VERDICT="FACTORY-VERDICT: APPROVE"
  LAST_REVIEW_HEAD=mno
  LAST_REVIEW_COMMENT_ID=101
  return 0
}
LAST_CHECKER_VERDICT="FACTORY-TRIAGE: RELOCATE"
LAST_CHECKER_PR_DISPOSITION=MERGEABLE
LAST_CHECKER_NEW=502
TRIAGE_ESC_DIFF=""
TRIAGE_OUTCOME=enqueued
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
CYCLE_DIFF=easy
TRIAGE_FILE=$(triage_state_file 13 23)
triage_state_save "$TRIAGE_FILE" 13 23 complete
triage 13 23 false
check "relocate enqueue also revalidates when stale" 0 "$?"
check "empty escalated difficulty falls back to cycle difficulty floored" intermediate "$ESC_REVIEW_DIFF"

# Unverifiable reads stay terminal and consume neither reviews nor budget.
ESC_REVIEW_CALLS=0
LAST_CHECKER_VERDICT="FACTORY-TRIAGE: RETRY_ESCALATED"
LAST_CHECKER_PR_DISPOSITION=""
LAST_CHECKER_NEW=""
TRIAGE_ESC_DIFF=normal
TRIAGE_OUTCOME=enqueued
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
TRIAGE_FILE=$(triage_state_file 14 24)
triage_state_save "$TRIAGE_FILE" 14 24 complete
gh(){ return 1; }
triage 14 24 false
check "failed PR-state read stays terminal" 0 "$?"
gh(){ [ "$1 $2" = "pr view" ] && echo CLOSED; }
triage 14 24 false
check "closed unmerged PR stays terminal" 0 "$?"
gh(){ [ "$1 $2" = "pr view" ] && echo BANANA; }
triage 14 24 false
check "garbage PR state stays terminal" 0 "$?"
gh(){ [ "$1 $2" = "pr view" ] && echo OPEN; }
QUEUE_REAL=$QUEUE; QUEUE=$MFSTATE/queue-gone
triage 14 24 false
check "unreadable queue directory stays terminal" 0 "$?"
QUEUE=$QUEUE_REAL
check "no review is paid for any unverifiable read" 0 "$ESC_REVIEW_CALLS"
check "unverifiable reads consume no revalidation budget" 0 "$(jq -r .revalidations "$TRIAGE_FILE")"

# The durable revalidation budget parks the issue instead of reviewing forever.
ESC_REVIEW_CALLS=0; HUMANS=0
run_reviewer(){
  ESC_REVIEW_CALLS=$((ESC_REVIEW_CALLS+1))
  LAST_REVIEW_VERDICT="FACTORY-VERDICT: APPROVE"
  LAST_REVIEW_HEAD=pqr
  LAST_REVIEW_COMMENT_ID=102
  return 0
}
TRIAGE_OUTCOME=enqueued
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
TRIAGE_FILE=$(triage_state_file 15 25)
triage_state_save "$TRIAGE_FILE" 15 25 complete
triage 15 25 false; triage 15 25 false; triage 15 25 false
check "invalidations within budget still revalidate" 3 "$ESC_REVIEW_CALLS"
check "revalidation count is durable" 3 "$(jq -r .revalidations "$TRIAGE_FILE")"
triage 15 25 false
check "budget exhaustion parks instead of reviewing" 1 "$?"
check "budget exhaustion pays for no further review" 3 "$ESC_REVIEW_CALLS"
check "budget exhaustion marks human" 1 "$HUMANS"
check "budget exhaustion is a durable human outcome" human "$(jq -r .outcome "$TRIAGE_FILE")"

# A live queue entry short-circuits the review stage itself (salvage case).
ESC_REVIEW_CALLS=0
TRIAGE_OUTCOME=""
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
TRIAGE_FILE=$(triage_state_file 16 26)
triage_state_save "$TRIAGE_FILE" 16 26 escalated-review-pending
printf '%s\n' '{"pr":26}' >"$MFSTATE/merge-queue/7-pr26.json"
triage 16 26 false
check "salvaged queue entry skips the paid review" 0 "$?"
check "salvaged queue entry reviews nothing" 0 "$ESC_REVIEW_CALLS"
check "salvaged queue entry lands terminal enqueued" enqueued "$(jq -r .outcome "$TRIAGE_FILE")"
rm -f "$MFSTATE/merge-queue/7-pr26.json"

# An entry appearing between probe and write is a salvage, not a protocol loop.
enqueue_merge(){ printf '%s\n' '{"pr":27}' >"$MFSTATE/merge-queue/8-pr27.json"; return 1; }
TRIAGE_OUTCOME=""
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
TRIAGE_FILE=$(triage_state_file 17 27)
triage_state_save "$TRIAGE_FILE" 17 27 escalated-review-pending
triage 17 27 false
check "enqueue mismatch with a live entry is terminal enqueued" 0 "$?"
check "enqueue mismatch outcome is durable" enqueued "$(jq -r .outcome "$TRIAGE_FILE")"
rm -f "$MFSTATE/merge-queue/8-pr27.json"

# A genuine queue write failure still requeues the protocol.
enqueue_merge(){ return 1; }
TRIAGE_OUTCOME=""
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
TRIAGE_FILE=$(triage_state_file 18 28)
triage_state_save "$TRIAGE_FILE" 18 28 escalated-review-pending
triage 18 28 false
check "true queue write failure requeues protocol" 2 "$?"

check "invalid difficulty normalizes to the floor" intermediate "$(diff_at_least banana intermediate)"

# The review budget is spent at the spend site: a latched review stage
# (deterministic reviewer artifact failure → return 2 → resume) cannot buy
# reviews past MF_REVALIDATE_MAX+1 while the transition counter sits frozen.
ESC_REVIEW_CALLS=0; HUMANS=0
run_reviewer(){ ESC_REVIEW_CALLS=$((ESC_REVIEW_CALLS+1)); return 1; }
enqueue_merge(){ return 0; }
TRIAGE_ESC_DIFF=normal
TRIAGE_OUTCOME=""
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
TRIAGE_FILE=$(triage_state_file 19 29)
triage_state_save "$TRIAGE_FILE" 19 29 escalated-review-pending
for tick in 1 2 3 4; do triage 19 29 false; done
check "latched review stage keeps requeueing under budget" 2 "$?"
check "latched review stage spends up to the cap" 4 "$ESC_REVIEW_CALLS"
triage 19 29 false
check "review budget exhaustion parks" 1 "$?"
check "review budget exhaustion pays nothing further" 4 "$ESC_REVIEW_CALLS"
check "review budget exhaustion marks human" 1 "$HUMANS"
check "spent reviews are durable" 5 "$(jq -r .reviews_spent "$TRIAGE_FILE")"

# Probe failures are bounded and park loudly instead of spinning silently.
ESC_REVIEW_CALLS=0; HUMANS=0
MF_QUEUE_PROBE_MAX_SAVE=${MF_QUEUE_PROBE_MAX:-40}; MF_QUEUE_PROBE_MAX=2
gh(){ [ "$1 $2" = "pr view" ] && echo OPEN; }
run_reviewer(){
  ESC_REVIEW_CALLS=$((ESC_REVIEW_CALLS+1))
  LAST_REVIEW_VERDICT="FACTORY-VERDICT: APPROVE"
  LAST_REVIEW_HEAD=stu
  LAST_REVIEW_COMMENT_ID=103
  return 0
}
TRIAGE_OUTCOME=enqueued
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
TRIAGE_FILE=$(triage_state_file 20 30)
triage_state_save "$TRIAGE_FILE" 20 30 complete
QUEUE_REAL=$QUEUE; QUEUE=$MFSTATE/queue-gone
triage 20 30 false; triage 20 30 false
check "probe failures under the cap stay terminal" 0 "$?"
check "probe failure count is durable" 2 "$(jq -r .probe_failures "$TRIAGE_FILE")"
triage 20 30 false
check "probe failure cap parks loudly" 1 "$?"
check "probe failure park marks human" 1 "$HUMANS"
check "probe failures never buy reviews" 0 "$ESC_REVIEW_CALLS"
QUEUE=$QUEUE_REAL; MF_QUEUE_PROBE_MAX=$MF_QUEUE_PROBE_MAX_SAVE

# A recovered probe resets the failure count before it can drift to a park.
TRIAGE_OUTCOME=enqueued
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=1
TRIAGE_FILE=$(triage_state_file 21 31)
triage_state_save "$TRIAGE_FILE" 21 31 complete
printf '%s\n' '{"pr":31}' >"$MFSTATE/merge-queue/9-pr31.json"
triage 21 31 false
check "recovered probe stays terminal" 0 "$?"
check "recovered probe resets the failure count" 0 "$(jq -r .probe_failures "$TRIAGE_FILE")"
rm -f "$MFSTATE/merge-queue/9-pr31.json"

# Dotfile markers in the queue are never live entries.
ESC_REVIEW_CALLS=0
TRIAGE_OUTCOME=enqueued
TRIAGE_REVALIDATIONS=0; TRIAGE_REVIEWS_SPENT=0; TRIAGE_PROBE_FAILURES=0
TRIAGE_FILE=$(triage_state_file 22 32)
triage_state_save "$TRIAGE_FILE" 22 32 complete
printf '%s\n' '{}' >"$MFSTATE/merge-queue/.marker-pr32.json"
triage 22 32 false
check "dotfile marker is not a live queue entry" 0 "$?"
check "dotfile marker still triggers the revalidation review" 1 "$ESC_REVIEW_CALLS"
rm -f "$MFSTATE/merge-queue/.marker-pr32.json"

# Non-numeric or leading-zero budget knobs normalize at source time.
check "non-numeric revalidation knob falls back to default" 3 \
  "$( (MF_REVALIDATE_MAX=off; . ./worker.sh >/dev/null 2>&1; printf %s "$MF_REVALIDATE_MAX") )"
check "leading-zero revalidation knob normalizes decimal" 7 \
  "$( (MF_REVALIDATE_MAX=07; . ./worker.sh >/dev/null 2>&1; printf %s "$MF_REVALIDATE_MAX") )"

echo "— queue write acknowledgement + CI-fix approval invalidation"
# Restore production worker helpers after the stage-resume stubs above.
. ./worker.sh
check "mixed success and empty-conclusion in-progress checks stay pending" pending \
  "$(ci_rollup_state <<<'[{"conclusion":"SUCCESS","status":"COMPLETED"},{"conclusion":"","status":"IN_PROGRESS"}]')"
check "only explicit terminal success states are green" green \
  "$(ci_rollup_state <<<'[{"conclusion":"SUCCESS","status":"COMPLETED"},{"conclusion":"NEUTRAL","status":"COMPLETED"},{"conclusion":"SKIPPED","status":"COMPLETED"}]')"
check "legacy error status is red" red \
  "$(ci_rollup_state <<<'[{"state":"ERROR"}]')"
check "requested check stays pending" pending \
  "$(ci_rollup_state <<<'[{"status":"REQUESTED"}]')"
check "unknown check state fails closed as pending" pending \
  "$(ci_rollup_state <<<'[{"status":"BANANA"}]')"
check "stale conclusion is red" red \
  "$(ci_rollup_state <<<'[{"conclusion":"STALE","status":"COMPLETED"}]')"
check "completed without a conclusion stays pending" pending \
  "$(ci_rollup_state <<<'[{"conclusion":"","status":"COMPLETED"}]')"
malformed_rollup(){ ci_rollup_state <<<'not-an-array' >/dev/null 2>&1; }
expect_fail "malformed check rollup fails closed" malformed_rollup
AF=$MFSTATE/assignments/worker-9.json
printf '%s\n' '{"issue":9,"touches":[]}' >"$AF"
rm -f "$MFSTATE/merge-queue"/*
atomic_write(){ return 1; }
enqueue_merge 10 9 abc reviewer 2
check "failed atomic queue write is reported" 1 "$?"

# Reproduce the live PR #715 shape: one successful check plus one in-progress
# check whose conclusion is the empty string. The queue must remain untouched,
# and merger_step must not call GitHub's merge endpoint.
atomic_write(){
  local tmp
  tmp=$(mktemp "$(dirname "$1")/.tmp.XXXXXX") || return 1
  printf '%s\n' "$2" >"$tmp" && mv -f "$tmp" "$1"
}
printf '%s\n' '{"pr":14,"issue":14,"touches":[],"approved_head":"abc","approval_kind":"reviewer","approval_comment_id":"14"}' >"$MFSTATE/merge-queue/1-pr14.json"
MERGES=0
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      statusCheckRollup)
        echo '[{"conclusion":"SUCCESS","status":"COMPLETED"},{"conclusion":"","status":"IN_PROGRESS"}]'
        ;;
    esac
    return 0
  fi
  [ "$1 $2" = "pr merge" ] && { MERGES=$((MERGES+1)); return 0; }
  return 0
}
queue_approval_check(){ QUEUE_APPROVAL_STATE=valid; return 0; }
merger_step
check "mixed pending rollup retains its merge-queue record" 1 \
  "$(find "$MFSTATE/merge-queue" -name '*-pr14.json' | wc -l | tr -d ' ')"
check "mixed pending rollup never invokes merge" 0 "$MERGES"
rm -f "$MFSTATE/merge-queue/1-pr14.json"

# Restore a queue and drive the merger with deterministic stubs. A CI-fix push
# must dequeue/requeue for review and must never call merge on the stale approval.
rm -f "$MFSTATE/merge-queue"/* "$MFSTATE/ci-fix"/*
printf '%s\n' '{"pr":10,"issue":9,"touches":[],"approved_head":"abc","approval_kind":"reviewer","approval_comment_id":"2"}' >"$MFSTATE/merge-queue/2-pr10.json"
MERGES=0; CIFIX_CALLS=0; HUMANS=0; PR10_HEAD=abc; PR13_HEAD=abc
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      statusCheckRollup) echo '[{"conclusion":"FAILURE","status":"COMPLETED"}]';;
    esac
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
