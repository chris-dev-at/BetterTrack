#!/usr/bin/env bash
set -uo pipefail
STATE=/work/state; REPO_DIR=$STATE/repo; LOG=$STATE/factory.log
PROMPTS=$STATE/prompts
# Per-issue token/cost ledger. Written to a host-mounted path (compose bind-mounts
# ./usage → /work/usage) so records survive container restarts; override with LEDGER.
LEDGER=${LEDGER:-/work/usage/ledger.jsonl}
MF=claude-fable-5; MO=claude-opus-4-8; MS=claude-sonnet-5
LIMIT_SLEEP=${LIMIT_SLEEP:-1800}

log(){ printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }
notify(){ log "NOTIFY: $*"; [ -n "${FACTORY_WEBHOOK_URL:-}" ] && \
  curl -fsS -m10 -H 'Content-Type: application/json' \
    -d "{\"content\":\"🏭 BetterTrack factory: $*\"}" "$FACTORY_WEBHOOK_URL" >/dev/null || true; }

# ---- usage & cost ledger -----------------------------------------------------
# Fallback pricing (USD per 1,000,000 tokens) — ONLY consulted when a claude run
# omits total_cost_usd (rare; the CLI reports it on almost every run). Edit these as
# pricing changes. Columns: input, output, cache-read, cache-write (5-minute TTL).
declare -A PRICE_IN=(  [claude-sonnet-5]=3    [claude-opus-4-8]=5     [claude-fable-5]=10    )
declare -A PRICE_OUT=( [claude-sonnet-5]=15   [claude-opus-4-8]=25    [claude-fable-5]=50    )
declare -A PRICE_CR=(  [claude-sonnet-5]=0.30 [claude-opus-4-8]=0.50  [claude-fable-5]=2.50  )
declare -A PRICE_CW=(  [claude-sonnet-5]=3.75 [claude-opus-4-8]=6.25  [claude-fable-5]=12.50 )

# Append one JSONL record for a single role run. A missing/garbled usage line must
# never break the pipeline, so every failure path degrades to a no-op (|| true).
# Cost = total_cost_usd from the CLI when present; otherwise tokens × the table above.
ledger_record(){
  local issue=$1 role=$2 model=$3 res=$4 dur=$5 outcome=$6
  [ -n "$res" ] || res='{}'
  local in_r=${PRICE_IN[$model]:-5} out_r=${PRICE_OUT[$model]:-25}
  local cr_r=${PRICE_CR[$model]:-0.50} cw_r=${PRICE_CW[$model]:-6.25}
  mkdir -p "$(dirname "$LEDGER")" 2>/dev/null || true
  jq -cn \
    --arg ts "$(date -Is)" --arg issue "$issue" --arg role "$role" --arg model "$model" \
    --argjson dur "${dur:-0}" --arg outcome "$outcome" \
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
  local role=${CC_ROLE:-cc} issue=${CC_ISSUE:--}
  while true; do
    local out rc res err start dur
    start=$(date +%s)
    out=$(claude -p "$prompt" --model "$model" --output-format stream-json --verbose \
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
KNOW="$REPO_DIR/factory/knowledge"
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

# ---- bootstrap ----
mkdir -p "$PROMPTS"
# Seed prompts from the image copy if the prompts dir is empty (no bind-mount case).
if [ -z "$(ls -A "$PROMPTS" 2>/dev/null)" ] && [ -d /work/prompts ]; then
  cp /work/prompts/* "$PROMPTS/" 2>/dev/null || true
fi
if [ -z "$(ls -A "$PROMPTS" 2>/dev/null)" ]; then
  notify "FATAL: no prompts found in $PROMPTS — aborting"; exit 1
fi
[ -d "$REPO_DIR/.git" ] || git clone "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$REPO_DIR"
cd "$REPO_DIR"
git config user.name "bettertrack-factory"; git config user.email "factory@bettertrack.local"
git remote set-url origin "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
export GH_REPO="$REPO"
notify "factory started"

# Don't even begin a cycle if tokens are already exhausted at boot.
wait_for_capacity "startup"

while true; do
  [ -f "$STATE/STOP" ] && { notify "STOP file present — exiting"; exit 0; }
  git checkout -q main && git fetch -q origin main && git reset -q --hard origin/main
  # Regenerate the knowledge pack from the fresh tree (non-fatal on failure).
  node factory/knowledge/build.mjs 2>>"$LOG" || log "knowledge build failed (non-fatal)"

  # stuck guard
  stuck=$(gh issue list --label needs-human --state open --json number -q 'length')
  if [ "$stuck" -ge "${STUCK_LIMIT:-5}" ]; then
    notify "$stuck issues need a human — pausing 1h"; sleep 3600; continue; fi

  # planner: keep the queue full
  backlog=$(gh issue list --label autopilot --state open --json number -q 'length')
  if [ "$backlog" -lt "${MIN_BACKLOG:-3}" ]; then
    log "backlog=$backlog → running planner"
    CC_ISSUE=- CC_ROLE=planner cc "$MO" "$(with_pack "$(sed "s/\$PLANNER_BATCH/${PLANNER_BATCH:-10}/g; s/{{BATCH}}/${PLANNER_BATCH:-10}/g; s/{{AFTER_V1}}/${AFTER_V1:-propose}/g" "$PROMPTS/planner.md")")" || true
    backlog=$(gh issue list --label autopilot --state open --json number -q 'length')
    [ "$backlog" -eq 0 ] && { notify "planner produced nothing (v1 done or awaiting owner) — idling 2h"; sleep 7200; continue; }
  fi

  # pick the oldest actionable issue
  n=$(gh issue list --label autopilot --state open --json number -q 'sort_by(.number)|.[0].number')
  [ -z "$n" ] && { sleep 60; continue; }
  # `gh issue list` reads GitHub's eventually-consistent search index; right after a
  # merge it can still return the just-closed issue, spawning a ghost writer cycle.
  # Re-check the pick against the authoritative issue record and let the index settle.
  fresh=$(gh issue view "$n" --json state,labels -q '"\(.state) \([.labels[].name]|join(","))"' 2>/dev/null)
  case "$fresh" in
    OPEN\ *autopilot*) ;;
    *) log "issue #$n stale in search index ($fresh) — settling 30s"; sleep 30; continue;;
  esac
  gh issue edit "$n" --add-label in-progress >/dev/null 2>&1 || true
  CC_ISSUE="$n"   # tag every cc() run this cycle with the issue number for the ledger
  log "=== issue #$n ==="

  # WRITER — cc() already waits out token limits, so a failure here is genuine.
  # Give it a couple of attempts for transient (non-capacity) hiccups.
  writer_ok=0
  for w_try in $(seq 1 "${WRITER_RETRIES:-2}"); do
    if CC_ROLE=writer cc "$(tier_model "$n")" "$(with_pack "$(sed "s/{{N}}/$n/g" "$PROMPTS/writer.md")")"; then
      writer_ok=1; break
    fi
    log "writer attempt $w_try/${WRITER_RETRIES:-2} failed"
    [ "$w_try" -lt "${WRITER_RETRIES:-2}" ] && sleep "${WRITER_RETRY_SLEEP:-60}"
  done
  [ "$writer_ok" -eq 1 ] || { mark_human "$n" "writer failed after ${WRITER_RETRIES:-2} attempts"; continue; }

  pr=$(gh pr list --head "task/$n" --state open --json number -q '.[0].number')
  if [ -z "$pr" ]; then
    # No PR: the writer may have self-marked the issue (already done / ambiguous).
    state=$(gh issue view "$n" --json state -q '.state' 2>/dev/null)
    labels=$(gh issue view "$n" --json labels -q '.labels[].name' 2>/dev/null)
    if [ "$state" = "CLOSED" ] || grep -q needs-human <<<"$labels"; then
      gh issue edit "$n" --remove-label in-progress,autopilot >/dev/null 2>&1 || true
      log "issue #$n self-resolved by writer (no PR needed)"; issue_cost "$n"; continue
    fi
    mark_human "$n" "no PR appeared"; continue
  fi

  # REVIEW → FIX rounds
  approved=0
  for round in $(seq 1 "${MAX_FIX_ROUNDS:-2}"); do
    rmodel=$MO; [ "$(tier_model "$n")" = "$MF" ] && rmodel=$MF
    CC_ROLE=reviewer cc "$rmodel" "$(with_pack "$(sed "s/{{PR}}/$pr/g; s/{{N}}/$n/g" "$PROMPTS/reviewer.md")")" || true
    verdict=$(gh pr view "$pr" --json comments -q '.comments[].body' | grep -oE 'FACTORY-VERDICT: (APPROVE|REQUEST_CHANGES)' | tail -1)
    [ "$verdict" = "FACTORY-VERDICT: APPROVE" ] && { approved=1; break; }
    log "round $round: changes requested"
    CC_ROLE=fixer cc "$(tier_model "$n")" "$(with_pack "$(sed "s/{{PR}}/$pr/g" "$PROMPTS/fixer.md")")" || true
  done
  [ "$approved" -eq 1 ] || { mark_human "$n" "review not clean after ${MAX_FIX_ROUNDS:-2} rounds"; continue; }

  # GATE: CI green (one automated fix attempt), then merge
  if ! gh pr checks "$pr" --watch --fail-fast; then
    log "CI red — one fix attempt"
    CC_ROLE=ci-fix cc "$(tier_model "$n")" "CI failed on PR #$pr of $REPO. cd into the repo, check out the PR branch, run 'gh pr checks $pr' and 'gh run view --log-failed' to see why, fix it properly (no test-deletion, no skips), run the tests locally, push." || true
    gh pr checks "$pr" --watch --fail-fast || { mark_human "$n" "CI red after fix attempt"; continue; }
  fi
  merged=0
  if gh pr merge "$pr" --squash --delete-branch; then merged=1; else
    # The repo requires branches up to date with base; if main moved during this
    # cycle the merge fails as BEHIND. Update the branch, let the new checks
    # register, re-gate on CI, and retry once before involving a human.
    log "merge failed — updating branch, re-gating CI, retrying once"
    if gh pr update-branch "$pr" && sleep 15 \
       && gh pr checks "$pr" --watch --fail-fast \
       && gh pr merge "$pr" --squash --delete-branch; then merged=1; fi
  fi
  if [ "$merged" -eq 1 ]; then
    gh issue close "$n" >/dev/null 2>&1 || true
    gh issue edit "$n" --remove-label in-progress,autopilot >/dev/null 2>&1 || true
    notify "merged PR #$pr (issue #$n) ✅"; issue_cost "$n"
  else
    mark_human "$n" "merge failed"
  fi
  [ "${ONE_SHOT:-0}" = "1" ] && { log "ONE_SHOT done"; exit 0; }
done
