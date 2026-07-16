#!/usr/bin/env bash
# factory/lib.sh — shared battle-tested internals for the BetterTrack factories.
#
# Sourced by factory/run.sh (single factory) and multi-factory/master.sh +
# multi-factory/worker.sh. Extracted MECHANICALLY from run.sh — same function
# bodies, same env expectations. Callers must set BEFORE sourcing:
#
#   STATE     e.g. /work/state      (container state dir)
#   REPO_DIR  e.g. $STATE/repo      (the factory's own clone)
#   LOG       e.g. $STATE/factory.log
#
# Optional (multi-factory additions; every one is a no-op when unset, so the
# single factory's behavior/output stays byte-identical):
#
#   LOG_TAG      "[master]" / "[w1]" / "[w2]" — prefixes factory event lines
#   MF_EVENTLOG  shared events file — log() mirrors event lines there for the
#                control dashboard (agent streams never go there)
#   FACTORY_NAME / WORKER_ID — extra fields on ledger records
LEDGER=${LEDGER:-/work/usage/ledger.jsonl}
MF=claude-fable-5; MO=claude-opus-4-8; MS=claude-sonnet-5
LIMIT_SLEEP=${LIMIT_SLEEP:-1800}
KNOW="$REPO_DIR/factory/knowledge"

log(){ printf '%s %s\n' "$(date -Is)" "${LOG_TAG:+$LOG_TAG }$*" | tee -a "$LOG"
  [ -n "${MF_EVENTLOG:-}" ] && printf '%s %s\n' "$(date -Is)" "${LOG_TAG:+$LOG_TAG }$*" >>"$MF_EVENTLOG" 2>/dev/null || true; }
notify(){ log "NOTIFY: $*"; [ -n "${FACTORY_WEBHOOK_URL:-}" ] && \
  curl -fsS -m10 -H 'Content-Type: application/json' \
    -d "{\"content\":\"🏭 BetterTrack factory: $*\"}" "$FACTORY_WEBHOOK_URL" >/dev/null || true; }

# ---- usage & cost ledger -----------------------------------------------------
# Fallback pricing (USD per 1,000,000 tokens) — ONLY consulted when a claude run
# omits total_cost_usd (rare; the CLI reports it on almost every run). Edit these as
# pricing changes. Columns: input, output, cache-read, cache-write (5-minute TTL).
# Guarded behind eval: macOS ships bash 3.2 (no associative arrays), and the
# multi-factory test harness sources this file on the host — under `set -u` a
# bare assoc literal would arithmetic-evaluate the keys ("claude: unbound
# variable"). Containers run bash ≥4; on bash 3 the tables simply stay unset and
# ledger_record's ${PRICE_IN[...]:-0} fallback yields 0 (host never records).
if [ "${BASH_VERSINFO[0]:-3}" -ge 4 ]; then
  eval 'declare -A PRICE_IN=(  [claude-sonnet-5]=3    [claude-opus-4-8]=5     [claude-fable-5]=10    )
        declare -A PRICE_OUT=( [claude-sonnet-5]=15   [claude-opus-4-8]=25    [claude-fable-5]=50    )
        declare -A PRICE_CR=(  [claude-sonnet-5]=0.30 [claude-opus-4-8]=0.50  [claude-fable-5]=2.50  )
        declare -A PRICE_CW=(  [claude-sonnet-5]=3.75 [claude-opus-4-8]=6.25  [claude-fable-5]=12.50 )'
fi

# Append one JSONL record for a single role run. A missing/garbled usage line must
# never break the pipeline, so every failure path degrades to a no-op (|| true).
# Cost = total_cost_usd from the CLI when present; otherwise tokens × the table above.
# When FACTORY_NAME / WORKER_ID are set (multi-factory), records carry extra
# factory/worker fields; absent (single factory) the record shape is unchanged.
ledger_record(){
  local issue=$1 role=$2 model=$3 res=$4 dur=$5 outcome=$6
  [ -n "$res" ] || res='{}'
  local in_r=${PRICE_IN[$model]:-5} out_r=${PRICE_OUT[$model]:-25}
  local cr_r=${PRICE_CR[$model]:-0.50} cw_r=${PRICE_CW[$model]:-6.25}
  mkdir -p "$(dirname "$LEDGER")" 2>/dev/null || true
  jq -cn \
    --arg ts "$(date -Is)" --arg issue "$issue" --arg role "$role" --arg model "$model" \
    --argjson dur "${dur:-0}" --arg outcome "$outcome" \
    --arg factory "${FACTORY_NAME:-}" --arg worker "${WORKER_ID:-}" \
    --argjson in_r "$in_r" --argjson out_r "$out_r" --argjson cr_r "$cr_r" --argjson cw_r "$cw_r" \
    --argjson res "$res" '
      ($res.usage // {}) as $u
    | ($u.input_tokens // 0) as $it
    | ($u.output_tokens // 0) as $ot
    | ($u.cache_read_input_tokens // 0) as $crt
    | ($u.cache_creation_input_tokens // 0) as $cwt
    | (if ($res.total_cost_usd|type)=="number" then $res.total_cost_usd
       else ($it*$in_r + $ot*$out_r + $crt*$cr_r + $cwt*$cw_r)/1000000 end) as $cost
    | {ts:$ts, issue:$issue, role:$role, model:$model,
       input_tokens:$it, output_tokens:$ot,
       cache_read_tokens:$crt, cache_creation_tokens:$cwt,
       cost_usd:(($cost*10000|round)/10000), duration_s:$dur, outcome:$outcome}
      + (if $factory != "" then {factory:$factory} else {} end)
      + (if $worker  != "" then {worker:$worker}   else {} end)
    ' >>"$LEDGER" 2>/dev/null || true
}

# After an issue's cycle ends, log a timestamped COST line (visible in docker logs).
# Sums ALL of the issue's records — writer/reviewer/fixer plus any retries/failures.
issue_cost(){
  local n=$1 line
  [ -s "$LEDGER" ] || return 0
  line=$(jq -R 'fromjson?' "$LEDGER" 2>/dev/null | jq -rs --arg n "$n" '
      def usd: (.*100|round) as $c
             | ($c/100|floor|tostring) + "." + ((($c%100)+100|tostring)[1:]);
      map(select(.issue==$n))
    | if length==0 then empty
      else (map(.cost_usd)|add) as $tot
        | ( group_by(.role)
            | map({role:.[0].role, c:(map(.cost_usd)|add)})
            | sort_by(-.c) | map("\(.role) $\(.c|usd)") | join(", ") ) as $bd
        | "COST: issue #\($n) — $\($tot|usd) total (\($bd))"
      end') || return 0
  [ -n "$line" ] && log "$line"
}

# Limit wording we look for ONLY inside the structured result line (never the raw
# event stream, which carries benign "rate_limit_event" objects on every run).
LIMIT_RE='usage limit|limit reached|limit will reset|quota|insufficient (credit|balance|funds)|overloaded|(^|[^0-9])(429|529)([^0-9]|$)'

# Transport/stream drops: recoverable blips (a connection reset, a socket hang up,
# a mid-response close) that must NOT burn a caller's attempt budget — they are
# retried in place by cc(). Unlike LIMIT_RE these surface as plain CLI error text
# on the raw run output, not inside the structured result line, so cc() classifies
# $out (benign JSON events never carry these exact phrases).
TRANSIENT_RE='Connection closed mid-response|ECONNRESET|ETIMEDOUT|stream disconnected|socket hang up|fetch failed|Premature close|EAI_AGAIN'

# Pure classifier (unit-tested in multi-factory/test.sh): map a run's error/output
# text to one of transient | limit | genuine. Transport drops win over limit
# wording so a real blip is never mistaken for an exhausted-token wait; a genuine
# usage-limit message (no transport phrase) still classifies as limit; everything
# else is a genuine task failure.
cc_classify(){
  local text=$1
  printf '%s' "$text" | grep -qiE "$TRANSIENT_RE" && { echo transient; return; }
  printf '%s' "$text" | grep -qiE "$LIMIT_RE"     && { echo limit;     return; }
  echo genuine
}

# Is a specific model usable right now? Fable is intermittently unavailable; when
# it is, its tier:fable issues are skipped (not failed) until it returns.
model_ok(){
  claude -p "Reply with exactly: ok" --model "$1" --output-format json \
    --dangerously-skip-permissions 2>/dev/null \
    | jq -e 'select(.is_error==false)' >/dev/null 2>&1
}

# Cheap capacity probe on the cheapest model: tells "tokens exhausted" apart from
# "the task genuinely failed".
api_ok(){ model_ok "$MS"; }

# Block until the subscription has capacity again. This IS the "wait for tokens
# to replenish, then continue" behaviour the factory is built around.
wait_for_capacity(){
  local why=$1
  while ! api_ok; do
    notify "tokens/capacity exhausted ($why) — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
    sleep "$LIMIT_SLEEP"
  done
}

# Headless Claude call. Streams progress to the log, detects success/failure from
# the structured result line, and — crucially — never reports failure when the
# real problem is exhausted tokens: in that case it waits and retries forever.
# Returns 0 on a clean run, 1 only on a genuine (non-capacity) task failure.
cc(){ local model=$1; shift; local prompt="$*"
  # Role/issue for the usage ledger — set by callers (CC_ROLE / CC_ISSUE); default
  # to a generic bucket so an un-tagged call still records without failing.
  local role=${CC_ROLE:-cc} issue=${CC_ISSUE:--} transient_tries=0
  while true; do
    local out rc res err start dur
    start=$(date +%s)
    # CC_EFFORT (optional, multi-factory difficulty routing): adds --effort; when
    # unset the command line is byte-identical to the original single-factory call.
    out=$(claude -p "$prompt" --model "$model" ${CC_EFFORT:+--effort "$CC_EFFORT"} \
          --output-format stream-json --verbose \
          --dangerously-skip-permissions 2>&1 | tee -a "$LOG"); rc=${PIPESTATUS[0]}
    dur=$(( $(date +%s) - start ))
    res=$(grep '"type":"result"' <<<"$out" | tail -1)
    err=$(jq -r 'try .is_error catch "x"' <<<"$res" 2>/dev/null)
    if [ "$err" = "false" ]; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" ok
      log "  ↳ ok ($(jq -r 'try "\(.num_turns) turns, $\(.total_cost_usd)" catch "done"' <<<"$res"))"
      return 0
    fi
    # Failure. Look for limit wording ONLY in the result line's subtype/result
    # text — the raw event stream carries benign "rate_limit_event" objects that
    # must never be mistaken for an error.
    local sig; sig=$(jq -r 'try ((.subtype // "")+" "+(.result // "")) catch ""' <<<"$res" 2>/dev/null)
    if printf '%s' "$sig" | grep -qiE "$LIMIT_RE"; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" retry
      notify "usage limit hit — sleeping $((LIMIT_SLEEP/60))m, auto-resume"
      sleep "$LIMIT_SLEEP"; continue
    fi
    # Transient transport/stream drop: retry IN PLACE (bounded), so a recoverable
    # blip never consumes one of the caller's writer attempts. The drop shows up as
    # plain CLI error text on $out, not in $sig, so classify the raw output. Limit
    # wording keeps its own wait path above; only a 'transient' verdict acts here.
    if [ "$(cc_classify "$out")" = transient ] && [ "$transient_tries" -lt "${CC_TRANSIENT_MAX:-3}" ]; then
      transient_tries=$((transient_tries+1))
      ledger_record "$issue" "$role" "$model" "$res" "$dur" retry
      log "  ↳ transient transport error — retry $transient_tries/${CC_TRANSIENT_MAX:-3}"
      sleep "${CC_TRANSIENT_SLEEP:-45}"; continue
    fi
    # Ambiguous failure (rc=$rc, no result line, or is_error without a clear
    # limit message). Probe the API: if it's also down, treat as capacity and
    # wait; otherwise it's a real task failure — let the caller handle it.
    if ! api_ok; then
      ledger_record "$issue" "$role" "$model" "$res" "$dur" retry
      wait_for_capacity "ambiguous failure rc=$rc"; continue
    fi
    ledger_record "$issue" "$role" "$model" "$res" "$dur" fail
    log "  ↳ genuine task failure (rc=$rc, is_error=$err)"
    return 1
  done
}

tier_model(){ case "$(gh issue view "$1" --json labels -q '.labels[].name' | grep '^tier:' || true)" in
  tier:fable) echo "$MF";; tier:sonnet) echo "$MS";; *) echo "$MO";; esac; }

mark_human(){ gh issue edit "$1" --add-label needs-human --remove-label autopilot,in-progress >/dev/null 2>&1 || true
  notify "issue #$1 → needs-human ($2)"; issue_cost "$1"; }

# ---- knowledge pack ----------------------------------------------------------
# Standing context injected into every role prompt so agents skip cold-start
# re-reads of PROJECTPLAN/MODELUSE/CLAUDE and tree exploration. PACK.md + MAP.md
# are committed/regenerated; the STATE block is live. Every gh/git call degrades
# gracefully (|| true) so pack() can never abort a cycle.
pack(){
  echo "=== FACTORY KNOWLEDGE PACK ==="
  [ -f "$KNOW/PACK.md" ] && cat "$KNOW/PACK.md"
  if [ -f "$KNOW/MAP.md" ]; then echo; cat "$KNOW/MAP.md"; fi
  echo; echo "=== LIVE STATE (generated $(date -Is)) ==="
  echo "## Recent commits (main, newest first)"
  git -C "$REPO_DIR" log --oneline -15 2>/dev/null || true
  echo; echo "## Open autopilot issues (queued for the factory)"
  gh issue list --label autopilot --state open --json number,title,labels \
    -q '.[]|"#\(.number) \(.title) [\(.labels|map(.name)|join(","))]"' 2>/dev/null || true
  echo "## Open awaiting-owner issues (planned; NOT autopilot)"
  gh issue list --label awaiting-owner --state open --json number,title \
    -q '.[]|"#\(.number) \(.title)"' 2>/dev/null || true
  echo "## Open needs-human issues (stuck)"
  gh issue list --label needs-human --state open --json number,title \
    -q '.[]|"#\(.number) \(.title)"' 2>/dev/null || true
  echo "## Open PRs"
  gh pr list --state open --json number,title,headRefName \
    -q '.[]|"#\(.number) \(.title) (\(.headRefName))"' 2>/dev/null || true
  echo "=== END PACK ==="
}
# Prepend the pack to a role prompt as ONE argument (data-safe: backticks/quotes/%
# in the pack are inert since they are printf DATA, not the format string).
with_pack(){ printf '%s\n\n%s' "$(pack)" "$1"; }

# ---- merge with BEHIND re-gate -----------------------------------------------
# Squash-merge a PR; on failure assume the repo's "branch must be up to date"
# rule bit us because main moved during the cycle. Update the branch and re-gate —
# but GitHub's update-branch push does not always trigger workflows (0 check
# runs on the new head ⇒ the required check can never report and the PR
# blocks forever), and the checks rollup lags briefly after the head moves.
# So: update, poll the new head's actual check runs, kick CI via
# close/reopen if none appear, then gate and retry the merge once.
# Returns 0 on merge, 1 when the retry also failed.
merge_with_regate(){
  local pr=$1
  if gh pr merge "$pr" --squash --delete-branch; then return 0; fi
  log "merge failed — updating branch, re-gating CI, retrying once"
  gh pr update-branch "$pr" >/dev/null 2>&1 || true
  sleep 20
  local head i
  head=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
  for i in 1 2 3 4 5 6; do
    [ "$(gh api "repos/$REPO/commits/$head/check-runs" --jq .total_count 2>/dev/null || echo 0)" != "0" ] && break
    if [ "$i" = "3" ]; then
      log "no CI on updated head — close/reopen PR #$pr to trigger workflows"
      gh pr close "$pr" >/dev/null 2>&1 && sleep 5 && gh pr reopen "$pr" >/dev/null 2>&1 || true
    fi
    sleep 30
  done
  if gh pr checks "$pr" --watch --fail-fast \
     && gh pr merge "$pr" --squash --delete-branch; then return 0; fi
  return 1
}
