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
# so changes apply from the next run without a restart).
#
# Each difficulty carries up to THREE role slots (schema v2):
#   writer     — writes the initial implementation
#   reviewer1  — the FIRST review on a PR (one cross-vendor pass)
#   completion — every later fixer AND every later reviewer until done
#
#   { "difficulties": { "<diff>": {
#         "writer":     {"provider":"claude|claudex|codex|gemini","model":"...","effort":"..."},
#         "reviewer1":  { ... }, "completion": { ... },
#         "provider":"...", "model":"...", "effort":"..."   # flat legacy form (v1)
#     } },
#     "roles": { "composer":"<diff>" | {"provider":"...","model":"...","effort":"..."},
#                "checker":"<diff>" | { ...same pin form... },
#                "reviewFloor":"<diff>" } }
#
# Slot resolution (diff_cfg <diff> <slot>): the slot object wins; a missing or
# non-object slot falls back to the flat legacy entry; a missing flat entry
# falls back to the builtin all-Claude defaults. A PRESENT-but-malformed slot
# or flat entry with a string provider stays explicit ("invalid|<provider>|")
# and fails closed downstream — it never silently falls through —
# a typo must never silently reroute a role to Claude. A v1 (flat-only) file
# therefore keeps working unchanged: every slot resolves to the flat entry.
#
# Role pins: a roles.<role> entry may be an OBJECT instead of a difficulty
# string — that pins the role to the exact provider/model/effort, bypassing
# difficulty tiers and slots entirely. Works for any role mf_cc runs (composer,
# checker, writer, reviewer, fixer, ci-fix). Pins are per-role, not per-slot:
# a pinned reviewer covers BOTH review passes (reviewer1 and completion). A
# STRING entry keeps today's meaning exactly — composer/checker resolve through
# that difficulty via role_diff; strings under any other role name stay inert,
# so the per-difficulty writer/reviewer1/completion slots remain authoritative
# for issue work unless a role is explicitly pinned with an object. A
# present-but-unusable pin (unknown provider, bad model/effort string, or any
# Opus 5 model above xhigh effort — owner hard rule) is logged and IGNORED:
# the role falls back to difficulty routing; a bad pin never bricks a run.
# reviewFloor is always a difficulty name, never a pin. The composer route
# gate (mf_composer_route_allowed) still applies to a pinned composer.
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
MF_SLOT_ORDER="writer reviewer1 completion"

_MF_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$_MF_LIB_DIR/contracts.sh"

mf_slot_valid(){ case " $MF_SLOT_ORDER " in *" $1 "*) return 0;; *) return 1;; esac; }

# Builtin role → slot mapping, used when the caller does not pass CC_SLOT.
# The reviewer's first-vs-later distinction needs PR evidence only the worker
# has, so run_reviewer always passes CC_SLOT explicitly; reviewer1 here is only
# the conservative default for a bare call.
mf_role_slot(){
  case "$1" in
    writer|composer) echo writer;;
    reviewer)        echo reviewer1;;
    *)               echo completion;;   # fixer, checker, ci-fix, unknown roles
  esac
}

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

diff_at_least(){ # $1=diff $2=floor → the harder of the two; invalid diff takes the floor
  diff_valid "$1" || { echo "$2"; return; }
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

diff_slot_cfg_from_json(){ # $1=file $2=difficulty $3=slot — invalid provider is explicit
  jq -r --arg d "$2" --arg s "$3" '
    .difficulties[$d]? // empty
    | .[$s]? // empty
    | if (type=="object"
          and (.provider=="claude" or .provider=="claudex"
               or .provider=="codex" or .provider=="gemini")
          and ((.model // "") | type=="string" and length>0
               and (contains("|") | not) and (test("[\\r\\n]") | not))
          and ((.effort // "") | type=="string"
               and (contains("|") | not) and (test("[\\r\\n]") | not)))
      then [.provider, .model, (.effort // "")] | join("|")
      elif (type=="object") and ((.provider // "") | type=="string" and length>0)
      then ["invalid", .provider, ""] | join("|")
      else empty
      end
  ' "$1" 2>/dev/null || true
}

mf_opus5_route_ok(){ # $1="provider|model|effort" — the Opus-5 ≤ xhigh owner rule
  local provider model effort
  IFS='|' read -r provider model effort <<<"$1"
  mf_opus5_effort_ok "$model" "$effort"
}

diff_cfg(){ # $1=difficulty $2=slot (optional: writer|reviewer1|completion)
  # The Opus-5 cap binds HERE too, not only in set-models/the editor — a
  # hand-written models.json must never run Opus 5 above xhigh. An over-cap
  # slot falls to the flat entry, an over-cap flat entry falls to the builtin
  # default (mirrors role_pin_cfg's fall-back semantics). Notes go to stderr:
  # diff_cfg runs inside command substitutions, so log() would corrupt the
  # returned route string.
  local d=$1 slot=${2:-} out=""
  if [ -f "$MF_MODELS_FILE" ]; then
    if [ -n "$slot" ]; then
      out=$(diff_slot_cfg_from_json "$MF_MODELS_FILE" "$d" "$slot")
      if [ -n "$out" ] && ! mf_opus5_route_ok "$out"; then
        printf 'opus5 cap: %s.%s route exceeds xhigh — falling back\n' "$d" "$slot" >&2
        out=""
      fi
    fi
    if [ -z "$out" ]; then
      out=$(diff_cfg_from_json "$MF_MODELS_FILE" "$d")
      if [ -n "$out" ] && ! mf_opus5_route_ok "$out"; then
        printf 'opus5 cap: %s flat route exceeds xhigh — using the builtin default\n' "$d" >&2
        out=""
      fi
    fi
  fi
  [ -n "$out" ] || out=$(diff_default_cfg "$d")
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

# Owner hard rule: no Opus 5 run may ever exceed xhigh effort. Effort scale for
# the claude provider is low|medium|high|xhigh|max; empty means the CLI default.
mf_opus5_effort_ok(){ # $1=model $2=effort → 1 when an Opus 5 model exceeds xhigh
  case "$1" in
    claude-opus-5*|*/claude-opus-5*)
      case "$2" in ''|low|medium|high|xhigh) return 0;; *) return 1;; esac;;
  esac
  return 0
}

# roles.<role> as an OBJECT is a direct model pin. Same field validation rules
# as the slot parser (pipe/CRLF injection rejected, provider allowlisted), but
# unlike slots a bad pin must FALL BACK, not fail closed — the explicit
# "malformed||" marker lets mf_cc log the ignored pin before falling back to
# difficulty routing. A string or absent entry yields empty (no pin).
role_pin_cfg_from_json(){ # $1=file $2=role
  jq -r --arg r "$2" '
    .roles[$r]? // empty
    | if (type=="object"
          and (.provider=="claude" or .provider=="claudex"
               or .provider=="codex" or .provider=="gemini")
          and ((.model // "") | type=="string" and length>0
               and (contains("|") | not) and (test("[\\r\\n]") | not))
          and ((.effort // "") | type=="string"
               and (contains("|") | not) and (test("[\\r\\n]") | not)))
      then [.provider, .model, (.effort // "")] | join("|")
      elif (type=="object") then "malformed||"
      else empty
      end
  ' "$1" 2>/dev/null || true
}

role_pin_cfg(){ # $1=role → "provider|model|effort" pin, "malformed||", or "" (no pin)
  local out="" provider model effort
  [ -f "$MF_MODELS_FILE" ] || return 0
  out=$(role_pin_cfg_from_json "$MF_MODELS_FILE" "$1")
  [ -n "$out" ] || return 0
  if [ "$out" != "malformed||" ]; then
    IFS='|' read -r provider model effort <<<"$out"
    mf_opus5_effort_ok "$model" "$effort" || out="malformed||"
  fi
  printf '%s\n' "$out"
}

mf_uses_claude(){ # 0 when ANY difficulty slot or role pin routes to the claude provider
  local d s r
  for d in $DIFF_ORDER; do
    for s in $MF_SLOT_ORDER; do
      case "$(diff_cfg "$d" "$s")" in claude\|*) return 0;; esac
    done
  done
  for r in composer checker writer reviewer fixer ci-fix; do
    case "$(role_pin_cfg "$r")" in claude\|*) return 0;; esac
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

claudex_turn_limit_reached(){ # $1=result json
  jq -e '
    .type == "result"
    and (
      .subtype == "error_max_turns"
      or .terminal_reason == "max_turns_reached"
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
    | (($models | length) > 0) as $has_models
    | ($has_models
       and all($models[]?;
         ((.inputTokens // null) | type) == "number"
         and ((.outputTokens // null) | type) == "number")) as $models_complete
    | {
        provider:"claudex",
        provider_family:"openai",
        harness:"claude-code",
        billing:"subscription",
        total_cost_usd:0,
        claudex_usage_schema:1,
        claudex_telemetry_complete:
          ($models_complete
           or ((($usage.input_tokens // null) | type) == "number"
               and (($usage.output_tokens // null) | type) == "number")),
        usage:{
          input_tokens:
            (if $has_models then model_sum("inputTokens")
             elif (($usage.input_tokens // null) | type) == "number"
             then $usage.input_tokens else 0 end),
          output_tokens:
            (if $has_models then model_sum("outputTokens")
             elif (($usage.output_tokens // null) | type) == "number"
             then $usage.output_tokens else 0 end),
          cache_read_input_tokens:
            (if $has_models then model_sum("cacheReadInputTokens")
             elif (($usage.cache_read_input_tokens // null) | type) == "number"
             then $usage.cache_read_input_tokens else 0 end),
          cache_creation_input_tokens:
            (if $has_models then model_sum("cacheCreationInputTokens")
             elif (($usage.cache_creation_input_tokens // null) | type) == "number"
             then $usage.cache_creation_input_tokens else 0 end)
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
  local max_turns=${CC_MAX_TURNS:-}
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
  case "$max_turns" in
    ''|*[!0-9]*|0) max_turns=;;
  esac

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
    [ -n "$max_turns" ] && cmd+=(--max-turns "$max_turns")
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
    if [ -n "$result" ] && claudex_turn_limit_reached "$result"; then
      ledger_record "$issue" "$role" "$raw_model" "$res" "$dur" fail
      log "  ↳ ClaudeX reached its ${max_turns:-configured} turn cap"
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

mf_composer_route_allowed(){ # $1=provider $2=model
  local provider=$1 model=$2
  case "$provider" in
    claude)
      [[ "$model" =~ ^claude-(fable|opus)-[A-Za-z0-9._:-]+$ ]]
      ;;
    claudex)
      [ "$model" = gpt-5.6-sol ] || [ "$model" = codex-api/gpt-5.6-sol ]
      ;;
    codex)
      [ "$model" = gpt-5.6-sol ]
      ;;
    *)
      return 1
      ;;
  esac
}

mf_sol_composer_route(){ # $1=provider $2=model
  case "$1/$2" in
    claudex/gpt-5.6-sol|claudex/codex-api/gpt-5.6-sol|codex/gpt-5.6-sol) return 0;;
    *) return 1;;
  esac
}

mf_sol_composer_instructions(){
  cat <<'EOF'
=== SOL-SPECIFIC COMPOSER EXECUTION CONTRACT ===
This is a bounded planning run, not a repository audit.
- Work as one agent. NEVER use Agent, TaskCreate, TaskUpdate, TaskList,
  TaskGet, TaskOutput, SendMessage, or any delegation/task-tracking tool.
- Trust closed issues and merged commits in LIVE STATE as shipped evidence.
  Do not re-review them unless an open bug or needs-human item disputes them.
- Do not run tests, builds, linters, broad history queries, recursive tree
  exploration, or general-purpose code audits.
- Before the first create-issue.sh call, use at most 20 tool calls total,
  including at most 6 file reads and 8 shell calls. Use only MAP/graph lookups
  and targeted duplicate searches. If the safe frontier remains unclear inside
  that budget, write NONE; never keep investigating.
- An owner-approved brief already supplies the frontier. In that mode, skip
  milestone discovery: preflight only its named candidates, then use the helper.
=== END SOL-SPECIFIC COMPOSER EXECUTION CONTRACT ===
EOF
}

mf_cc(){ # $1=role $2=difficulty $3=prompt — resolve config (pin or per-role slot) and dispatch
  # A valid roles.<role> object pin wins outright. Otherwise the slot comes
  # from CC_SLOT when the caller has evidence-based routing (the worker's
  # first-review-vs-later distinction) or from the builtin role → slot mapping,
  # and the difficulty tier resolves the model. An unknown CC_SLOT falls back
  # to the role default; an unusable pin is logged and ignored.
  local role=$1 d=$2 prompt=$3 slot cfg provider model effort route
  local sol_composer=0 sol_timeout=1200 sol_max_turns=40
  slot=${CC_SLOT:-}
  mf_slot_valid "${slot:-x}" || slot=$(mf_role_slot "$role")
  cfg=$(role_pin_cfg "$role")
  if [ "$cfg" = "malformed||" ]; then
    log "$role: ignoring unusable role pin in models.json (malformed entry or Opus 5 above xhigh) — using difficulty routing"
    cfg=""
  fi
  if [ -n "$cfg" ]; then
    route="pin"
  else
    cfg=$(diff_cfg "$d" "$slot")
    route="diff:$d [$slot]"
  fi
  IFS='|' read -r provider model effort <<<"$cfg"
  if [ "$role" = composer ] && ! mf_composer_route_allowed "$provider" "$model"; then
    log "composer @ $route → $provider/$model${effort:+ ($effort)}"
    log "  ↳ composer route rejected — only Claude Fable, Claude Opus, or GPT-5.6 Sol may compose"
    return 1
  fi
  if [ "$role" = composer ] && mf_sol_composer_route "$provider" "$model"; then
    sol_composer=1
    sol_timeout=${MF_SOL_COMPOSER_TIMEOUT:-1200}
    sol_max_turns=${MF_SOL_COMPOSER_MAX_TURNS:-40}
    case "$sol_timeout" in ''|*[!0-9]*) sol_timeout=1200;; esac
    case "$sol_max_turns" in ''|*[!0-9]*) sol_max_turns=40;; esac
    [ "$sol_timeout" -ge 60 ] && [ "$sol_timeout" -le 7200 ] || sol_timeout=1200
    [ "$sol_max_turns" -ge 1 ] && [ "$sol_max_turns" -le 200 ] || sol_max_turns=40
    prompt="$prompt

$(mf_sol_composer_instructions)"
  fi
  log "$role @ $route → $provider/$model${effort:+ ($effort)}"
  case "$provider" in
    claude)  CC_ROLE=$role CC_EFFORT=$effort cc "$model" "$prompt";;
    claudex)
      if [ "$sol_composer" -eq 1 ]; then
        MF_ROLE_TIMEOUT=$sol_timeout CC_MAX_TURNS=$sol_max_turns \
          CC_ROLE=$role cc_claudex "$model" "$effort" "$prompt"
      else
        CC_ROLE=$role cc_claudex "$model" "$effort" "$prompt"
      fi
      ;;
    codex)
      if [ "$sol_composer" -eq 1 ]; then
        MF_ROLE_TIMEOUT=$sol_timeout CC_ROLE=$role cc_codex "$model" "$effort" "$prompt"
      else
        CC_ROLE=$role cc_codex "$model" "$effort" "$prompt"
      fi
      ;;
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
