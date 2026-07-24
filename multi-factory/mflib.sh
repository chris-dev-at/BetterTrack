#!/usr/bin/env bash
# multi-factory/mflib.sh — difficulty-based model routing + multi-provider runners.
#
# Sourced by master.sh and worker.sh AFTER factory/lib.sh (needs log/notify/cc/
# ledger_record and $REPO_DIR/$LOG/$MFSTATE). The single factory never loads this
# file — its tier:* routing in lib.sh stays untouched as the fallback path.
#
# Issues are classified by DIFFICULTY, not by model: exactly one of
#   diff:easy | diff:normal | diff:intermediate | diff:hard | diff:max
# The owner maps each difficulty to a provider+model+effort in the dashboard
# (Models tab → state/control/models.json, read fresh before every agent run,
# so changes apply from the next run without a restart):
#
#   { "difficulties": { "<diff>": {"provider":"claude|claudex|codex|gemini",
#                                  "model":"...", "effort":"..."} },
#     "roles": { "composer":"<diff>", "checker":"<diff>", "reviewFloor":"<diff>" } }
#
# Providers (all subscription auth, never committed — see autorun.sh auth sync):
#   claude → claude CLI  (CLAUDE_CODE_OAUTH_TOKEN env; effort low|medium|high|xhigh|max)
#   claudex→ claude CLI through third-party CCR + Codex OAuth
#                         (independent ~/.codex + ~/.claude-code-router per container)
#   codex  → codex CLI   (~/.codex/auth.json; effort is model-dependent)
#   gemini → agy CLI     (Antigravity; ~/.gemini oauth; effort baked into model name,
#                         e.g. "Gemini 3.1 Pro (High)")
#
# Legacy tier labels still resolve (tier:sonnet→easy, tier:opus→intermediate,
# tier:fable→max) so old issues keep working.

MF_MODELS_FILE=${MF_MODELS_FILE:-$MFSTATE/control/models.json}
MF_ROLE_TIMEOUT=${MF_ROLE_TIMEOUT:-7200}   # hard cap per provider role run (s)

DIFF_ORDER="easy normal intermediate hard max"

_MF_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$_MF_LIB_DIR/contracts.sh"

diff_valid(){ case " $DIFF_ORDER " in *" $1 "*) return 0;; *) return 1;; esac; }

diff_index(){ # easy=0 … max=4; invalid → 2 (intermediate)
  local i=0 d
  for d in $DIFF_ORDER; do [ "$d" = "$1" ] && { echo "$i"; return; }; i=$((i+1)); done
  echo 2
}

diff_next(){ # one difficulty harder; max stays max
  case "$1" in
    easy) echo normal;; normal) echo intermediate;; intermediate) echo hard;;
    hard|max) echo max;; *) echo hard;;
  esac
}

diff_at_least(){ # $1=diff $2=floor → the harder of the two
  if [ "$(diff_index "$1")" -ge "$(diff_index "$2")" ]; then echo "$1"; else echo "$2"; fi
}

# Difficulty from a label list (newline-separated, pure — unit-tested).
# diff:* wins; legacy tier:* maps; nothing → intermediate (the old opus default).
diff_from_labels(){
  local labels=$1 d
  d=$(grep -m1 '^diff:' <<<"$labels" | sed 's/^diff://')
  if [ -n "$d" ] && diff_valid "$d"; then echo "$d"; return; fi
  case "$(grep -m1 '^tier:' <<<"$labels")" in
    tier:fable) echo max;; tier:sonnet) echo easy;; *) echo intermediate;;
  esac
}

issue_difficulty(){ diff_from_labels "$(gh issue view "$1" --json labels -q '.labels[].name' 2>/dev/null)"; }

# ---- difficulty → provider/model/effort ------------------------------------------
# Echoes "provider|model|effort" (effort may be empty). Owner config first,
# builtin defaults as fallback — also when the entry is invalid.
diff_default_cfg(){
  case "$1" in
    easy)         echo "claude|claude-sonnet-5|high";;
    normal)       echo "claude|claude-opus-4-8|medium";;
    intermediate) echo "claude|claude-opus-4-8|high";;
    hard)         echo "claude|claude-opus-4-8|max";;
    max)          echo "claude|claude-fable-5|max";;
    *)            echo "claude|claude-opus-4-8|high";;
  esac
}

diff_cfg_from_json(){ # $1=file $2=difficulty — invalid provider is explicit
  jq -r --arg d "$2" '
    .difficulties[$d]? // empty
    | if ((.provider=="claude" or .provider=="claudex"
           or .provider=="codex" or .provider=="gemini")
          and ((.model // "") | type=="string" and length>0
               and (contains("|") | not) and (test("[\\r\\n]") | not))
          and ((.effort // "") | type=="string"
               and (contains("|") | not) and (test("[\\r\\n]") | not)))
      then [.provider, .model, (.effort // "")] | join("|")
      elif ((.provider // "") | type=="string" and length>0)
      then ["invalid", .provider, ""] | join("|")
      else empty
      end
  ' "$1" 2>/dev/null || true
}

diff_cfg(){ # $1=difficulty
  local out=""
  [ -f "$MF_MODELS_FILE" ] && out=$(diff_cfg_from_json "$MF_MODELS_FILE" "$1")
  [ -n "$out" ] || out=$(diff_default_cfg "$1")
  printf '%s\n' "$out"
}

role_diff(){ # $1=composer|checker → difficulty slot for that master role
  local d=""
  [ -f "$MF_MODELS_FILE" ] && d=$(jq -r --arg r "$1" \
    '.roles[$r]? // empty | select(type=="string")' "$MF_MODELS_FILE" 2>/dev/null)
  diff_valid "${d:-}" && { echo "$d"; return; }
  echo hard
}

review_floor(){ # reviews never run below this difficulty (default: intermediate)
  local d=""
  [ -f "$MF_MODELS_FILE" ] && d=$(jq -r \
    '.roles.reviewFloor? // empty | select(type=="string")' "$MF_MODELS_FILE" 2>/dev/null)
  diff_valid "${d:-}" && { echo "$d"; return; }
  echo intermediate
}

mf_uses_claude(){ # 0 when ANY difficulty currently routes to the claude provider
  local d
  for d in $DIFF_ORDER; do
    case "$(diff_cfg "$d")" in claude\|*) return 0;; esac
  done
  return 1
}

# ---- provider runners --------------------------------------------------------------
# All four keep cc()'s contract: block through capacity/limit windows (retry
# forever with LIMIT_SLEEP naps), return 0 on a clean run, 1 only on a genuine
# task failure. Every run lands in the usage ledger (subscription runs at $0).

CODEX_LIMIT_RE='usage limit|rate.?limit|too many requests|quota|insufficient|(^|[^0-9])429([^0-9]|$)'
CLAUDEX_LIMIT_RE='usage limit|rate.?limit|too many requests|quota|insufficient (credit|balance|funds)|model .*overloaded|service (at )?capacity|(^|[^0-9])(429|529)([^0-9]|$)'
CLAUDEX_ROUTER_RE='CCR (management|gateway|runtime|bootstrap|router)|x-target-provider|router authentication|authentication (is )?(unavailable|failed)|oauth (token )?(expired|invalid|refresh failed|error)|unauthori[sz]ed|forbidden|(^|[^0-9])(401|403)([^0-9]|$)'
AGY_LIMIT_RE='quota|rate.?limit|too many requests|RESOURCE_EXHAUSTED|model is overloaded|capacity|(^|[^0-9])(429|529)([^0-9]|$)'

MF_CCR_ENSURE_SCRIPT=${MF_CCR_ENSURE_SCRIPT:-/work/mf/ccr-ensure.mjs}
MF_CCR_PROBE_SCRIPT=${MF_CCR_PROBE_SCRIPT:-/work/mf/claudex-direct-probe.mjs}
MF_CCR_PROFILE=${CCR_FACTORY_PROFILE:-bettertrack-factory-claudex}
MF_NODE_BIN=${MF_NODE_BIN:-node}
MF_CCR_BIN=${MF_CCR_BIN:-ccr}
MF_CLAUDEX_REDACTOR_SCRIPT=${MF_CLAUDEX_REDACTOR_SCRIPT:-/work/mf/claudex-redact.mjs}
MF_REDACTOR_NODE_BIN=${MF_REDACTOR_NODE_BIN:-node}

# Run a provider command, mirror its combined stream to the role log, retain the
# full stream for classification, and return the provider command's exit code.
# PIPESTATUS is intentionally consumed in this function, in the same shell as
# the pipeline. Reading it after `out=$(... | tee)` loses it to the command-
# substitution subshell and was the cause of nonzero Codex/Agy runs looking OK.
mf_capture_command(){ # $1=output file, remaining args=command
  local output_file=$1; shift
  "$@" 2>&1 | tee -a "$LOG" "$output_file" >/dev/null
  return "${PIPESTATUS[0]}"
}

# ClaudeX may surface a local management URL or auth header in a router error.
# Keep the raw capture private for result parsing, but redact credentials before
# appending the stream to the durable role log.
claudex_sanitize_stream(){
  "$MF_REDACTOR_NODE_BIN" "$MF_CLAUDEX_REDACTOR_SCRIPT"
}

mf_capture_claudex_command(){ # $1=private output file, remaining args=command
  local output_file=$1; shift
  "$@" 2>&1 | tee "$output_file" | claudex_sanitize_stream >>"$LOG"
  return "${PIPESTATUS[0]}"
}

claudex_model_selector(){
  local model=$1 raw
  case "$model" in
    codex-api/*) raw=${model#codex-api/};;
    */*) return 1;;
    *) raw=$model;;
  esac
  [[ "$raw" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || return 1
  printf 'codex-api/%s\n' "$raw"
}

claudex_result(){
  jq -Rrs '
    [split("\n")[] | fromjson?
      | select(type=="object" and .type=="result")]
    | last // empty
  ' 2>/dev/null
}

claudex_failure_signal(){
  jq -Rrs '
    [split("\n")[] | fromjson? | select(type=="object")
      | select(.type=="result"
               or ((.type // "") | test("(^error$|\\.failed$|\\.cancelled$)"))
               or (.error? != null))
      | [
          (.subtype // ""),
          (.result // ""),
          (.message // ""),
          (.terminal_reason // ""),
          ((.api_error_status // "") | tostring),
          (if (.error? | type)=="string" then .error else "" end),
          (.error.message? // "")
        ] | join(" ")]
    | join("\n")
  ' 2>/dev/null
}

claudex_result_valid(){ # $1=result json $2=exact selector
  jq -e --arg selector "$2" '
    .type == "result"
    and .subtype == "success"
    and .is_error == false
    and .terminal_reason == "completed"
    and ((.api_error_status // null) == null)
    and (
      ((.modelUsage | type) == "object" and (.modelUsage | has($selector)))
      or ((.modelUsage | type) == "array"
          and (.modelUsage | index($selector) != null))
      or ((.modelUsage | type) == "string" and .modelUsage == $selector)
    )
  ' >/dev/null 2>&1 <<<"$1"
}

claudex_ledger_result(){ # $1=validated result json
  jq -c '
    def safe_model_usage:
      if type != "object" then {}
      else with_entries(
        select(.key | test("^codex-api/[A-Za-z0-9][A-Za-z0-9._:-]*$"))
        | .value |= (
            if type != "object" then {}
            else with_entries(
              select((.value | type) == "number"
                     or (.value | type) == "boolean"
                     or (.value | type) == "null")
            )
            end
          )
      )
      end;
    . as $result
    | ($result.modelUsage // {} | safe_model_usage) as $models
    | def model_sum($key):
        ([$models[]? | .[$key] // 0 | select(type=="number")] | add // 0);
      ($result.usage // {}) as $usage
    | {
        provider:"claudex",
        provider_family:"openai",
        harness:"claude-code",
        billing:"subscription",
        total_cost_usd:0,
        claudex_usage_schema:1,
        claudex_telemetry_complete:
          ((($usage.input_tokens // null) | type) == "number"
           and (($usage.output_tokens // null) | type) == "number"),
        usage:{
          input_tokens:
            (if (($usage.input_tokens // null) | type) == "number"
             then $usage.input_tokens else model_sum("inputTokens") end),
          output_tokens:
            (if (($usage.output_tokens // null) | type) == "number"
             then $usage.output_tokens else model_sum("outputTokens") end),
          cache_read_input_tokens:
            (if (($usage.cache_read_input_tokens // null) | type) == "number"
             then $usage.cache_read_input_tokens
             else model_sum("cacheReadInputTokens") end),
          cache_creation_input_tokens:
            (if (($usage.cache_creation_input_tokens // null) | type) == "number"
             then $usage.cache_creation_input_tokens
             else model_sum("cacheCreationInputTokens") end)
        },
        model_usage:$models,
        api_equivalent_usd:
          (if (($result.total_cost_usd // null) | type) == "number"
           then $result.total_cost_usd else null end),
        api_equivalent_pricing:"claude-code-local-estimate",
        api_equivalent_source:"claude-code-total_cost_usd",
        api_equivalent_coverage:
          (if (($result.total_cost_usd // null) | type) == "number"
           then "complete" else "missing-telemetry" end)
      }
  ' 2>/dev/null <<<"$1"
}

claudex_ensure(){
  "$MF_NODE_BIN" "$MF_CCR_ENSURE_SCRIPT" "$@" >/dev/null 2>&1
}

claudex_direct_probe(){ # $1=raw model; 0=healthy, 75=limit, 76=router/auth
  "$MF_NODE_BIN" "$MF_CCR_PROBE_SCRIPT" "$1" --quiet >/dev/null 2>&1
}

codex_jsonl_state(){ # completed | error | incomplete
  jq -Rrs '
    [split("\n")[] | fromjson? | select(type=="object")] as $events
    | if any($events[];
          ((.type // "") | test("(^error$|\\.failed$|\\.cancelled$)"))
          or (.error? != null))
      then "error"
      elif any($events[]; .type=="turn.completed")
      then "completed"
      else "incomplete"
      end
  ' 2>/dev/null
}

codex_failure_signal(){
  jq -Rrs '
    [split("\n")[] | . as $line
     | (try fromjson catch null) as $event
     | if $event == null then $line
       elif ($event | type) != "object" then $line
       elif ((($event.type // "") | test("(^error$|\\.failed$|\\.cancelled$)"))
             or ($event.error? != null))
       then [
         ($event.message // ""),
         (if ($event.error? | type) == "string" then $event.error else "" end),
         ($event.error.message? // "")
       ] | join(" ")
       else empty
       end]
    | join("\n")
  ' 2>/dev/null
}

cc_claudex(){ # $1=model $2=Claude Code effort(optional) $3=prompt
  local model=$1 effort=$2 prompt=$3 selector raw_model
  local role=${CC_ROLE:-cc} issue=${CC_ISSUE:--}
  local tries=0 transient_tries=0 rebootstrap_done=0
  local max_attempts=${MF_PROVIDER_ATTEMPTS:-2}
  local empty_res='{"provider":"claudex","provider_family":"openai","harness":"claude-code","billing":"subscription","total_cost_usd":0,"claudex_usage_schema":1,"claudex_telemetry_complete":false,"api_equivalent_usd":null,"api_equivalent_pricing":"claude-code-local-estimate","api_equivalent_source":"claude-code-total_cost_usd","api_equivalent_coverage":"missing-telemetry"}'

  if [ "${MF_DRY_RUN:-0}" = 1 ]; then
    log "DRY: ClaudeX $model skipped"
    return 0
  fi
  selector=$(claudex_model_selector "$model") || {
    log "  ↳ invalid ClaudeX model selector"
    ledger_record "$issue" "$role" "$model" "$empty_res" 0 fail
    return 1
  }
  raw_model=${selector#codex-api/}

  if ! claudex_ensure; then
    rebootstrap_done=1
    if ! claudex_ensure --force; then
      ledger_record "$issue" "$role" "$raw_model" "$empty_res" 0 fail
      log "  ↳ ClaudeX runtime bootstrap failed"
      return 1
    fi
  fi

  while true; do
    local out rc start dur result signal res capture probe_rc=0
    start=$(date +%s)
    capture=$(mktemp "${TMPDIR:-/tmp}/mf-claudex.XXXXXX") || return 1
    chmod 600 "$capture" 2>/dev/null || true
    local -a cmd=(
      timeout "$MF_ROLE_TIMEOUT"
      env
      -u OPENAI_API_KEY
      -u CODEX_API_KEY
      -u ANTHROPIC_API_KEY
      -u ANTHROPIC_AUTH_TOKEN
      -u ANTHROPIC_BASE_URL
      -u ANTHROPIC_API_BASE_URL
      -u ANTHROPIC_MODEL
      -u ANTHROPIC_SMALL_FAST_MODEL
      -u CLAUDE_AGENT_API_BASE_URL
      -u CLAUDE_CODE_OAUTH_TOKEN
      -u CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
      -u CLAUDE_CODE_USE_BEDROCK
      -u CLAUDE_CODE_USE_FOUNDRY
      -u CLAUDE_CODE_USE_VERTEX
      "$MF_CCR_BIN" "$MF_CCR_PROFILE" cli --
      --model "$selector"
    )
    [ -n "$effort" ] && cmd+=(--effort "$effort")
    cmd+=(
      -p "$prompt"
      --output-format stream-json
      --verbose
      --dangerously-skip-permissions
    )
    if mf_capture_claudex_command "$capture" "${cmd[@]}" </dev/null; then
      rc=0
    else
      rc=$?
    fi
    out=$(<"$capture")
    rm -f "$capture"
    dur=$(( $(date +%s) - start ))
    result=$(claudex_result <<<"$out")
    signal=$(claudex_failure_signal <<<"$out")
    res=$(claudex_ledger_result "$result") || res=$empty_res

    if [ "$rc" = 0 ] && [ -n "$result" ] \
      && claudex_result_valid "$result" "$selector"; then
      ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" ok
      log "  ↳ ok (claudex $raw_model, ${dur}s)"
      return 0
    fi
    if [ "$rc" = 124 ]; then
      ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" fail
      log "  ↳ ClaudeX run timed out after ${MF_ROLE_TIMEOUT}s"
      return 1
    fi
    if grep -qiE "$CLAUDEX_LIMIT_RE" <<<"$signal"; then
      ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" retry
      notify "ClaudeX/Codex usage limit hit — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
      sleep "$LIMIT_SLEEP"
      continue
    fi
    if { grep -qiE "$CLAUDEX_ROUTER_RE" <<<"$signal" \
         || { [ -z "$result" ] && grep -qiE "$CLAUDEX_ROUTER_RE" <<<"$out"; }; } \
      && [ "$rebootstrap_done" -eq 0 ]; then
      rebootstrap_done=1
      ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" retry
      log "  ↳ ClaudeX router/auth failure — one idempotent rebootstrap"
      if claudex_ensure --force; then
        continue
      fi
    fi
    if printf '%s' "$out" | grep -qiE "$TRANSIENT_RE" \
      && [ "$transient_tries" -lt "${CC_TRANSIENT_MAX:-3}" ]; then
      transient_tries=$((transient_tries+1))
      ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" retry
      log "  ↳ transient transport error — retry $transient_tries/${CC_TRANSIENT_MAX:-3}"
      sleep "${CC_TRANSIENT_SLEEP:-45}"
      continue
    fi

    # A missing structured result is ambiguous. Probe this provider's local
    # configuration/health and then the Codex-backed gateway itself — never the
    # Anthropic capacity probe used by cc().
    if [ -z "$result" ]; then
      if claudex_ensure && claudex_direct_probe "$raw_model"; then
        probe_rc=0
      else
        probe_rc=$?
      fi
      if [ "$probe_rc" = 75 ]; then
        ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" retry
        notify "ClaudeX/Codex usage limit hit — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
        sleep "$LIMIT_SLEEP"
        continue
      fi
      if [ "$probe_rc" != 0 ] && [ "$rebootstrap_done" -eq 0 ]; then
        rebootstrap_done=1
        ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" retry
        log "  ↳ ClaudeX probe failed — one idempotent rebootstrap"
        if claudex_ensure --force; then
          continue
        fi
      fi
    fi

    tries=$((tries+1))
    if [ "$tries" -lt "$max_attempts" ]; then
      ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" retry
      log "  ↳ ClaudeX failed (rc=$rc) — retry $tries/$max_attempts"
      sleep "${MF_PROVIDER_RETRY_SLEEP:-60}"
      continue
    fi
    ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" fail
    log "  ↳ genuine ClaudeX task failure (rc=$rc)"
    return 1
  done
}

cc_codex(){ # $1=model $2=reasoning-effort(optional) $3=prompt
  local model=$1 effort=$2 prompt=$3
  local role=${CC_ROLE:-cc} issue=${CC_ISSUE:--} tries=0 transient_tries=0
  local max_attempts=${MF_PROVIDER_ATTEMPTS:-2}
  while true; do
    local out rc start dur res state signal capture
    start=$(date +%s)
    capture=$(mktemp "${TMPDIR:-/tmp}/mf-codex.XXXXXX") || return 1
    local -a cmd=(timeout "$MF_ROLE_TIMEOUT" codex exec --cd "$REPO_DIR" --json
      --ephemeral -m "$model")
    [ -n "$effort" ] && cmd+=(-c "model_reasoning_effort=$effort")
    cmd+=(--dangerously-bypass-approvals-and-sandbox --skip-git-repo-check "$prompt")
    if mf_capture_command "$capture" "${cmd[@]}" </dev/null; then rc=0; else rc=$?; fi
    out=$(<"$capture"); rm -f "$capture"
    dur=$(( $(date +%s) - start ))
    state=$(codex_jsonl_state <<<"$out")
    signal=$(codex_failure_signal <<<"$out")
    res=$(jq -Rrs --arg model "$model" '
      def rates:
        if $model=="gpt-5.6-sol" then {i:5,c:0.5,w:6.25,o:30}
        elif $model=="gpt-5.6-terra" then {i:2.5,c:0.25,w:3.125,o:15}
        elif $model=="gpt-5.6-luna" then {i:1,c:0.1,w:1.25,o:6}
        else null end;
      [split("\n")[] | fromjson? | select(.type=="turn.completed") | .usage // {}] as $u
      | {i: ($u | map(.input_tokens // 0) | add // 0),
         c: ($u | map(.cached_input_tokens // 0) | add // 0),
         w: ($u | map(.cache_write_input_tokens // .cache_creation_input_tokens // 0) | add // 0),
         # Codex reports output_tokens inclusive of reasoning. Keep the
         # reasoning subset separately for diagnostics; never add it again for
         # billing or aggregate token totals.
         o: ($u | map(.output_tokens // 0) | add // 0),
         r: ($u | map(.reasoning_output_tokens // 0) | add // 0),
         complete: (($u|length)>0
                    and all($u[]; ((.input_tokens|type)=="number")
                                   and ((.cached_input_tokens|type)=="number")
                                   and ((.output_tokens|type)=="number"))),
         write_seen: any($u[]; has("cache_write_input_tokens")
                                 or has("cache_creation_input_tokens"))}
      | .uncached = ([.i - .c - .w, 0] | max)
      | rates as $r
      | (if .complete and $r != null
         then ((.uncached*$r.i + .c*$r.c + .w*$r.w + .o*$r.o)/1000000
               * 1000000 | round) / 1000000
         else null end) as $estimate
      | {provider:"codex", provider_family:"openai", harness:"codex-cli",
         billing:"subscription", total_cost_usd:0,
         codex_usage_schema:2,
         output_tokens_semantics:"inclusive-reasoning",
         input_tokens_semantics:"exclusive",
         cache_write_telemetry:.write_seen,
         codex_telemetry_complete:.complete,
         api_equivalent_usd:$estimate,
         api_equivalent_pricing:"openai-standard-base-2026-07-24",
         api_equivalent_coverage:
           (if $r==null then "unknown-model"
            elif .complete then "complete"
            else "missing-telemetry" end),
         usage:{input_tokens:.uncached, cache_read_input_tokens:.c,
                cache_creation_input_tokens:.w, output_tokens:.o,
                reasoning_output_tokens:.r}}' \
      <<<"$out" 2>/dev/null) \
      || res='{"provider":"codex","provider_family":"openai","harness":"codex-cli","billing":"subscription","total_cost_usd":0,"codex_usage_schema":2,"output_tokens_semantics":"inclusive-reasoning","codex_telemetry_complete":false,"api_equivalent_usd":null,"api_equivalent_coverage":"missing-telemetry"}'
    if [ "$rc" = 0 ] && [ "$state" = completed ]; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" ok
      log "  ↳ ok (codex $model, ${dur}s)"
      return 0
    fi
    if [ "$rc" = 124 ]; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" fail
      log "  ↳ codex run timed out after ${MF_ROLE_TIMEOUT}s"
      return 1
    fi
    if grep -qiE "$CODEX_LIMIT_RE" <<<"$signal"; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" retry
      notify "codex usage limit hit — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
      sleep "$LIMIT_SLEEP"; continue
    fi
    # Transient transport/stream drop: bounded in-place retry with short spacing,
    # same class + wording as cc() — does not count against the single generic retry.
    if [ "$(cc_classify "$signal")" = transient ] && [ "$transient_tries" -lt "${CC_TRANSIENT_MAX:-3}" ]; then
      transient_tries=$((transient_tries+1))
      ledger_record "$issue" "$role" "$model" "$res" "$dur" retry
      log "  ↳ transient transport error — retry $transient_tries/${CC_TRANSIENT_MAX:-3}"
      sleep "${CC_TRANSIENT_SLEEP:-45}"; continue
    fi
    tries=$((tries+1))
    if [ "$tries" -lt "$max_attempts" ]; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" retry
      log "  ↳ codex failed (rc=$rc, jsonl=$state) — retry $tries/$max_attempts"
      sleep "${MF_PROVIDER_RETRY_SLEEP:-60}"; continue
    fi
    ledger_record "$issue" "$role" "$model" "$res" "$dur" fail
    log "  ↳ genuine codex task failure (rc=$rc, jsonl=$state)"
    return 1
  done
}

cc_gemini(){ # $1=model (agy model string, effort baked in) $2=prompt
  local model=$1 prompt=$2
  local role=${CC_ROLE:-cc} issue=${CC_ISSUE:--} tries=0
  local max_attempts=${MF_PROVIDER_ATTEMPTS:-2}
  while true; do
    local out rc start dur capture
    start=$(date +%s)
    capture=$(mktemp "${TMPDIR:-/tmp}/mf-agy.XXXXXX") || return 1
    if ( cd "$REPO_DIR" && mf_capture_command "$capture" timeout "$MF_ROLE_TIMEOUT" \
      agy -p "$prompt" --model "$model" --dangerously-skip-permissions \
      --print-timeout "${MF_ROLE_TIMEOUT}s" </dev/null ); then rc=0; else rc=$?; fi
    out=$(<"$capture"); rm -f "$capture"
    dur=$(( $(date +%s) - start ))
    if [ "$rc" = 0 ] && ! grep -qiE 'not logged into antigravity' <<<"$out"; then
      ledger_record "$issue" "$role" "$model" '{"total_cost_usd":0}' "$dur" ok
      log "  ↳ ok (agy $model, ${dur}s)"
      return 0
    fi
    if grep -qiE "$AGY_LIMIT_RE" <<<"$out"; then
      ledger_record "$issue" "$role" "$model" '{"total_cost_usd":0}' "$dur" retry
      notify "antigravity usage limit hit — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
      sleep "$LIMIT_SLEEP"; continue
    fi
    if [ "$rc" = 124 ]; then
      ledger_record "$issue" "$role" "$model" '{"total_cost_usd":0}' "$dur" fail
      log "  ↳ agy run timed out after ${MF_ROLE_TIMEOUT}s"
      return 1
    fi
    tries=$((tries+1))
    if [ "$tries" -lt "$max_attempts" ]; then
      ledger_record "$issue" "$role" "$model" '{"total_cost_usd":0}' "$dur" retry
      log "  ↳ agy failed (rc=$rc) — retry $tries/$max_attempts"
      sleep "${MF_PROVIDER_RETRY_SLEEP:-60}"; continue
    fi
    ledger_record "$issue" "$role" "$model" '{"total_cost_usd":0}' "$dur" fail
    log "  ↳ genuine agy task failure (rc=$rc)"
    return 1
  done
}

mf_cc(){ # $1=role $2=difficulty $3=prompt — resolve config and dispatch
  local role=$1 d=$2 prompt=$3 cfg provider model effort
  cfg=$(diff_cfg "$d")
  IFS='|' read -r provider model effort <<<"$cfg"
  log "$role @ diff:$d → $provider/$model${effort:+ ($effort)}"
  case "$provider" in
    claude)  CC_ROLE=$role CC_EFFORT=$effort cc "$model" "$prompt";;
    claudex) CC_ROLE=$role cc_claudex "$model" "$effort" "$prompt";;
    codex)   CC_ROLE=$role cc_codex "$model" "$effort" "$prompt";;
    gemini)  CC_ROLE=$role cc_gemini "$model" "$prompt";;
    *)
      log "  ↳ unsupported provider '$provider' — refusing implicit Claude fallback"
      return 1
      ;;
  esac
}

# ---- difficulty labels (master boot) ------------------------------------------------
mf_labels_boot(){
  gh label create awaiting-owner   --color FBCA04 --description "planned work awaiting owner approval (not runnable)" --force >/dev/null 2>&1 || true
  gh label create diff:easy         --color 1D76DB --description "difficulty: easy — trivial/mechanical work"        --force >/dev/null 2>&1 || true
  gh label create diff:normal       --color 7CE38B --description "difficulty: normal — standard feature work"        --force >/dev/null 2>&1 || true
  gh label create diff:intermediate --color 0E8A16 --description "difficulty: intermediate — cross-cutting/stateful" --force >/dev/null 2>&1 || true
  gh label create diff:hard         --color 8250DF --description "difficulty: hard — complex engine/architecture"    --force >/dev/null 2>&1 || true
  gh label create diff:max          --color B60205 --description "difficulty: max — keystone/critical path"          --force >/dev/null 2>&1 || true
}
