#!/usr/bin/env bash
# Provider smoke contract used by the control plane. Success writes exactly one
# sanitized JSON object to stdout. Raw CLI output and all local credentials stay
# in private temporary files and are never echoed.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PROVIDER=${1:-}
MODEL=${2:-}
EFFORT=${3:-high}
NODE_BIN=${MF_NODE_BIN:-node}
CCR_BIN=${MF_CCR_BIN:-ccr}
ENSURE_SCRIPT=${MF_CCR_ENSURE_SCRIPT:-$SCRIPT_DIR/ccr-ensure.mjs}
PROBE_SCRIPT=${MF_CCR_PROBE_SCRIPT:-$SCRIPT_DIR/claudex-direct-probe.mjs}

fail(){
  printf 'ClaudeX provider test failed: %s\n' "$1" >&2
  exit 1
}

[ "$PROVIDER" = claudex ] || fail "unsupported provider"
case "$MODEL" in
  codex-api/*) RAW_MODEL=${MODEL#codex-api/};;
  */*) fail "invalid model selector";;
  *) RAW_MODEL=$MODEL;;
esac
[[ "$RAW_MODEL" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] \
  || fail "invalid model selector"
case "$EFFORT" in
  low|medium|high|xhigh|max) ;;
  *) fail "invalid effort";;
esac

SELECTOR="codex-api/$RAW_MODEL"
PROFILE=${CCR_FACTORY_PROFILE:-bettertrack-factory-claudex}
T=$(mktemp -d "${TMPDIR:-/tmp}/mf-claudex-test.XXXXXX") \
  || fail "temporary workspace unavailable"
trap 'rm -rf "$T"' EXIT
chmod 700 "$T" 2>/dev/null || true

if ! "$NODE_BIN" "$ENSURE_SCRIPT" >"$T/ensure.out" 2>"$T/ensure.err"; then
  fail "runtime bootstrap unavailable"
fi
if ! "$NODE_BIN" "$PROBE_SCRIPT" "$RAW_MODEL" \
  >"$T/direct.out" 2>"$T/direct.err"; then
  # CCR's first request after a brand-new OAuth import can race the generated
  # gateway/plugin reload even though /health is already green. One forced,
  # idempotent re-bootstrap plus one fresh proof is bounded and still fails
  # closed for persistent auth, capacity, routing, or response errors.
  if ! "$NODE_BIN" "$ENSURE_SCRIPT" --force \
    >"$T/ensure-retry.out" 2>"$T/ensure-retry.err" \
    || ! "$NODE_BIN" "$PROBE_SCRIPT" "$RAW_MODEL" \
      >"$T/direct-retry.out" 2>"$T/direct-retry.err"; then
    fail "direct gateway proof unavailable"
  fi
fi

if timeout "${MF_PROVIDER_TEST_TIMEOUT:-180}" \
  env -u OPENAI_API_KEY -u CODEX_API_KEY -u ANTHROPIC_API_KEY \
      -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
      -u ANTHROPIC_API_BASE_URL -u ANTHROPIC_MODEL \
      -u ANTHROPIC_SMALL_FAST_MODEL -u CLAUDE_AGENT_API_BASE_URL \
      -u CLAUDE_CODE_OAUTH_TOKEN \
      -u CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY \
      -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_FOUNDRY \
      -u CLAUDE_CODE_USE_VERTEX \
  "$CCR_BIN" "$PROFILE" cli -- \
    --model "$SELECTOR" \
    --effort "$EFFORT" \
    -p "Reply with exactly: CLAUDEX_OK" \
    --max-turns 1 \
    --output-format json \
    --dangerously-skip-permissions \
    >"$T/claude.out" 2>"$T/claude.err"; then
  CLI_RC=0
else
  CLI_RC=$?
fi
[ "$CLI_RC" -eq 0 ] || fail "Claude Code proof returned nonzero"

if ! jq -s 'map(select(type=="object")) | last // empty' \
  "$T/claude.out" >"$T/result.json" 2>/dev/null; then
  fail "Claude Code proof returned invalid JSON"
fi
if ! jq -e --arg selector "$SELECTOR" '
    .type == "result"
    and .subtype == "success"
    and .is_error == false
    and ((.result // "") | gsub("^\\s+|\\s+$"; "") == "CLAUDEX_OK")
    and .terminal_reason == "completed"
    and ((.api_error_status // null) == null)
    and (
      ((.modelUsage | type) == "object" and (.modelUsage | has($selector)))
      or ((.modelUsage | type) == "array" and (.modelUsage | index($selector) != null))
      or ((.modelUsage | type) == "string" and .modelUsage == $selector)
    )
  ' "$T/result.json" >/dev/null 2>&1; then
  fail "Claude Code proof failed result validation"
fi

STATUS_FILE=${CCR_STATUS_FILE:-${CCR_HOME:-$HOME/.claude-code-router}/factory-status.json}
MODELS=$(
  jq -c '
    [.models[]?
      | select(type=="string")
      | select(test("^[A-Za-z0-9][A-Za-z0-9._:-]*$"))]
  ' "$STATUS_FILE" 2>/dev/null
) || MODELS='[]'

jq -cn \
  --arg provider claudex \
  --arg model "$SELECTOR" \
  --arg terminalReason completed \
  --arg testedAt "$(date -Is)" \
  --argjson models "$MODELS" \
  '{
    ok:true,
    provider:$provider,
    model:$model,
    modelUsage:[$model],
    is_error:false,
    terminalReason:$terminalReason,
    models:$models,
    testedAt:$testedAt,
    runtimeReady:true
  }'
