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
#   { "difficulties": { "<diff>": {"provider":"claude|codex|gemini",
#                                  "model":"...", "effort":"..."} },
#     "roles": { "composer":"<diff>", "checker":"<diff>", "reviewFloor":"<diff>" } }
#
# Providers (all subscription auth, never committed — see autorun.sh auth sync):
#   claude → claude CLI  (CLAUDE_CODE_OAUTH_TOKEN env; effort low|medium|high|xhigh|max)
#   codex  → codex CLI   (~/.codex/auth.json; model_reasoning_effort low|medium|high|xhigh)
#   gemini → agy CLI     (Antigravity; ~/.gemini oauth; effort baked into model name,
#                         e.g. "Gemini 3.1 Pro (High)")
#
# Legacy tier labels still resolve (tier:sonnet→easy, tier:opus→intermediate,
# tier:fable→max) so old issues keep working.

MF_MODELS_FILE=${MF_MODELS_FILE:-$MFSTATE/control/models.json}
MF_ROLE_TIMEOUT=${MF_ROLE_TIMEOUT:-7200}   # hard cap per codex/agy role run (s)

DIFF_ORDER="easy normal intermediate hard max"

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

diff_cfg_from_json(){ # $1=file $2=difficulty — empty output when absent/invalid
  jq -r --arg d "$2" '
    .difficulties[$d]? // empty
    | select((.provider=="claude" or .provider=="codex" or .provider=="gemini")
             and ((.model // "") | type=="string" and length>0))
    | [.provider, .model, (.effort // "")] | join("|")
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
# All three keep cc()'s contract: block through capacity/limit windows (retry
# forever with LIMIT_SLEEP naps), return 0 on a clean run, 1 only on a genuine
# task failure. Every run lands in the usage ledger (subscription runs at $0).

CODEX_LIMIT_RE='usage limit|rate.?limit|too many requests|quota|insufficient|(^|[^0-9])429([^0-9]|$)'
AGY_LIMIT_RE='quota|rate.?limit|too many requests|RESOURCE_EXHAUSTED|model is overloaded|capacity|(^|[^0-9])(429|529)([^0-9]|$)'

cc_codex(){ # $1=model $2=reasoning-effort(optional) $3=prompt
  local model=$1 effort=$2 prompt=$3
  local role=${CC_ROLE:-cc} issue=${CC_ISSUE:--} tries=0
  while true; do
    local out rc start dur res
    start=$(date +%s)
    out=$(timeout "$MF_ROLE_TIMEOUT" codex exec --cd "$REPO_DIR" --json \
          -m "$model" ${effort:+-c model_reasoning_effort="$effort"} \
          --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check \
          "$prompt" </dev/null 2>&1 | tee -a "$LOG"); rc=${PIPESTATUS[0]}
    dur=$(( $(date +%s) - start ))
    res=$(jq -Rrs '
      [split("\n")[] | fromjson? | select(.type=="turn.completed") | .usage // {}]
      | { i: (map(.input_tokens // 0) | add // 0),
          c: (map(.cached_input_tokens // 0) | add // 0),
          o: (map((.output_tokens // 0) + (.reasoning_output_tokens // 0)) | add // 0) }
      | {total_cost_usd: 0,
         usage: {input_tokens: (if .i - .c < 0 then 0 else .i - .c end),
                 cache_read_input_tokens: .c, output_tokens: .o}}' <<<"$out" 2>/dev/null) \
      || res='{"total_cost_usd":0}'
    if [ "$rc" = 0 ]; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" ok
      log "  ↳ ok (codex $model, ${dur}s)"
      return 0
    fi
    if grep -qiE "$CODEX_LIMIT_RE" <<<"$out"; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" retry
      notify "codex usage limit hit — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
      sleep "$LIMIT_SLEEP"; continue
    fi
    if [ "$rc" = 124 ]; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" fail
      log "  ↳ codex run timed out after ${MF_ROLE_TIMEOUT}s"
      return 1
    fi
    tries=$((tries+1))
    if [ "$tries" -lt 2 ]; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" retry
      log "  ↳ codex failed (rc=$rc) — one retry in 60s"
      sleep 60; continue
    fi
    ledger_record "$issue" "$role" "$model" "$res" "$dur" fail
    log "  ↳ genuine codex task failure (rc=$rc)"
    return 1
  done
}

cc_gemini(){ # $1=model (agy model string, effort baked in) $2=prompt
  local model=$1 prompt=$2
  local role=${CC_ROLE:-cc} issue=${CC_ISSUE:--} tries=0
  while true; do
    local out rc start dur
    start=$(date +%s)
    out=$(cd "$REPO_DIR" && timeout "$MF_ROLE_TIMEOUT" \
          agy -p "$prompt" --model "$model" --dangerously-skip-permissions \
          --print-timeout "${MF_ROLE_TIMEOUT}s" </dev/null 2>&1 | tee -a "$LOG")
    rc=${PIPESTATUS[0]}
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
    if [ "$tries" -lt 2 ]; then
      ledger_record "$issue" "$role" "$model" '{"total_cost_usd":0}' "$dur" retry
      log "  ↳ agy failed (rc=$rc) — one retry in 60s"
      sleep 60; continue
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
    codex)  CC_ROLE=$role cc_codex "$model" "$effort" "$prompt";;
    gemini) CC_ROLE=$role cc_gemini "$model" "$prompt";;
    *)      CC_ROLE=$role CC_EFFORT=$effort cc "$model" "$prompt";;
  esac
}

# ---- difficulty labels (master boot) ------------------------------------------------
mf_labels_boot(){
  gh label create diff:easy         --color 1D76DB --description "difficulty: easy — trivial/mechanical work"        --force >/dev/null 2>&1 || true
  gh label create diff:normal       --color 7CE38B --description "difficulty: normal — standard feature work"        --force >/dev/null 2>&1 || true
  gh label create diff:intermediate --color 0E8A16 --description "difficulty: intermediate — cross-cutting/stateful" --force >/dev/null 2>&1 || true
  gh label create diff:hard         --color 8250DF --description "difficulty: hard — complex engine/architecture"    --force >/dev/null 2>&1 || true
  gh label create diff:max          --color B60205 --description "difficulty: max — keystone/critical path"          --force >/dev/null 2>&1 || true
}
