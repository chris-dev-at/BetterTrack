#!/usr/bin/env bash
# Offline ClaudeX provider/runtime regression tests. No Docker daemon, OAuth
# credential, CCR service, network request, or model request is used.
set -uo pipefail
cd "$(dirname "$0")"

T=$(mktemp -d)
trap 'if [ "${BASH_SUBSHELL:-0}" -eq 0 ]; then rm -rf "$T"; fi' EXIT
PASS=0
FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }
check(){
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi
}

REAL_NODE=$(command -v node)
ORIGINAL_PATH=$PATH
mkdir -p "$T/bin" "$T/state/control" "$T/repo"

cat >"$T/bin/timeout" <<'STUB'
#!/usr/bin/env bash
shift
exec "$@"
STUB

cat >"$T/bin/node" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$NODE_CALLS"
case "$1" in
  *ccr-ensure.mjs)
    [ "${NODE_ENSURE_CASE:-ok}" = fail ] && exit 1
    exit 0
    ;;
  *claudex-direct-probe.mjs)
    count=0
    [ -f "$PROBE_COUNT_FILE" ] && count=$(cat "$PROBE_COUNT_FILE")
    count=$((count+1))
    printf '%s\n' "$count" >"$PROBE_COUNT_FILE"
    if [ "${DIRECT_PROBE_CASE:-ok}" = first-fails ] && [ "$count" -eq 1 ]; then
      exit 1
    fi
    exit "${DIRECT_PROBE_RC:-0}"
    ;;
esac
exit 1
STUB

cat >"$T/bin/ccr" <<'STUB'
#!/usr/bin/env bash
count=0
[ -f "$CCR_COUNT_FILE" ] && count=$(cat "$CCR_COUNT_FILE")
count=$((count+1))
printf '%s\n' "$count" >"$CCR_COUNT_FILE"
printf '%q ' "$@" >>"$CCR_ARGS_FILE"
printf '\n' >>"$CCR_ARGS_FILE"
if [ -n "${OPENAI_API_KEY:-}" ] || [ -n "${CODEX_API_KEY:-}" ] \
  || [ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] \
  || [ -n "${ANTHROPIC_BASE_URL:-}" ] \
  || [ -n "${ANTHROPIC_API_BASE_URL:-}" ] \
  || [ -n "${ANTHROPIC_MODEL:-}" ] \
  || [ -n "${ANTHROPIC_SMALL_FAST_MODEL:-}" ] \
  || [ -n "${CLAUDE_AGENT_API_BASE_URL:-}" ] \
  || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] \
  || [ -n "${CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY:-}" ] \
  || [ -n "${CLAUDE_CODE_USE_BEDROCK:-}" ] \
  || [ -n "${CLAUDE_CODE_USE_FOUNDRY:-}" ] \
  || [ -n "${CLAUDE_CODE_USE_VERTEX:-}" ]; then
  printf 'leaked\n' >>"$CCR_ENV_LEAK_FILE"
fi

ok_result(){
  printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"CLAUDEX_OK","terminal_reason":"completed","api_error_status":null,"num_turns":1,"total_cost_usd":0.121905,"usage":{"input_tokens":22,"output_tokens":6,"cache_read_input_tokens":2,"cache_creation_input_tokens":1},"modelUsage":{"codex-api/gpt-5.6-sol":{"inputTokens":22,"outputTokens":6,"cacheReadInputTokens":2,"cacheCreationInputTokens":1,"costUSD":0.121905,"contextWindow":1050000,"account":"must-not-persist"}}}'
}

case "${CLAUDEX_CASE:-ok}" in
  ok) ok_result; exit 0;;
  missing-cost)
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"CLAUDEX_OK","terminal_reason":"completed","api_error_status":null,"usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"codex-api/gpt-5.6-sol":{"inputTokens":3,"outputTokens":2}}}'
    exit 0;;
  wrong-model)
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"CLAUDEX_OK","terminal_reason":"completed","api_error_status":null,"total_cost_usd":0.1,"usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"codex-api/gpt-5.6-luna":{"inputTokens":3,"outputTokens":2}}}'
    exit 0;;
  wrong-reply)
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"result":"WRONG","terminal_reason":"completed","api_error_status":null,"total_cost_usd":0.1,"usage":{"input_tokens":3,"output_tokens":2},"modelUsage":{"codex-api/gpt-5.6-sol":{"inputTokens":3,"outputTokens":2}}}'
    exit 0;;
  router-then-ok)
    if [ "$count" -eq 1 ]; then
      printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"OAuth gateway failed ccr_web_token=TOPSECRET Bearer TOPBEARER","terminal_reason":"api_error","api_error_status":401,"modelUsage":{"codex-api/gpt-5.6-sol":{}}}'
      exit 1
    fi
    ok_result
    exit 0;;
  secrets)
    printf '%s\n' \
      'X-CCR-Web-Auth: HEADER_AUTH_SENTINEL' \
      'AUTHORIZATION: Bearer BEARER_SENTINEL' \
      'Authorization: Basic BASIC_SENTINEL' \
      'aUtHoRiZaTiOn: Token68 ARBITRARY_AUTH_SENTINEL' \
      'authorization-credential-echo=BASIC_SENTINEL' \
      'Access_Token: ACCESS_HEADER_SENTINEL' \
      'Refresh-Token=REFRESH_HEADER_SENTINEL' \
      'iD-ToKeN=ID_TOKEN_PLAIN_SENTINEL' \
      'cLiEnT-SeCrEt: CLIENT_SECRET_SENTINEL' \
      'x-api-key: X_API_SENTINEL' \
      'api_key=API_KEY_SENTINEL' \
      'http://127.0.0.1:3458/?ccr_web_token=CCR_URL_SENTINEL&safe=1' \
      'https://example.invalid/callback?access_token=REMOTE_URL_SENTINEL' \
      'https://example.invalid/callback?X-CCR-WEB-AUTH=QUERY_AUTH_SENTINEL' \
      'https://example.invalid/callback?Authorization=Bearer%20QUERY_BEARER_SENTINEL' \
      '{"ACCESS_TOKEN":"JSON_ACCESS_SENTINEL","refreshToken":"JSON_REFRESH_SENTINEL","echo":"JSON_ACCESS_SENTINEL","modelUsage":{"codex-api/gpt-5.6-sol":{"inputTokens":22}}}' \
      '{"Id_ToKeN":"ID_TOKEN_SENTINEL","echo":"ID_TOKEN_SENTINEL","result":"benign-id-token-telemetry"}' \
      '"{\"ClIeNt_SeCrEt\":\"CLIENT_SECRET_SENTINEL\",\"echo\":\"CLIENT_SECRET_SENTINEL\",\"result\":\"benign-client-telemetry\"}"' \
      '"{\"AuThOrIzAtIoN\":\"Basic ESCAPED_BASIC_SENTINEL\",\"echo\":\"ESCAPED_BASIC_SENTINEL\",\"result\":\"benign-auth-escaped\"}"' \
      '"{\"X-CCR-Web-Auth\":\"ESCAPED_AUTH_SENTINEL\",\"result\":\"benign-escaped-telemetry\"}"' \
      'nested={\\\"refresh_token\\\":\\\"DOUBLE_ESCAPE_SENTINEL\\\"}' \
      'Authorization: [redacted]' \
      '{"id_token":"[redacted]","client_secret":"[redacted]","result":"benign-redacted-json"}' \
      '"{\"Authorization\":\"[redacted]\",\"id_token\":\"[redacted]\",\"result\":\"benign-redacted-escaped\"}"'
    ok_result
    exit 0;;
  limit-then-ok)
    if [ "$count" -eq 1 ]; then
      printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Codex usage limit reached HTTP 429","terminal_reason":"api_error","api_error_status":429,"modelUsage":{"codex-api/gpt-5.6-sol":{}}}'
      exit 1
    fi
    ok_result
    exit 0;;
  incomplete)
    printf '%s\n' '{"type":"system","subtype":"init"}'
    exit 7;;
esac
STUB
chmod +x "$T/bin/timeout" "$T/bin/node" "$T/bin/ccr"

export PATH=$T/bin:$ORIGINAL_PATH
export MFSTATE=$T/state STATE=$T/cstate REPO_DIR=$T/repo LOG=$T/provider.log
export REPO=stub/repo MF_DRY_RUN=0
export MF_NODE_BIN=node MF_CCR_BIN=ccr
export MF_CCR_ENSURE_SCRIPT=$T/ccr-ensure.mjs
export MF_CCR_PROBE_SCRIPT=$T/claudex-direct-probe.mjs
export MF_CLAUDEX_REDACTOR_SCRIPT=$PWD/claudex-redact.mjs
export MF_REDACTOR_NODE_BIN=$REAL_NODE
export MF_CCR_PROFILE=bettertrack-factory-claudex
export NODE_CALLS=$T/node.calls CCR_COUNT_FILE=$T/ccr.count
export PROBE_COUNT_FILE=$T/probe.count
export CCR_ARGS_FILE=$T/ccr.args CCR_ENV_LEAK_FILE=$T/env.leak
export MF_PROVIDER_RETRY_SLEEP=0 CC_TRANSIENT_SLEEP=0 LIMIT_SLEEP=0
export MF_ROLE_TIMEOUT=5
export OPENAI_API_KEY=SECRET_OPENAI
export CODEX_API_KEY=SECRET_CODEX
export ANTHROPIC_API_KEY=SECRET_ANTHROPIC
export ANTHROPIC_AUTH_TOKEN=SECRET_ANTHROPIC_AUTH
export ANTHROPIC_BASE_URL=https://stale-anthropic.invalid
export ANTHROPIC_API_BASE_URL=https://stale-anthropic.invalid
export ANTHROPIC_MODEL=stale-model
export ANTHROPIC_SMALL_FAST_MODEL=stale-fast-model
export CLAUDE_AGENT_API_BASE_URL=https://stale-anthropic.invalid
export CLAUDE_CODE_OAUTH_TOKEN=SECRET_CLAUDE_OAUTH
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=0
export CLAUDE_CODE_USE_BEDROCK=1
export CLAUDE_CODE_USE_FOUNDRY=1
export CLAUDE_CODE_USE_VERTEX=1

log(){ printf '%s\n' "$*" >>"$LOG"; }
notify(){ printf '%s\n' "$*" >>"$LOG"; }
ledger_record(){
  LAST_LEDGER_RES=$4
  LAST_LEDGER_OUTCOME=$6
  printf '%s\n' "$6" >>"$T/ledger.outcomes"
}
cc_classify(){ echo genuine; }
TRANSIENT_RE='Connection closed mid-response|ECONNRESET|ETIMEDOUT|stream disconnected|socket hang up|fetch failed|Premature close|EAI_AGAIN'
. ./mflib.sh

reset_case(){
  rm -f "$CCR_COUNT_FILE" "$CCR_ARGS_FILE" "$CCR_ENV_LEAK_FILE" \
    "$PROBE_COUNT_FILE" "$NODE_CALLS" "$T/ledger.outcomes" "$LOG"
  LAST_LEDGER_RES=""
  LAST_LEDGER_OUTCOME=""
  NODE_ENSURE_CASE=ok
  DIRECT_PROBE_CASE=ok
  DIRECT_PROBE_RC=0
  export NODE_ENSURE_CASE DIRECT_PROBE_CASE DIRECT_PROBE_RC
}

echo "— ClaudeX runner success, isolation and telemetry"
reset_case
CLAUDEX_CASE=ok
MF_PROVIDER_ATTEMPTS=1
export CLAUDEX_CASE MF_PROVIDER_ATTEMPTS
cc_claudex gpt-5.6-sol high prompt
check "ClaudeX success rc" 0 "$?"
check "ClaudeX success ledger outcome" ok "$LAST_LEDGER_OUTCOME"
check "ClaudeX ledger provider" claudex "$(jq -r .provider <<<"$LAST_LEDGER_RES")"
check "ClaudeX actual subscription spend normalized to zero" 0 \
  "$(jq -r .total_cost_usd <<<"$LAST_LEDGER_RES")"
check "ClaudeX preserves Claude Code API-equivalent estimate" 0.121905 \
  "$(jq -r .api_equivalent_usd <<<"$LAST_LEDGER_RES")"
check "ClaudeX estimate source is explicit" claude-code-total_cost_usd \
  "$(jq -r .api_equivalent_source <<<"$LAST_LEDGER_RES")"
check "ClaudeX aggregate input tokens preserved" 22 \
  "$(jq -r .usage.input_tokens <<<"$LAST_LEDGER_RES")"
check "ClaudeX aggregate output tokens preserved" 6 \
  "$(jq -r .usage.output_tokens <<<"$LAST_LEDGER_RES")"
check "ClaudeX per-model numeric telemetry preserved" 1050000 \
  "$(jq -r '.model_usage["codex-api/gpt-5.6-sol"].contextWindow' <<<"$LAST_LEDGER_RES")"
check "ClaudeX per-model string/account metadata scrubbed" null \
  "$(jq -r '.model_usage["codex-api/gpt-5.6-sol"].account // null' <<<"$LAST_LEDGER_RES")"
grep -q -- 'bettertrack-factory-claudex cli' "$CCR_ARGS_FILE" \
  && ok "ClaudeX uses isolated CCR profile" || bad "ClaudeX profile missing"
grep -q -- '--model codex-api/gpt-5.6-sol' "$CCR_ARGS_FILE" \
  && ok "ClaudeX passes explicit prefixed model" || bad "ClaudeX explicit model missing"
grep -q -- '--output-format stream-json' "$CCR_ARGS_FILE" \
  && ok "ClaudeX keeps stream-json transport" || bad "ClaudeX stream-json missing"
grep -q -- '--verbose' "$CCR_ARGS_FILE" \
  && ok "ClaudeX keeps verbose result events" || bad "ClaudeX verbose missing"
grep -q -- '--dangerously-skip-permissions' "$CCR_ARGS_FILE" \
  && ok "ClaudeX keeps factory permission mode" || bad "ClaudeX permission mode missing"
check "ClaudeX subprocess receives no provider API/OAuth env" 0 \
  "$([ -e "$CCR_ENV_LEAK_FILE" ] && echo 1 || echo 0)"

echo "— ClaudeX durable-log secret redaction"
reset_case
CLAUDEX_CASE=secrets
MF_PROVIDER_ATTEMPTS=1
export CLAUDEX_CASE MF_PROVIDER_ATTEMPTS
cc_claudex gpt-5.6-sol high prompt
check "adversarial secret fixture still yields a valid result" 0 "$?"
check "no literal secret sentinel survives in the durable log" 0 \
  "$(grep -Ec \
    'HEADER_AUTH_SENTINEL|BEARER_SENTINEL|BASIC_SENTINEL|ESCAPED_BASIC_SENTINEL|ARBITRARY_AUTH_SENTINEL|ACCESS_HEADER_SENTINEL|REFRESH_HEADER_SENTINEL|CLIENT_SECRET_SENTINEL|ID_TOKEN_SENTINEL|ID_TOKEN_PLAIN_SENTINEL|X_API_SENTINEL|API_KEY_SENTINEL|CCR_URL_SENTINEL|REMOTE_URL_SENTINEL|QUERY_AUTH_SENTINEL|QUERY_BEARER_SENTINEL|JSON_ACCESS_SENTINEL|JSON_REFRESH_SENTINEL|ESCAPED_AUTH_SENTINEL|DOUBLE_ESCAPE_SENTINEL' \
    "$LOG" 2>/dev/null || true)"
check "Authorization values are entirely redacted for every scheme" 0 \
  "$(grep -Eic 'authorization[^[:cntrl:]]*(Bearer|Basic|Token68)' "$LOG" || true)"
check "already-redacted placeholders never grow closing brackets" 0 \
  "$(grep -Ec '\[redacted\]\]+' "$LOG" || true)"
grep -q '\[redacted-url\]' "$LOG" \
  && ok "token-bearing and CCR service URLs are redacted" \
  || bad "sensitive URLs survived or were not marked"
grep -q 'codex-api/gpt-5.6-sol' "$LOG" \
  && ok "benign model telemetry survives redaction" \
  || bad "benign model telemetry was destroyed"
grep -q 'inputTokens' "$LOG" \
  && ok "benign token-count telemetry survives redaction" \
  || bad "benign token-count telemetry was destroyed"
grep -q 'benign-escaped-telemetry' "$LOG" \
  && ok "benign escaped JSON content survives redaction" \
  || bad "benign escaped JSON content was destroyed"
grep -q 'benign-id-token-telemetry' "$LOG" \
  && ok "benign ID-token-adjacent telemetry survives redaction" \
  || bad "benign ID-token-adjacent telemetry was destroyed"
grep -q 'benign-client-telemetry' "$LOG" \
  && ok "benign client-secret-adjacent telemetry survives redaction" \
  || bad "benign client-secret-adjacent telemetry was destroyed"
grep -q 'benign-auth-escaped' "$LOG" \
  && ok "benign escaped Authorization telemetry survives redaction" \
  || bad "benign escaped Authorization telemetry was destroyed"
"$REAL_NODE" "$MF_CLAUDEX_REDACTOR_SCRIPT" <"$LOG" >"$T/provider.redacted-again"
if cmp -s "$LOG" "$T/provider.redacted-again"; then
  ok "redaction is byte-idempotent across repeated passes"
else
  bad "redaction changed an already-redacted durable log"
fi

rm -f "$T/claudex-ledger.jsonl"
CLAUDEX_LEDGER_RES=$LAST_LEDGER_RES LEDGER=$T/claudex-ledger.jsonl \
  FACTORY_NAME=multi WORKER_ID=2 \
  /bin/bash -c '. ../factory/lib.sh; ledger_record 42 writer gpt-5.6-sol "$CLAUDEX_LEDGER_RES" 4 ok'
LEDGER_ROW=$(<"$T/claudex-ledger.jsonl")
check "persisted ClaudeX actual spend remains zero" 0 "$(jq -r .cost_usd <<<"$LEDGER_ROW")"
check "persisted ClaudeX provider family" openai "$(jq -r .provider_family <<<"$LEDGER_ROW")"
check "persisted ClaudeX harness" claude-code "$(jq -r .harness <<<"$LEDGER_ROW")"
check "persisted ClaudeX billing mode" subscription "$(jq -r .billing <<<"$LEDGER_ROW")"
check "persisted ClaudeX estimate remains separate" 0.121905 \
  "$(jq -r .api_equivalent_usd <<<"$LEDGER_ROW")"
LEDGER=$T/claudex-ledger.jsonl LOG=$T/cost.log \
  /bin/bash -c '. ../factory/lib.sh; log(){ printf "%s\n" "$*" >>"$LOG"; }; issue_cost 42'
grep -q '0.00 actual' "$T/cost.log" \
  && ok "issue cost labels actual spend separately" || bad "actual cost label missing"
grep -q '0.12 API-equivalent' "$T/cost.log" \
  && ok "issue cost labels API-equivalent separately" || bad "API-equivalent label missing"

echo "— ClaudeX retry/result contracts"
reset_case
CLAUDEX_CASE=router-then-ok
MF_PROVIDER_ATTEMPTS=2
export CLAUDEX_CASE MF_PROVIDER_ATTEMPTS
cc_claudex gpt-5.6-sol high prompt
check "router/auth failure rebootstrap recovers" 0 "$?"
check "router/auth path invokes Claude twice" 2 "$(cat "$CCR_COUNT_FILE")"
grep -q -- '--force' "$NODE_CALLS" \
  && ok "router/auth path performs one forced rebootstrap" \
  || bad "router/auth path missed forced rebootstrap"
check "router secret is redacted from durable log" 0 \
  "$(grep -c 'TOPSECRET\\|TOPBEARER' "$LOG" 2>/dev/null || true)"

reset_case
CLAUDEX_CASE=limit-then-ok
MF_PROVIDER_ATTEMPTS=2
export CLAUDEX_CASE MF_PROVIDER_ATTEMPTS
cc_claudex gpt-5.6-sol high prompt
check "subscription limit waits/retries to success" 0 "$?"
check "subscription limit invokes Claude twice" 2 "$(cat "$CCR_COUNT_FILE")"
grep -q '^retry$' "$T/ledger.outcomes" \
  && ok "subscription limit is ledgered as retry" || bad "limit retry ledger missing"

reset_case
CLAUDEX_CASE=wrong-model
MF_PROVIDER_ATTEMPTS=1
export CLAUDEX_CASE MF_PROVIDER_ATTEMPTS
if cc_claudex gpt-5.6-sol high prompt; then
  bad "wrong modelUsage must fail"
else
  ok "wrong modelUsage fails"
fi
check "wrong modelUsage ledger outcome" fail "$LAST_LEDGER_OUTCOME"

reset_case
CLAUDEX_CASE=missing-cost
MF_PROVIDER_ATTEMPTS=1
export CLAUDEX_CASE MF_PROVIDER_ATTEMPTS
cc_claudex gpt-5.6-sol high prompt
check "missing estimate still allows valid role result" 0 "$?"
check "missing estimate is null, never false zero" null \
  "$(jq -r .api_equivalent_usd <<<"$LAST_LEDGER_RES")"
check "missing estimate coverage is explicit" missing-telemetry \
  "$(jq -r .api_equivalent_coverage <<<"$LAST_LEDGER_RES")"

reset_case
CLAUDEX_CASE=incomplete
MF_PROVIDER_ATTEMPTS=1
DIRECT_PROBE_RC=0
export CLAUDEX_CASE MF_PROVIDER_ATTEMPTS DIRECT_PROBE_RC
if cc_claudex gpt-5.6-sol high prompt; then
  bad "incomplete result must fail"
else
  ok "incomplete result fails"
fi
grep -q 'claudex-direct-probe.mjs' "$NODE_CALLS" \
  && ok "ambiguous failure probes CCR/Codex directly" \
  || bad "ambiguous failure skipped direct provider probe"

reset_case
MF_DRY_RUN=1
CLAUDEX_CASE=ok
export MF_DRY_RUN CLAUDEX_CASE
cc_claudex gpt-5.6-sol high prompt
check "ClaudeX dry-run returns success without transport" 0 "$?"
check "ClaudeX dry-run makes no ensure/probe call" 0 \
  "$([ -e "$NODE_CALLS" ] && wc -l <"$NODE_CALLS" | tr -d ' ' || echo 0)"
check "ClaudeX dry-run makes no model call" 0 \
  "$([ -e "$CCR_COUNT_FILE" ] && cat "$CCR_COUNT_FILE" || echo 0)"
MF_DRY_RUN=0
export MF_DRY_RUN

echo "— strict provider routing"
cat >"$MFSTATE/control/models.json" <<'JSON'
{"difficulties":{
  "easy":{"provider":"claudex","model":"gpt-5.6-luna","effort":"high"},
  "normal":{"provider":"pigeon","model":"carrier","effort":"high"},
  "hard":{"provider":"claudex","model":"gpt-5.6-sol|claude","effort":"high"},
  "max":{"provider":"claudex","model":"gpt-5.6-sol","effort":"high|low"}}}
JSON
check "ClaudeX config entry is accepted" "claudex|gpt-5.6-luna|high" "$(diff_cfg easy)"
check "unknown provider remains explicit" "invalid|pigeon|" "$(diff_cfg normal)"
check "model delimiter injection fails closed" "invalid|claudex|" "$(diff_cfg hard)"
check "effort delimiter injection fails closed" "invalid|claudex|" "$(diff_cfg max)"
reset_case
if mf_cc writer normal prompt; then
  bad "unknown provider must not fall through to Claude"
else
  ok "unknown provider fails closed"
fi
check "unknown provider makes no ClaudeX call" 0 \
  "$([ -e "$CCR_COUNT_FILE" ] && cat "$CCR_COUNT_FILE" || echo 0)"

echo "— sanitized provider-test public contract"
printf '%s\n' \
  '{"models":["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"]}' \
  >"$T/factory-status.json"
reset_case
CLAUDEX_CASE=ok
export CLAUDEX_CASE
PROVIDER_STDOUT=$(
  CCR_STATUS_FILE=$T/factory-status.json \
  MF_NODE_BIN=node MF_CCR_BIN=ccr \
  MF_CCR_ENSURE_SCRIPT=$T/ccr-ensure.mjs \
  MF_CCR_PROBE_SCRIPT=$T/claudex-direct-probe.mjs \
  ./provider-test.sh claudex gpt-5.6-sol high
)
check "provider test emits exactly one stdout line" 1 \
  "$(printf '%s\n' "$PROVIDER_STDOUT" | wc -l | tr -d ' ')"
check "provider test success flag" true "$(jq -r .ok <<<"$PROVIDER_STDOUT")"
check "provider test exact selector" codex-api/gpt-5.6-sol \
  "$(jq -r .model <<<"$PROVIDER_STDOUT")"
check "provider test exact modelUsage proof" codex-api/gpt-5.6-sol \
  "$(jq -r '.modelUsage[0]' <<<"$PROVIDER_STDOUT")"
check "provider test reports runtime ready" true \
  "$(jq -r .runtimeReady <<<"$PROVIDER_STDOUT")"
check "provider test output omits raw assistant text" 0 \
  "$(grep -c 'CLAUDEX_OK' <<<"$PROVIDER_STDOUT" || true)"

reset_case
CLAUDEX_CASE=ok
DIRECT_PROBE_CASE=first-fails
export CLAUDEX_CASE DIRECT_PROBE_CASE
PROVIDER_RETRY_STDOUT=$(
  CCR_STATUS_FILE=$T/factory-status.json \
  MF_NODE_BIN=node MF_CCR_BIN=ccr \
  MF_CCR_ENSURE_SCRIPT=$T/ccr-ensure.mjs \
  MF_CCR_PROBE_SCRIPT=$T/claudex-direct-probe.mjs \
  ./provider-test.sh claudex gpt-5.6-sol high
)
check "provider test recovers one fresh-bootstrap direct-probe race" true \
  "$(jq -r .ok <<<"$PROVIDER_RETRY_STDOUT")"
check "provider test retries the direct proof exactly once" 2 \
  "$(<"$PROBE_COUNT_FILE")"
grep -qx -- "$T/ccr-ensure.mjs --force" "$NODE_CALLS" \
  && ok "provider test force-refreshes CCR before its one retry" \
  || bad "provider test must force-refresh CCR before retrying"

reset_case
DIRECT_PROBE_RC=1
export DIRECT_PROBE_RC
if PROVIDER_DIRECT_BAD=$(
  CCR_STATUS_FILE=$T/factory-status.json \
  MF_NODE_BIN=node MF_CCR_BIN=ccr \
  MF_CCR_ENSURE_SCRIPT=$T/ccr-ensure.mjs \
  MF_CCR_PROBE_SCRIPT=$T/claudex-direct-probe.mjs \
  ./provider-test.sh claudex gpt-5.6-sol high 2>"$T/provider-direct.err"
); then
  bad "provider test must fail after its one direct-proof retry"
else
  ok "provider test fails closed after its one direct-proof retry"
fi
check "persistent direct failure remains bounded to two probes" 2 \
  "$(<"$PROBE_COUNT_FILE")"
check "persistent direct failure emits no stdout JSON" "" "$PROVIDER_DIRECT_BAD"

reset_case
CLAUDEX_CASE=wrong-reply
export CLAUDEX_CASE
if PROVIDER_BAD=$(
  CCR_STATUS_FILE=$T/factory-status.json \
  MF_NODE_BIN=node MF_CCR_BIN=ccr \
  MF_CCR_ENSURE_SCRIPT=$T/ccr-ensure.mjs \
  MF_CCR_PROBE_SCRIPT=$T/claudex-direct-probe.mjs \
  ./provider-test.sh claudex gpt-5.6-sol high 2>"$T/provider.err"
); then
  bad "provider test must reject an otherwise-valid wrong reply"
else
  ok "provider test rejects an otherwise-valid wrong reply"
fi
check "failed provider test emits no stdout JSON" "" "$PROVIDER_BAD"
check "failed provider test stderr is sanitized" 0 \
  "$(grep -c 'WRONG\\|SECRET_\\|ccr_web_token\\|api-key' "$T/provider.err" || true)"

echo "— CCR bootstrap normalization"
if "$REAL_NODE" ./ccr-bootstrap-test.mjs >"$T/bootstrap-test.out" 2>"$T/bootstrap-test.err"; then
  ok "bootstrap pure tests pass"
else
  bad "bootstrap pure tests failed"
  sed 's/^/    /' "$T/bootstrap-test.err"
fi
if "$REAL_NODE" ./ccr-ensure-test.mjs >"$T/ensure-test.out" 2>"$T/ensure-test.err"; then
  ok "status command is sanitized and makes no model request"
else
  bad "status command offline proof failed"
  sed 's/^/    /' "$T/ensure-test.err"
fi

echo "— Compose auth isolation, override and generated workers"
L=$T/launcher
mkdir -p "$L/multi-factory" "$L/factory" "$L/home/.codex" "$L/overlay dir"
cp autorun.sh compose.yml "$L/multi-factory/"
touch "$L/factory/.env"
printf '%s\n' '{"auth_mode":"fixture"}' >"$L/home/.codex/auth.json"
printf '%s\n' '{"models":[]}' >"$L/home/.codex/models_cache.json"
printf '%s\n' 'name: hostile-overlay' 'services: {}' >"$L/overlay dir/runtime.yml"
cat >"$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
[ "$1" = info ] && exit 0
printf '%s' "$1" >>"$DOCKER_CALLS"
printf '<project-env:%s>' "${COMPOSE_PROJECT_NAME-__unset__}" >>"$DOCKER_CALLS"
shift
for arg in "$@"; do printf '<%s>' "$arg" >>"$DOCKER_CALLS"; done
printf '\n' >>"$DOCKER_CALLS"
exit 0
STUB
chmod +x "$T/bin/docker"
export DOCKER_CALLS=$T/docker.calls
OVERRIDE="$L/overlay dir/runtime.yml"
OVERRIDE_CANON=$(cd "$(dirname "$OVERRIDE")" && pwd -P)/$(basename "$OVERRIDE")
(
  cd "$L"
  COMPOSE_PROJECT_NAME=hostile-env HOME="$L/home" \
    PATH="$T/bin:$ORIGINAL_PATH" WORKERS=4 \
    MF_COMPOSE_OVERRIDE="$OVERRIDE" \
    MF_MODELS_FILE=/work/mfstate/control/acceptance-models.json \
    ./multi-factory/autorun.sh --dry >/dev/null
)
for service in master worker-1 worker-2 worker-3 worker-4; do
  if [ -d "$L/multi-factory/auth/$service/ccr" ]; then
    ok "$service has independent CCR state"
  else
    bad "$service missing CCR state"
  fi
  if [ -f "$L/multi-factory/auth/$service/codex/auth.json" ] \
    && [ -f "$L/multi-factory/auth/$service/codex/models_cache.json" ]; then
    ok "$service receives Codex auth + optional model cache"
  else
    bad "$service missing Codex auth/model cache"
  fi
done
check "base Compose defines three independent CCR mounts" 3 \
  "$(grep -c ':/home/factory/.claude-code-router' compose.yml)"
check "generated Compose defines worker 3/4 CCR mounts" 2 \
  "$(grep -c ':/home/factory/.claude-code-router' "$L/multi-factory/compose.extra.yml")"
check "base Compose mounts the redactor into every service" 3 \
  "$(grep -c './claudex-redact.mjs:/work/mf/claudex-redact.mjs:ro' compose.yml)"
check "generated Compose mounts the redactor into worker 3/4" 2 \
  "$(grep -c './claudex-redact.mjs:/work/mf/claudex-redact.mjs:ro' \
    "$L/multi-factory/compose.extra.yml")"
grep -q 'MF_MODELS_FILE:' compose.yml \
  && ok "base Compose plumbs MF_MODELS_FILE" || bad "base MF_MODELS_FILE missing"
grep -q 'MF_MODELS_FILE:' "$L/multi-factory/compose.extra.yml" \
  && ok "generated workers plumb MF_MODELS_FILE" || bad "generated MF_MODELS_FILE missing"
check "override is preserved for dry build/up/ps" 3 \
  "$(grep -Fc "<$OVERRIDE_CANON>" "$DOCKER_CALLS")"
(
  cd "$L"
  COMPOSE_PROJECT_NAME=hostile-env HOME="$L/home" \
    PATH="$T/bin:$ORIGINAL_PATH" WORKERS=4 \
    MF_COMPOSE_OVERRIDE="$OVERRIDE" ./multi-factory/autorun.sh --stop >/dev/null
  COMPOSE_PROJECT_NAME=hostile-env HOME="$L/home" \
    PATH="$T/bin:$ORIGINAL_PATH" WORKERS=4 \
    MF_COMPOSE_OVERRIDE="$OVERRIDE" ./multi-factory/autorun.sh --down >/dev/null
  COMPOSE_PROJECT_NAME=hostile-env HOME="$L/home" \
    PATH="$T/bin:$ORIGINAL_PATH" WORKERS=4 \
    MF_COMPOSE_OVERRIDE="$OVERRIDE" ./multi-factory/autorun.sh --logs >/dev/null
  COMPOSE_PROJECT_NAME=hostile-env HOME="$L/home" \
    PATH="$T/bin:$ORIGINAL_PATH" WORKERS=4 \
    MF_COMPOSE_OVERRIDE="$OVERRIDE" ./multi-factory/autorun.sh --fresh >/dev/null
  COMPOSE_PROJECT_NAME=hostile-env HOME="$L/home" \
    PATH="$T/bin:$ORIGINAL_PATH" WORKERS=4 \
    MF_COMPOSE_OVERRIDE="$OVERRIDE" ./multi-factory/autorun.sh --login-gemini >/dev/null
)
COMPOSE_CALLS=$(grep '^compose' "$DOCKER_CALLS" || true)
check "every Compose lifecycle call pins the canonical project" 0 \
  "$(printf '%s\n' "$COMPOSE_CALLS" |
    grep -vc '<--project-name><bettertrack-multifactory>' || true)"
check "every Compose lifecycle call clears the inherited project env" 0 \
  "$(printf '%s\n' "$COMPOSE_CALLS" | grep -vc '<project-env:__unset__>' || true)"
check "hostile project names never reach a Compose invocation" 0 \
  "$(printf '%s\n' "$COMPOSE_CALLS" | grep -Ec 'hostile-env|hostile-overlay' || true)"
for verb in build up down stop logs config ps; do
  grep -q "<$verb>" <<<"$COMPOSE_CALLS" \
    && ok "canonical Compose helper covers $verb" \
    || bad "canonical Compose helper missed $verb"
done
if (
  cd "$L"
  HOME="$L/home" PATH="$T/bin:$ORIGINAL_PATH" \
    MF_COMPOSE_OVERRIDE="$L/missing.yml" \
    ./multi-factory/autorun.sh --stop >/dev/null 2>&1
); then
  bad "missing Compose override must fail closed"
else
  ok "missing Compose override fails closed"
fi

echo
echo "ClaudeX passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
