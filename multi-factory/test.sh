#!/usr/bin/env bash
# multi-factory/test.sh — offline unit tests for the deterministic scheduler core.
#
# Sources master.sh with MF_SOURCE_ONLY=1 (lib.sh + boot + loop skipped), stubs
# gh/log/notify, and drives the pure functions with fabricated issues and state
# files: mf-meta parsing, claim conflicts, assignment, dependency gating, FIFO
# order, acks and stall recovery (BRIEF acceptance test 1, offline half).
# Run on the host: ./multi-factory/test.sh   (no Docker, no network, no tokens)
set -uo pipefail
TEST_SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$TEST_SCRIPT_DIR"

T=$(mktemp -d)
TEST_ROOT_BASHPID=${BASHPID:-}
TEST_ROOT_SUBSHELL=${BASH_SUBSHELL:-0}
test_cleanup(){
  if [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]; then
    [ -n "$TEST_ROOT_BASHPID" ] || return 0
    [ "${BASHPID:-}" = "$TEST_ROOT_BASHPID" ] || return 0
  else
    # Best-effort Bash 3.2 guard for the parenthesized-child regression below.
    [ "${BASH_SUBSHELL:-0}" -eq "$TEST_ROOT_SUBSHELL" ] || return 0
  fi
  rm -rf "$T"
}
trap test_cleanup EXIT
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
bad(){ FAIL=$((FAIL+1)); printf '  ✗ %s\n' "$1"; }
check(){ # $1=description $2=expected $3=actual
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (expected [$2], got [$3])"; fi
}
backdate(){ # $1=file $2=seconds-ago — portable mtime rewind (GNU + BSD/macOS touch)
  local ts=$(( $(date +%s) - $2 ))
  touch -d "@$ts" "$1" 2>/dev/null || touch -t "$(date -r "$ts" +%Y%m%d%H%M.%S)" "$1"
}

# ---- environment + stubs --------------------------------------------------------
export MFSTATE=$T/state
mkdir -p "$MFSTATE/assignments" "$MFSTATE/status" "$MFSTATE/merge-queue" "$MFSTATE/control" "$MFSTATE/logs"
export TICK_ISSUES=$T/issues.json
export TICK_DEPS=$T/deps; mkdir -p "$TICK_DEPS"
export WORKERS=2 REPO=stub/repo STATE=$T/cstate REPO_DIR=$T/repo LOG=$T/log MF_DRY_RUN=1

# gh stub: `gh api repos/stub/repo/issues/N` prints the state from $T/ghdeps/N;
# every mutating call is swallowed and recorded.
mkdir -p "$T/bin" "$T/ghdeps"
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "api repos/stub/repo/issues/"*)
    n=${2##*/}
    cat "${GH_STUB_DIR}/${n}" 2>/dev/null || echo open
    exit 0;;
  "issue edit"|"pr list"|"pr view"|"label create")
    echo "$@" >>"${GH_STUB_DIR}/calls.log"; exit 0;;
  *) echo "$@" >>"${GH_STUB_DIR}/calls.log"; exit 0;;
esac
STUB
chmod +x "$T/bin/gh"
export GH_STUB_DIR=$T/ghdeps
export PATH=$T/bin:$PATH

log(){ :; }; notify(){ :; }
MF_SOURCE_ONLY=1 . ./master.sh

echo "— mf-meta parsing"
BODY_FULL='Some issue text.

<!-- mf-meta
depends-on: 143, 145
touches: apps/api/src/services/social/**
touches: packages/contracts/src/social.ts
-->'
check "depends-on parsed" "143 145" "$(mf_meta_deps <<<"$BODY_FULL")"
check "touches parsed (2 lines)" "apps/api/src/services/social/**
packages/contracts/src/social.ts" "$(mf_meta_touches <<<"$BODY_FULL")"
check "no meta block → no deps" "" "$(mf_meta_deps <<<'plain body')"
check "no meta block → no touches" "" "$(mf_meta_touches <<<'plain body')"

echo "— claim conflict test (BRIEF §5.2 examples)"
claims_conflict 'apps/api/**' 'apps/api/src/x.ts' && ok "apps/api/** vs apps/api/src/x.ts → conflict" || bad "apps/api/** vs apps/api/src/x.ts should conflict"
claims_conflict 'apps/api/**' 'apps/web/**' && bad "apps/api/** vs apps/web/** should NOT conflict" || ok "apps/api/** vs apps/web/** → fine"
claims_conflict '**' 'apps/web/pages/x.tsx' && ok "** conflicts with everything" || bad "** should conflict with everything"
claims_conflict 'packages/contracts/src/social.ts' 'packages/contracts/src/social.ts' && ok "identical file claims conflict" || bad "identical claims should conflict"
claims_conflict 'apps/api/src/routes/**' 'apps/api/src/routes-v2/**' && bad "routes/** vs routes-v2/** should NOT conflict (with '/' kept)" || ok "routes/** vs routes-v2/** → fine"

echo "— scheduler: assignment + conflict serialization"
cat >"$TICK_ISSUES" <<'JSON'
[
 {"number":201,"title":"A backend","body":"x\n<!-- mf-meta\ntouches: apps/api/**\n-->","labels":["autopilot","tier:sonnet"]},
 {"number":202,"title":"B backend overlap","body":"x\n<!-- mf-meta\ntouches: apps/api/src/y.ts\n-->","labels":["autopilot","tier:sonnet"]},
 {"number":203,"title":"C frontend","body":"x\n<!-- mf-meta\ntouches: apps/web/**\n-->","labels":["autopilot","tier:sonnet"]}
]
JSON
scheduler run
A1=$(jq -r '.issue' "$MFSTATE/assignments/worker-1.json" 2>/dev/null || echo none)
A2=$(jq -r '.issue' "$MFSTATE/assignments/worker-2.json" 2>/dev/null || echo none)
check "worker 1 gets lowest runnable (#201)" "201" "$A1"
check "worker 2 skips conflicting #202, gets #203" "203" "$A2"
check "conflicting #202 stays unassigned" "" "$(grep -l '"issue":202' "$MFSTATE"/assignments/*.json 2>/dev/null || true)"

echo "— scheduler: missing mf-meta serializes (runs alone)"
rm -f "$MFSTATE"/assignments/*.json
cat >"$TICK_ISSUES" <<'JSON'
[
 {"number":210,"title":"no meta","body":"no machine block here","labels":["autopilot","tier:sonnet"]},
 {"number":211,"title":"disjoint","body":"x\n<!-- mf-meta\ntouches: apps/web/**\n-->","labels":["autopilot","tier:sonnet"]}
]
JSON
scheduler run
A1=$(jq -r '.issue' "$MFSTATE/assignments/worker-1.json" 2>/dev/null || echo none)
A2=$(jq -r '.issue' "$MFSTATE/assignments/worker-2.json" 2>/dev/null || echo none)
check "meta-less issue assigned first (alone)" "210" "$A1"
check "everything else waits behind wildcard claim" "none" "$A2"

echo "— dependency gating (direct REST reads)"
rm -f "$MFSTATE"/assignments/*.json; rm -rf "$TICK_DEPS"; mkdir -p "$TICK_DEPS"
cat >"$TICK_ISSUES" <<'JSON'
[
 {"number":220,"title":"dep open","body":"x\n<!-- mf-meta\ndepends-on: 900\ntouches: apps/api/**\n-->","labels":["autopilot","tier:sonnet"]},
 {"number":221,"title":"dep closed","body":"x\n<!-- mf-meta\ndepends-on: 901\ntouches: apps/web/**\n-->","labels":["autopilot","tier:sonnet"]}
]
JSON
echo open   >"$T/ghdeps/900"
echo closed >"$T/ghdeps/901"
check "runnable excludes open-dep issue" "221" "$(runnable_issues | xargs)"
scheduler run
check "only dep-satisfied issue assigned" "221" "$(jq -r '.issue' "$MFSTATE/assignments/worker-1.json" 2>/dev/null || echo none)"
check "open-dep issue not assigned" "1" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"

echo "— merge queue blocks conflicting claims (in-flight includes unmerged PRs)"
rm -f "$MFSTATE"/assignments/*.json
printf '%s\n' '{"pr":90,"issue":230,"touches":["apps/api/**"],"enqueued_at":"x"}' >"$MFSTATE/merge-queue/100-pr90.json"
cat >"$TICK_ISSUES" <<'JSON'
[{"number":231,"title":"overlaps queued PR","body":"x\n<!-- mf-meta\ntouches: apps/api/src/z.ts\n-->","labels":["autopilot","tier:sonnet"]}]
JSON
rm -rf "$TICK_DEPS"; mkdir -p "$TICK_DEPS"
scheduler run
check "issue overlapping queued PR stays unassigned" "0" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"
rm -f "$MFSTATE"/merge-queue/*.json

echo "— FIFO merge-queue head selection"
printf '{}' >"$MFSTATE/merge-queue/1700000200-pr7.json"
printf '{}' >"$MFSTATE/merge-queue/1700000100-pr9.json"
printf '{}' >"$MFSTATE/merge-queue/.nonqueue-state"
HEAD=$(ls "$MFSTATE/merge-queue" | grep -E '^[0-9]+-pr[0-9]+\.json$' | sort -n | head -1)
check "oldest epoch first, dotfiles ignored" "1700000100-pr9.json" "$HEAD"
rm -f "$MFSTATE"/merge-queue/* "$MFSTATE"/merge-queue/.nonqueue-state 2>/dev/null || true

echo "— process_acks removes finished assignments"
printf '%s\n' '{"issue":240,"assigned_at":"x","touches":["a/**"],"relocated":false}' >"$MFSTATE/assignments/worker-1.json"
printf '%s\n' '{"phase":"done","issue":240,"pr":91,"updated_at":"x"}' >"$MFSTATE/status/worker-1.json"
process_acks
check "done worker acked (assignment removed)" "0" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"

echo "— stall detection with fabricated state files"
# Truly dead worker: stale heartbeat AND stale status mtime → recovered (as always).
printf '%s\n' '{"issue":250,"assigned_at":"x","touches":["a/**"],"relocated":false}' >"$MFSTATE/assignments/worker-2.json"
printf '%s\n' '{"phase":"writing","issue":250,"pr":null,"updated_at":"x"}' >"$MFSTATE/status/worker-2.json"
touch -t 202001010000 "$MFSTATE/status/worker-2.hb"
backdate "$MFSTATE/status/worker-2.json" 4000   # status file itself is also stale
echo open >"$T/ghdeps/250"
MF_STALL_SECS=3600 stall_check
check "truly-dead worker (stale hb+status) recovered" "0" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"
# Live-but-silent worker (issue #497): stale heartbeat, but the status file shows an
# active phase and was written within the stall window → alive, assignment kept.
printf '%s\n' '{"issue":252,"assigned_at":"x","touches":["a/**"],"relocated":false}' >"$MFSTATE/assignments/worker-2.json"
printf '%s\n' '{"phase":"writing","issue":252,"pr":null,"updated_at":"x"}' >"$MFSTATE/status/worker-2.json"
touch -t 202001010000 "$MFSTATE/status/worker-2.hb"   # dead heartbeat toucher
echo open >"$T/ghdeps/252"
MF_STALL_SECS=3600 stall_check
check "live-but-silent worker NOT reset (active phase, fresh status)" "1" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"
check "skip-reset logged once (marker written)" "1" "$([ -f "$MFSTATE/status/.stallskip-2" ] && echo 1 || echo 0)"
rm -f "$MFSTATE"/assignments/*.json "$MFSTATE"/status/.stallskip-2
# A fresh heartbeat is never a stall regardless of status.
printf '%s\n' '{"issue":251,"assigned_at":"x","touches":["a/**"],"relocated":false}' >"$MFSTATE/assignments/worker-2.json"
printf '%s\n' '{"phase":"writing","issue":251,"pr":null,"updated_at":"x"}' >"$MFSTATE/status/worker-2.json"
date -Is >"$MFSTATE/status/worker-2.hb" 2>/dev/null || date >"$MFSTATE/status/worker-2.hb"
MF_STALL_SECS=3600 stall_check
check "fresh heartbeat NOT treated as stall" "1" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"
rm -f "$MFSTATE"/assignments/*.json

echo "— composer idle back-off (unchanged snapshot doubles, changed snapshot resets)"
rm -f "$MFSTATE"/assignments/*.json "$MFSTATE"/merge-queue/*.json 2>/dev/null || true
rm -f "$MFSTATE"/control/.composer-last "$MFSTATE"/control/.composer-backoff "$MFSTATE"/control/.composer-snapshot
rm -rf "$TICK_DEPS"; mkdir -p "$TICK_DEPS"
echo '[]' >"$TICK_ISSUES"

composer_step run
check "first run: backoff stays at base cooldown (900)" "900" "$(cat "$MFSTATE/control/.composer-backoff")"

composer_step run
check "re-eval before cooldown elapses is skipped (no change)" "900" "$(cat "$MFSTATE/control/.composer-backoff")"

backdate "$MFSTATE/control/.composer-last" 901
composer_step run
check "empty run after cooldown doubles backoff (900→1800)" "1800" "$(cat "$MFSTATE/control/.composer-backoff")"

backdate "$MFSTATE/control/.composer-last" 901
composer_step run
check "eval before the backed-off (1800s) cooldown expires is skipped" "1800" "$(cat "$MFSTATE/control/.composer-backoff")"

backdate "$MFSTATE/control/.composer-last" 1801
composer_step run
check "still-unchanged snapshot doubles again (1800→3600)" "3600" "$(cat "$MFSTATE/control/.composer-backoff")"

backdate "$MFSTATE/control/.composer-last" 3601
echo '[{"number":260,"title":"new issue appeared","body":"x","labels":["autopilot","tier:sonnet"]}]' >"$TICK_ISSUES"
composer_step run
check "open-issue set change resets backoff to base (900)" "900" "$(cat "$MFSTATE/control/.composer-backoff")"

echo "— cc() transient transport classifier (factory/lib.sh, issue #497)"
# lib.sh is the source of the classifier + regexes. Sourcing it redefines log/notify
# with the real implementations, so re-stub them right after to keep the rest quiet.
. ../factory/lib.sh
log(){ :; }; notify(){ :; }
check "classify: connection closed mid-response → transient" "transient" "$(cc_classify 'API Error: Connection closed mid-response. The response above may be incomplete.')"
check "classify: ECONNRESET → transient" "transient" "$(cc_classify 'read ECONNRESET')"
check "classify: ETIMEDOUT → transient" "transient" "$(cc_classify 'connect ETIMEDOUT 93.184.216.34:443')"
check "classify: stream disconnected → transient" "transient" "$(cc_classify 'stream disconnected before completion')"
check "classify: socket hang up → transient" "transient" "$(cc_classify 'Error: socket hang up')"
check "classify: fetch failed → transient" "transient" "$(cc_classify 'TypeError: fetch failed')"
check "classify: usage limit → limit" "limit" "$(cc_classify 'Claude usage limit reached; limit will reset at 5pm')"
check "classify: 429 → limit" "limit" "$(cc_classify 'request failed: HTTP 429 Too Many Requests')"
check "classify: overloaded → limit" "limit" "$(cc_classify 'Error: overloaded_error')"
check "classify: genuine failure → genuine" "genuine" "$(cc_classify 'is_error true — the test suite failed with 3 assertion errors')"
check "classify: empty text → genuine" "genuine" "$(cc_classify '')"
check "classify: transport wins over limit noise → transient" "transient" "$(cc_classify 'rate_limit_event ... then: socket hang up')"

echo "— worker heartbeat supervision (factory resilience, issue #497)"
# Source worker.sh in MF_SOURCE_ONLY mode (lib.sh + boot skipped) so the hb_* helpers
# are defined. HB resolves from WORKER_ID/STATUS set at source time; a real background
# toucher is spawned offline, then killed and re-ensured to prove self-healing.
export WORKER_ID=9
MF_SOURCE_ONLY=1 . ./worker.sh
hb_start
hb_alive; check "hb_start spawns a live toucher" "0" "$?"
HB_FIRST=$HB_PID
kill "$HB_FIRST" 2>/dev/null; wait "$HB_FIRST" 2>/dev/null || true
hb_alive; check "hb_alive false after the toucher is killed" "1" "$?"
hb_ensure
hb_alive; check "hb_ensure respawns a dead toucher" "0" "$?"
[ -n "$HB_PID" ] && [ "$HB_PID" != "$HB_FIRST" ] && ok "respawn has a fresh pid" || bad "respawn should have a fresh pid"

# Bash 4+ can enforce cleanup ownership with process-unique BASHPID. macOS Bash
# 3.2 lacks it, so BASH_SUBSHELL only guards this parenthesized-child regression;
# hb_start's parent-side trap suspension is the deterministic heartbeat invariant.
HB_PARENT_STATE=$T/heartbeat-parent-state
: >"$HB_PARENT_STATE"
( trap test_cleanup EXIT )
[ -f "$HB_PARENT_STATE" ] \
  && ok "parenthesized child EXIT cannot run parent test cleanup" \
  || bad "parenthesized child EXIT ran parent test cleanup"

# Stop a brand-new toucher immediately, maximizing the child-first-instruction
# race window. A harmless caller EXIT trap proves hb_start restores it byte for
# byte while withholding it from the forked child. Wrapping wait records that
# hb_stop waits for the exact heartbeat shell PID.
hb_stop
HB_INHERITED_EXIT=$T/heartbeat-inherited-exit
trap 'printf inherited >"$HB_INHERITED_EXIT"' EXIT
HB_CALLER_EXIT_TRAP=$(trap -p EXIT)
hb_start
HB_RESTORED_EXIT_TRAP=$(trap -p EXIT)
HB_STOP_PID=$HB_PID
HB_WAITED_PID=
wait(){ HB_WAITED_PID=${1:-}; builtin wait "$@"; }
hb_stop
unset -f wait
trap test_cleanup EXIT
check "hb_start restores the caller EXIT trap exactly" "$HB_CALLER_EXIT_TRAP" "$HB_RESTORED_EXIT_TRAP"
[ ! -e "$HB_INHERITED_EXIT" ] \
  && ok "heartbeat child cannot inherit caller EXIT cleanup" \
  || bad "heartbeat child inherited caller EXIT cleanup"
check "hb_stop waits for the exact toucher" "$HB_STOP_PID" "$HB_WAITED_PID"
check "hb_stop clears the pid" "" "$HB_PID"
[ -d "$T/state/control" ] \
  && ok "immediate heartbeat stop preserves parent test state" \
  || bad "immediate heartbeat stop corrupted parent test state"
kill -0 "$HB_STOP_PID" 2>/dev/null \
  && bad "hb_stop should reap its heartbeat shell" \
  || ok "hb_stop reaps its heartbeat shell"

# A separate child remains alive while hb_stop targets only its recorded toucher.
sleep 300 &
HB_BYSTANDER=$!
hb_start
hb_stop
kill -0 "$HB_BYSTANDER" 2>/dev/null \
  && ok "hb_stop leaves unrelated child processes alone" \
  || bad "hb_stop killed an unrelated child process"
kill "$HB_BYSTANDER" 2>/dev/null || true
wait "$HB_BYSTANDER" 2>/dev/null || true

echo "— writer no-PR outcomes (#746)"
OUTCOME_LOG=$T/writer-no-pr.log
OUTCOME_COST=$T/writer-no-pr-cost.log
OUTCOME_STATUS=$T/writer-no-pr-status.log
OUTCOME_GH=$T/writer-no-pr-gh.log
gh(){ printf '%s\n' "$*" >>"$OUTCOME_GH"; }
log(){ printf '%s\n' "$*" >>"$OUTCOME_LOG"; }
notify(){ log "NOTIFY: $*"; }
issue_cost(){ printf '%s\n' "$1" >>"$OUTCOME_COST"; }
wstatus(){ printf '%s|%s|%s\n' "$1" "$2" "${3:-null}" >>"$OUTCOME_STATUS"; }

: >"$OUTCOME_LOG"; : >"$OUTCOME_COST"; : >"$OUTCOME_STATUS"; : >"$OUTCOME_GH"
CLOSED_RC=0
writer_no_pr_outcome 746 CLOSED '' || CLOSED_RC=$?
check "closed writer issue keeps self-resolved log" "1" \
  "$(grep -Fxc 'issue #746 self-resolved by writer (no PR needed)' "$OUTCOME_LOG")"
check "closed writer issue acks done" "done|746|null" "$(<"$OUTCOME_STATUS")"
check "closed writer issue records cost" "746" "$(<"$OUTCOME_COST")"
check "closed writer issue outcome succeeds" "0" "$CLOSED_RC"

: >"$OUTCOME_LOG"; : >"$OUTCOME_COST"; : >"$OUTCOME_STATUS"; : >"$OUTCOME_GH"
HUMAN_RC=0
writer_no_pr_outcome 747 OPEN $'autopilot\nneeds-human' || HUMAN_RC=$?
check "needs-human writer issue logs escalation" "1" \
  "$(grep -Fxc 'issue #747 escalated to needs-human by writer (no PR)' "$OUTCOME_LOG")"
check "needs-human writer issue never claims self-resolution" "0" \
  "$(grep -Fxc 'issue #747 self-resolved by writer (no PR needed)' "$OUTCOME_LOG" || true)"
check "needs-human writer issue emits NOTIFY" "1" \
  "$(grep -Fxc 'NOTIFY: issue #747 escalated to needs-human by writer (no PR)' "$OUTCOME_LOG")"
check "needs-human writer issue acks failed, not done" "failed|747|null" "$(<"$OUTCOME_STATUS")"
check "needs-human writer issue records cost" "747" "$(<"$OUTCOME_COST")"
check "needs-human writer issue outcome is distinguishable" "1" "$HUMAN_RC"

echo "— headless fixer routing authority"
FIXER_PROMPT=../factory/prompts/fixer.md
grep -q 'tier-and-delegation rules do NOT apply here' "$FIXER_PROMPT" \
  && ok "fixer prompt overrides interactive tier/delegation rules" \
  || bad "fixer prompt must override interactive tier/delegation rules"
grep -q 'Do not refuse the fix or request a model switch' "$FIXER_PROMPT" \
  && ok "fixer prompt forbids model-switch refusal" \
  || bad "fixer prompt must forbid model-switch refusal"
grep -q 'NEVER spawn subagents' "$FIXER_PROMPT" \
  && ok "fixer prompt keeps work in its routed session" \
  || bad "fixer prompt must forbid delegation"
unset FIXER_PROMPT

echo "— difficulty routing (mflib.sh pure helpers)"
. ./mflib.sh
check "diff_next easy→normal" "normal" "$(diff_next easy)"
check "diff_next intermediate→hard" "hard" "$(diff_next intermediate)"
check "diff_next max stays max" "max" "$(diff_next max)"
check "diff_at_least applies review floor" "intermediate" "$(diff_at_least easy intermediate)"
check "diff_at_least keeps harder issue difficulty" "max" "$(diff_at_least max intermediate)"
check "labels: diff:* wins over tier:*" "hard" "$(diff_from_labels "$(printf 'autopilot\ndiff:hard\ntier:sonnet')")"
check "labels: legacy tier:fable → max" "max" "$(diff_from_labels "$(printf 'tier:fable\nautopilot')")"
check "labels: legacy tier:sonnet → easy" "easy" "$(diff_from_labels 'tier:sonnet')"
check "labels: legacy tier:opus → intermediate" "intermediate" "$(diff_from_labels 'tier:opus')"
check "labels: unlabeled → intermediate" "intermediate" "$(diff_from_labels 'autopilot')"
check "labels: invalid diff value falls back" "intermediate" "$(diff_from_labels 'diff:banana')"
for ROUTE in \
  "claude claude-fable-5" \
  "claude claude-opus-4-8" \
  "claudex gpt-5.6-sol" \
  "claudex codex-api/gpt-5.6-sol" \
  "codex gpt-5.6-sol"; do
  ROUTE_PROVIDER=${ROUTE%% *}
  ROUTE_MODEL=${ROUTE#* }
  mf_composer_route_allowed "$ROUTE_PROVIDER" "$ROUTE_MODEL" \
    && ok "composer route allows $ROUTE_PROVIDER/$ROUTE_MODEL" \
    || bad "composer route should allow $ROUTE_PROVIDER/$ROUTE_MODEL"
done
for ROUTE in \
  "claude claude-sonnet-5" \
  "claude claude-haiku-4-5" \
  "claude claude-opus-" \
  "claude claude-opus-/haiku" \
  "claude claude-opus-4-8 extra" \
  "claudex gpt-5.6-terra" \
  "codex gpt-5.6-luna" \
  "gemini Gemini-3.1-Pro"; do
  ROUTE_PROVIDER=${ROUTE%% *}
  ROUTE_MODEL=${ROUTE#* }
  mf_composer_route_allowed "$ROUTE_PROVIDER" "$ROUTE_MODEL" \
    && bad "composer route should reject $ROUTE_PROVIDER/$ROUTE_MODEL" \
    || ok "composer route rejects $ROUTE_PROVIDER/$ROUTE_MODEL"
done
unset ROUTE ROUTE_PROVIDER ROUTE_MODEL

mf_sol_composer_route claudex gpt-5.6-sol \
  && ok "Sol composer route receives provider-specific guardrails" \
  || bad "Sol composer route should receive provider-specific guardrails"
mf_sol_composer_route claude claude-fable-5 \
  && bad "Fable composer route must not receive Sol guardrails" \
  || ok "Fable composer prompt remains on the shared unchanged path"
mf_sol_composer_route claude claude-opus-4-8 \
  && bad "Opus composer route must not receive Sol guardrails" \
  || ok "Opus composer prompt remains on the shared unchanged path"
SOL_COMPOSER_RULES=$(mf_sol_composer_instructions)
case "$SOL_COMPOSER_RULES" in
  *"NEVER use Agent"*"at most 20 tool calls"*"owner-approved brief"*)
    ok "Sol composer guardrails bound delegation, discovery, and brief handling";;
  *) bad "Sol composer guardrails are incomplete";;
esac
unset SOL_COMPOSER_RULES

FABLE_PROMPT='shared composer prompt — byte-identical sentinel'
FABLE_CAPTURE=$T/fable-composer-prompt
FABLE_LIMITS=$T/fable-composer-limits
FABLE_MODELS=$T/fable-composer-models.json
printf '%s\n' \
  '{"difficulties":{"max":{"provider":"claude","model":"claude-fable-5","effort":"max"}}}' \
  >"$FABLE_MODELS"
(
  MF_MODELS_FILE=$FABLE_MODELS
  MF_ROLE_TIMEOUT=777
  CC_MAX_TURNS=23
  cc(){
    printf '%s' "$2" >"$FABLE_CAPTURE"
    printf '%s|%s' "$MF_ROLE_TIMEOUT" "$CC_MAX_TURNS" >"$FABLE_LIMITS"
  }
  mf_cc composer max "$FABLE_PROMPT"
)
check "Fable receives the shared composer prompt byte-identically" \
  "$FABLE_PROMPT" "$(<"$FABLE_CAPTURE")"
check "Fable keeps its existing timeout/turn settings untouched" \
  "777|23" "$(<"$FABLE_LIMITS")"

SOL_CAPTURE=$T/sol-composer-prompt
SOL_LIMITS=$T/sol-composer-limits
SOL_MODELS=$T/sol-composer-models.json
printf '%s\n' \
  '{"difficulties":{"max":{"provider":"claudex","model":"gpt-5.6-sol","effort":"high"}}}' \
  >"$SOL_MODELS"
(
  MF_MODELS_FILE=$SOL_MODELS
  MF_ROLE_TIMEOUT=777
  CC_MAX_TURNS=23
  cc_claudex(){
    printf '%s' "$3" >"$SOL_CAPTURE"
    printf '%s|%s' "$MF_ROLE_TIMEOUT" "$CC_MAX_TURNS" >"$SOL_LIMITS"
  }
  mf_cc composer max "$FABLE_PROMPT"
)
grep -q 'SOL-SPECIFIC COMPOSER EXECUTION CONTRACT' "$SOL_CAPTURE" \
  && ok "Sol receives the provider-specific composer contract" \
  || bad "Sol composer contract was not appended"
check "Sol composer gets bounded timeout and turn cap" \
  "1200|40" "$(<"$SOL_LIMITS")"
unset FABLE_PROMPT FABLE_CAPTURE FABLE_LIMITS FABLE_MODELS
unset SOL_CAPTURE SOL_LIMITS SOL_MODELS

for BAD_MODEL in "claude-opus-" "claude-opus-/haiku" "claude-opus-4-8 extra"; do
  BAD_CAPTURE=$T/rejected-composer-dispatch
  BAD_MODELS=$T/rejected-composer-models.json
  rm -f "$BAD_CAPTURE"
  printf '{"difficulties":{"max":{"provider":"claude","model":"%s","effort":"high"}}}\n' \
    "$BAD_MODEL" >"$BAD_MODELS"
  if (
    MF_MODELS_FILE=$BAD_MODELS
    cc(){ : >"$BAD_CAPTURE"; }
    mf_cc composer max 'must not dispatch'
  ); then
    bad "malformed composer route should fail closed: $BAD_MODEL"
  else
    ok "malformed composer route fails closed: $BAD_MODEL"
  fi
  [ ! -e "$BAD_CAPTURE" ] \
    && ok "malformed composer route makes no provider call: $BAD_MODEL" \
    || bad "malformed composer route reached provider: $BAD_MODEL"
done
unset BAD_MODEL BAD_CAPTURE BAD_MODELS

echo "— difficulty → model config (state/control/models.json)"
cat >"$MFSTATE/control/models.json" <<'JSON'
{"difficulties":{
  "easy":{"provider":"gemini","model":"Gemini 3.5 Flash (Low)"},
  "hard":{"provider":"codex","model":"gpt-5.5","effort":"xhigh"},
  "max":{"provider":"pigeon","model":"carrier"}},
 "roles":{"composer":"intermediate","checker":"max","reviewFloor":"hard"}}
JSON
check "cfg: owner-set gemini entry (no effort)" "gemini|Gemini 3.5 Flash (Low)|" "$(diff_cfg easy)"
check "cfg: owner-set codex entry with effort" "codex|gpt-5.5|xhigh" "$(diff_cfg hard)"
check "cfg: invalid provider remains explicit/fail-closed" "invalid|pigeon|" "$(diff_cfg max)"
check "cfg: unset difficulty uses builtin default" "claude|claude-opus-4-8|medium" "$(diff_cfg normal)"
check "cfg: composer role slot honored" "intermediate" "$(role_diff composer)"
check "cfg: checker role slot honored" "max" "$(role_diff checker)"
check "cfg: review floor honored" "hard" "$(review_floor)"
mf_uses_claude && ok "mixed config still detects claude" || bad "mixed config should detect claude"
cat >"$MFSTATE/control/models.json" <<'JSON'
{"difficulties":{
  "easy":{"provider":"claudex","model":"gpt-5.6-luna","effort":"high"},
  "normal":{"provider":"gemini","model":"g"},
  "intermediate":{"provider":"codex","model":"c"},"hard":{"provider":"codex","model":"c"},
  "max":{"provider":"codex","model":"c","effort":"xhigh"}}}
JSON
check "cfg: ClaudeX entry accepted" "claudex|gpt-5.6-luna|high" "$(diff_cfg easy)"
mf_uses_claude && bad "claude-free config should report false" || ok "claude-free config → mf_uses_claude false"
check "cfg: flat legacy entry serves the writer slot" "claudex|gpt-5.6-luna|high" "$(diff_cfg easy writer)"
check "cfg: flat legacy entry serves the reviewer1 slot" "claudex|gpt-5.6-luna|high" "$(diff_cfg easy reviewer1)"
check "cfg: flat legacy entry serves the completion slot" "claudex|gpt-5.6-luna|high" "$(diff_cfg easy completion)"
rm -f "$MFSTATE/control/models.json"
check "cfg: missing file → builtin default" "claude|claude-sonnet-5|high" "$(diff_cfg easy)"
check "cfg: missing file → builtin default for any slot" "claude|claude-sonnet-5|high" "$(diff_cfg easy reviewer1)"
check "cfg: missing file → role default hard" "hard" "$(role_diff checker)"
check "cfg: missing file → floor default intermediate" "intermediate" "$(review_floor)"

echo "— per-role slot routing (writer/reviewer1/completion, models.json v2)"
cat >"$MFSTATE/control/models.json" <<'JSON'
{"version":2,"difficulties":{
  "easy":{"provider":"codex","model":"flat-legacy","effort":"low",
    "writer":{"provider":"codex","model":"w-model","effort":"max"},
    "reviewer1":{"provider":"claude","model":"claude-opus-5","effort":"medium"},
    "completion":{"provider":"codex","model":"c-model","effort":"max"}},
  "normal":{"provider":"codex","model":"flat-only","effort":"high"},
  "intermediate":{"writer":{"provider":"claudex","model":"bad|pipe","effort":"high"}},
  "hard":{
    "writer":{"provider":"codex","model":"gpt-5.6-sol","effort":"ultra"},
    "reviewer1":{"provider":"pigeon","model":"carrier"},
    "completion":{"model":"missing-provider"}}
}}
JSON
check "slot: writer resolves its own config" "codex|w-model|max" "$(diff_cfg easy writer)"
check "slot: reviewer1 resolves its own config" "claude|claude-opus-5|medium" "$(diff_cfg easy reviewer1)"
check "slot: completion resolves its own config" "codex|c-model|max" "$(diff_cfg easy completion)"
check "slot: slotless call keeps flat resolution" "codex|flat-legacy|low" "$(diff_cfg easy)"
check "slot: flat-only entry (v1 file) serves writer" "codex|flat-only|high" "$(diff_cfg normal writer)"
check "slot: flat-only entry (v1 file) serves reviewer1" "codex|flat-only|high" "$(diff_cfg normal reviewer1)"
check "slot: flat-only entry (v1 file) serves completion" "codex|flat-only|high" "$(diff_cfg normal completion)"
check "slot: unknown provider in a slot stays fail-closed" "invalid|pigeon|" "$(diff_cfg hard reviewer1)"
check "slot: delimiter injection in a slot fails closed" "invalid|claudex|" "$(diff_cfg intermediate writer)"
check "slot: provider-less slot falls back to builtin default" "claude|claude-opus-4-8|max" "$(diff_cfg hard completion)"
check "slot: absent slot beside other slots uses builtin default" "claude|claude-opus-4-8|high" "$(diff_cfg intermediate reviewer1)"
check "slot: unset difficulty uses builtin default for slots" "claude|claude-fable-5|max" "$(diff_cfg max reviewer1)"
mf_uses_claude && ok "slotted config detects claude usage" || bad "slotted config should detect claude"

echo "— mf_cc slot threading (role defaults + CC_SLOT override)"
SLOT_MODELS=$T/slot-models.json
SLOT_DISPATCH=$T/slot-dispatch
cat >"$SLOT_MODELS" <<'JSON'
{"version":2,"difficulties":{"normal":{
  "writer":{"provider":"codex","model":"writer-model","effort":"high"},
  "reviewer1":{"provider":"claude","model":"reviewer1-model","effort":"medium"},
  "completion":{"provider":"codex","model":"completion-model","effort":"max"}}}}
JSON
(
  MF_MODELS_FILE=$SLOT_MODELS
  cc(){ printf 'claude:%s\n' "$1" >>"$SLOT_DISPATCH"; }
  cc_codex(){ printf 'codex:%s\n' "$1" >>"$SLOT_DISPATCH"; }
  : >"$SLOT_DISPATCH"
  mf_cc writer normal p
  mf_cc reviewer normal p
  CC_SLOT=completion mf_cc reviewer normal p
  mf_cc fixer normal p
  mf_cc checker normal p
  mf_cc ci-fix normal p
  CC_SLOT=garbage mf_cc fixer normal p
)
check "mf_cc dispatches each role through its slot" \
"codex:writer-model
claude:reviewer1-model
codex:completion-model
codex:completion-model
codex:completion-model
codex:completion-model
codex:completion-model" "$(<"$SLOT_DISPATCH")"
unset SLOT_MODELS SLOT_DISPATCH
rm -f "$MFSTATE/control/models.json"

echo "— role pins: roles.<role> object pins an exact model, strings unchanged"
log(){ :; }
cat >"$MFSTATE/control/models.json" <<'JSON'
{"version":2,"difficulties":{
  "easy":{"provider":"codex","model":"tier-easy","effort":"low"},
  "normal":{"provider":"codex","model":"tier-normal","effort":"high"},
  "intermediate":{"provider":"codex","model":"tier-int","effort":"high"},
  "hard":{"provider":"codex","model":"gpt-5.6-sol","effort":"ultra"},
  "max":{"provider":"codex","model":"tier-max","effort":"xhigh"}},
 "roles":{
  "composer":{"provider":"claude","model":"claude-fable-5","effort":"xhigh"},
  "checker":{"provider":"codex","model":"pinned-checker","effort":"high"},
  "reviewer":"hard",
  "reviewFloor":"intermediate"}}
JSON
check "pin: composer object pin resolves exactly" \
  "claude|claude-fable-5|xhigh" "$(role_pin_cfg composer)"
check "pin: checker object pin resolves exactly" \
  "codex|pinned-checker|high" "$(role_pin_cfg checker)"
check "pin: string role entry is not a pin" "" "$(role_pin_cfg reviewer)"
check "pin: absent role entry is not a pin" "" "$(role_pin_cfg fixer)"
check "pin: object entry no longer resolves as a difficulty string (role_diff default)" \
  "hard" "$(role_diff composer)"
check "pin: reviewFloor string keeps working beside pins" "intermediate" "$(review_floor)"
mf_uses_claude \
  && ok "valid claude pin flips mf_uses_claude in an all-codex config" \
  || bad "valid claude pin should flip mf_uses_claude"
PIN_DISPATCH=$T/pin-dispatch
(
  cc(){ printf 'claude:%s:%s\n' "$1" "${CC_EFFORT:-}" >>"$PIN_DISPATCH"; }
  cc_codex(){ printf 'codex:%s:%s\n' "$1" "$2" >>"$PIN_DISPATCH"; }
  : >"$PIN_DISPATCH"
  mf_cc composer "$(role_diff composer)" p
  CC_SLOT=completion mf_cc checker "$(role_diff checker)" p
  mf_cc fixer normal p
  CC_SLOT=reviewer1 mf_cc reviewer normal p
)
check "pin: mf_cc honors pins and keeps slot routing for unpinned roles" \
"claude:claude-fable-5:xhigh
codex:pinned-checker:high
codex:tier-normal:high
codex:tier-normal:high" "$(<"$PIN_DISPATCH")"
unset PIN_DISPATCH

echo "— role pins: unusable pins fall back safely (never brick a run)"
cat >"$MFSTATE/control/models.json" <<'JSON'
{"version":2,"difficulties":{
  "easy":{"provider":"codex","model":"tier-easy","effort":"low"},
  "normal":{"provider":"codex","model":"tier-normal","effort":"high"},
  "intermediate":{"provider":"codex","model":"tier-int","effort":"high"},
  "hard":{"provider":"codex","model":"tier-hard","effort":"xhigh"},
  "max":{"provider":"codex","model":"tier-max","effort":"xhigh"}},
 "roles":{
  "composer":{"provider":"pigeon","model":"carrier","effort":"high"},
  "checker":{"provider":"claude","effort":"high"},
  "writer":{"provider":"claude","model":"bad|pipe","effort":"high"},
  "fixer":{"provider":"claude","model":"claude-opus-5","effort":"max"},
  "reviewer":{"provider":"claude","model":"claude-opus-5","effort":"xhigh"}}}
JSON
check "pin: unknown provider pin is unusable" "malformed||" "$(role_pin_cfg composer)"
check "pin: model-less pin is unusable" "malformed||" "$(role_pin_cfg checker)"
check "pin: delimiter injection in a pin is unusable" "malformed||" "$(role_pin_cfg writer)"
check "pin: Opus 5 above xhigh is rejected" "malformed||" "$(role_pin_cfg fixer)"
check "pin: Opus 5 at the xhigh cap is allowed" \
  "claude|claude-opus-5|xhigh" "$(role_pin_cfg reviewer)"
mf_opus5_effort_ok claude-opus-5 max \
  && bad "opus5 cap must reject max effort" || ok "opus5 cap rejects max effort"
mf_opus5_effort_ok claude-opus-5 ultra \
  && bad "opus5 cap must reject unknown efforts" || ok "opus5 cap rejects unknown efforts"
mf_opus5_effort_ok claude-opus-5 xhigh \
  && ok "opus5 cap allows xhigh" || bad "opus5 cap should allow xhigh"
mf_opus5_effort_ok claude-fable-5 max \
  && ok "opus5 cap applies only to Opus 5 models" \
  || bad "opus5 cap must not touch non-Opus-5 models"
PIN_FALLBACK=$T/pin-fallback-dispatch
(
  cc(){ printf 'claude:%s\n' "$1" >>"$PIN_FALLBACK"; }
  cc_codex(){ printf 'codex:%s\n' "$1" >>"$PIN_FALLBACK"; }
  : >"$PIN_FALLBACK"
  mf_cc fixer normal p
  CC_SLOT=completion mf_cc checker normal p
)
check "pin: unusable pins fall back to difficulty routing (run still dispatches)" \
"codex:tier-normal
codex:tier-normal" "$(<"$PIN_FALLBACK")"
unset PIN_FALLBACK
(
  MF_MODELS_FILE=$T/pin-noclaude.json
  cat >"$MF_MODELS_FILE" <<'JSON'
{"difficulties":{
  "easy":{"provider":"codex","model":"c","effort":"low"},
  "normal":{"provider":"codex","model":"c","effort":"high"},
  "intermediate":{"provider":"codex","model":"c","effort":"high"},
  "hard":{"provider":"codex","model":"c","effort":"xhigh"},
  "max":{"provider":"codex","model":"c","effort":"xhigh"}},
 "roles":{"fixer":{"provider":"claude","model":"claude-opus-5","effort":"max"}}}
JSON
  mf_uses_claude && exit 1 || exit 0
) && ok "rejected claude pin does not flip mf_uses_claude" \
  || bad "rejected claude pin must not flip mf_uses_claude"
PIN_GATE_MODELS=$T/pin-gate-models.json
PIN_GATE_CAPTURE=$T/pin-gate-dispatch
rm -f "$PIN_GATE_CAPTURE"
printf '%s\n' \
  '{"difficulties":{},"roles":{"composer":{"provider":"codex","model":"gpt-5.6-terra","effort":"max"}}}' \
  >"$PIN_GATE_MODELS"
if (
  MF_MODELS_FILE=$PIN_GATE_MODELS
  cc_codex(){ : >"$PIN_GATE_CAPTURE"; }
  mf_cc composer hard 'must not dispatch'
); then
  bad "composer route gate must still reject a disallowed pinned model"
else
  ok "composer route gate still applies to pinned composer models"
fi
[ ! -e "$PIN_GATE_CAPTURE" ] \
  && ok "disallowed pinned composer makes no provider call" \
  || bad "disallowed pinned composer reached provider"
unset PIN_GATE_MODELS PIN_GATE_CAPTURE
rm -f "$MFSTATE/control/models.json"
check "pin: missing models.json means no pin" "" "$(role_pin_cfg composer)"

echo "— worker salvage: never lose writer output (#394)"
# Offline git sandbox: a bare 'origin' + a working clone, no network. Source
# worker.sh in MF_SOURCE_ONLY mode (lib.sh + boot skipped) and drive salvage_branch
# directly. worker.sh hard-assigns REPO_DIR/LOG at source time, so override AFTER.
SB=$T/salvage; mkdir -p "$SB"
git init -q --bare "$SB/origin.git"
git clone -q "$SB/origin.git" "$SB/clone" 2>/dev/null
( cd "$SB/clone"
  git config user.email t@t.test; git config user.name tester; git config commit.gpgsign false
  git commit -q --allow-empty -m init && git branch -M main && git push -q -u origin main )
export WORKER_ID=9
MF_SOURCE_ONLY=1 . ./worker.sh
REPO_DIR=$SB/clone; LOG=$SB/log; MF_EVENTLOG=$SB/events; : >"$MF_EVENTLOG"
# Stubs: gh pr list prints $GH_PR (a number ⇒ PR exists); log captures event lines.
gh(){ case "$1 $2" in "pr list") printf '%s' "${GH_PR:-}";; *) : ;; esac; }
log(){ printf '%s\n' "$*" >>"$MF_EVENTLOG"; }
cd "$SB/clone"
bare(){ git --git-dir="$SB/origin.git" branch --list "$1" --format='%(refname:short)'; }

# Case 1: clean tree, no task branch, no PR ⇒ nothing to salvage.
GH_PR="" salvage_branch 500
check "salvage: clean tree is a no-op" "0" "${SALVAGED}"
check "salvage: no branch pushed for clean tree" "" "$(bare task/500)"

# Case 2: happy path — writer opened its own PR ⇒ salvage skipped even if dirty.
echo happy >happy.txt
GH_PR="777" salvage_branch 502
check "salvage: skipped when PR exists (happy path)" "0" "${SALVAGED}"
check "salvage: no branch pushed when PR exists" "" "$(bare task/502)"

# Case 3: dirty tree, no PR ⇒ commit + push the task branch + event line.
GH_PR="" salvage_branch 503
check "salvage: fires on dirty tree with no PR" "1" "${SALVAGED}"
check "salvage: branch landed on origin" "task/503" "$(bare task/503)"
check "salvage: event line logged" "1" "$(grep -c 'salvaged branch task/503' "$MF_EVENTLOG")"

echo "— reviewer slot selection: first review vs later reviews"
# worker.sh is already sourced (MF_SOURCE_ONLY). Stub the transport + GitHub
# reads; the slot decision itself must come from the real evidence-based path
# (mf_has_canonical_review over the durable PR comment thread — no state file).
log(){ :; }; notify(){ :; }
MF_PROTOCOL_ATTEMPTS=1; MF_PROTOCOL_RETRY_SLEEP=0
MF_COMMENT_DISCOVERY_ATTEMPTS=1; MF_COMMENT_DISCOVERY_SLEEP=0
MF_PROMPTS=$T/slot-prompts; PROMPTS=$T/slot-prompts; mkdir -p "$MF_PROMPTS"
printf 'review {{PR}}\n' >"$MF_PROMPTS/reviewer.md"
printf 'fix {{PR}}\n' >"$MF_PROMPTS/fixer.md"
SLOT_SEL_LOG=$T/slot-selection.log
with_pack(){ printf '%s' "$1"; }
pr_snapshot(){ PR_SNAPSHOT_COMMENTS=$REVIEW_COMMENTS; PR_SNAPSHOT_HEAD=headA; return 0; }
mf_cc(){ printf '%s:%s:%s\n' "${CC_SLOT:-none}" "$1" "$2" >>"$SLOT_SEL_LOG"; return 0; }
mf_pr_head(){ echo headA; }

REVIEW_COMMENTS='[]'
: >"$SLOT_SEL_LOG"
run_reviewer 7 77 intermediate
check "first review on a fresh PR runs the reviewer1 slot" \
  "reviewer1:reviewer:intermediate" "$(<"$SLOT_SEL_LOG")"

REVIEW_COMMENTS='[{"id":1,"body":"earlier review\nFACTORY-REVIEW-HEAD: 0123abc\nFACTORY-VERDICT: REQUEST_CHANGES"}]'
: >"$SLOT_SEL_LOG"
run_reviewer 7 77 intermediate
check "later review (prior verdict on an older head) runs completion" \
  "completion:reviewer:intermediate" "$(<"$SLOT_SEL_LOG")"

: >"$SLOT_SEL_LOG"
run_reviewer 7 77 intermediate
check "resume re-derives the same slot from the same durable comments" \
  "completion:reviewer:intermediate" "$(<"$SLOT_SEL_LOG")"

REVIEW_COMMENTS='[{"id":2,"body":"prose quoting FACTORY-VERDICT: APPROVE mid-line\nno canonical marker"}]'
: >"$SLOT_SEL_LOG"
run_reviewer 7 77 intermediate
check "quoted marker prose does not demote the first review" \
  "reviewer1:reviewer:intermediate" "$(<"$SLOT_SEL_LOG")"

REVIEW_COMMENTS='[]'
: >"$SLOT_SEL_LOG"
run_fixer 7 77 intermediate
check "fixer always runs the completion slot" \
  "completion:fixer:intermediate" "$(<"$SLOT_SEL_LOG")"

echo "— single-parse GitHub reads (one parser, one contract)"
# The fetchers parse GitHub's ORIGINAL JSON exactly once with C jq — gh --jq
# (gojq) would add a second, gh-version-dependent transformation layer. The gh
# stub first emits ONE merged array (the real gh >=2.9x --paginate shape), then
# the older concatenated-arrays shape; 'add' must flatten both. Escaped
# control characters in a body must round-trip. These are parser-contract
# tests — the live #891 jam itself was the DIRTY/empty-rollup merger trap
# covered below.
gh(){ cat <<'PAGES'
[{"id":1,"body":"clean","created_at":"c1"},{"id":2,"body":"ctl \u0007 \u0001 body","created_at":"c2"},{"id":3,"body":"page2","created_at":"c3"}]
PAGES
}
CJ=$(mf_pr_comments_json 891) && ok "comments fetch exits 0 (merged-array shape)" || bad "comments fetch failed (merged-array shape)"
check "merged-array --paginate shape parses" "3" "$(jq 'length' <<<"$CJ")"
gh(){ cat <<'PAGES'
[{"id":1,"body":"clean","created_at":"c1"},{"id":2,"body":"ctl \u0007 \u0001 body","created_at":"c2"}]
[{"id":3,"body":"page2","created_at":"c3"}]
PAGES
}
CJ=$(mf_pr_comments_json 891) && ok "comments fetch exits 0 (concatenated pages, older gh)" || bad "comments fetch failed (concatenated pages)"
check "concatenated --paginate pages flatten" "3" "$(jq 'length' <<<"$CJ")"
check "comments fetch preserves ids in order" "1 2 3" "$(jq -r '[.[].id]|join(" ")' <<<"$CJ")"
check "escaped-control-char body round-trips" "1" "$(jq '[.[]|select(.id==2)]|length' <<<"$CJ")"
gh(){ return 1; }
mf_pr_comments_json 891 >/dev/null 2>&1 && bad "comments fetch must fail when gh fails" || ok "comments fetch fails closed on gh failure"
gh(){ printf '{"number":9,"title":"t","body":"b","labels":[{"name":"diff:easy"}],"created_at":"c"}'; }
check "issue-by-number single-parse projects labels" "diff:easy" "$(mf_issue_json_by_number 9 | jq -r '.labels[0]')"
check "issue_json_read single-parse keeps shape" "9" "$(issue_json_read 9 | jq -r '.number')"
gh(){ printf '[{"number":8,"title":"t","body":"b","labels":[],"created_at":"c","pull_request":{"url":"x"}},{"number":7,"title":"t","body":"b","labels":[],"created_at":"c"}]'; }
check "recent-issues single-parse filters PRs" "7" "$(mf_recent_issues_json | jq -r '.[0].number')"

echo "— merger: bounded approval-read failures park the queue head (#891 jam)"
MF_DRY_RUN=0
QDIR=$MFSTATE/merge-queue
HUMAN_LOG=$T/human.log; : >"$HUMAN_LOG"
mark_human(){ printf '%s|%s\n' "$1" "$2" >>"$HUMAN_LOG"; }
mstatus(){ :; }
notify(){ :; }
jq -nc '{pr:77,issue:707,touches:["x/**"],approved_head:"aaaa1111",approval_kind:"reviewer",approval_comment_id:"5"}' >"$QDIR/1000-pr77.json"
gh(){ case "$*" in *"--json state"*) echo OPEN;; *) return 1;; esac; }
mf_pr_head(){ return 1; }          # deterministic approval-read failure
MF_APPROVAL_READ_MAX=2
merger_step
[ -f "$QDIR/1000-pr77.json" ] && ok "first read failure retains the queue head" || bad "queue head dropped on first read failure"
check "read-failure counter recorded" "1" "$(cat "$QDIR/.apprfail-pr77" 2>/dev/null)"
merger_step
[ -f "$QDIR/1000-pr77.json" ] && bad "queue head must park after the failure cap" || ok "queue head parked after the failure cap"
check "parked head escalated to a human" "1" "$(grep -c '^707|' "$HUMAN_LOG")"
[ -f "$QDIR/.apprfail-pr77" ] && bad "failure counter must be cleared" || ok "failure counter cleared"

echo "— merger: DIRTY queue head gets one conflict-fix, then review or human"
: >"$HUMAN_LOG"
CONFLICT_CALLS=$T/conflict-calls; : >"$CONFLICT_CALLS"
jq -nc '{pr:88,issue:808,touches:["y/**"],approved_head:"bbbb2222",approval_kind:"reviewer",approval_comment_id:"6"}' >"$QDIR/1001-pr88.json"
queue_approval_check(){ QUEUE_APPROVAL_STATE=valid; }
issue_difficulty(){ echo hard; }
mf_cc(){ printf '%s %s\n' "$1" "$2" >>"$CONFLICT_CALLS"; }
gh(){ case "$*" in
  *"--json state"*) echo OPEN;;
  *"--json statusCheckRollup"*) echo '[]';;   # conflicted PRs have NO fresh rollup
  *"--json mergeStateStatus"*) echo DIRTY;;
  *) : ;;
esac; }
mf_pr_head(){ echo bbbb2222; }     # conflict-fix pushes nothing
merger_step
check "conflict-fix invoked once through the ci-fix role" "1" "$(grep -c '^ci-fix hard$' "$CONFLICT_CALLS")"
[ -f "$QDIR/1001-pr88.json" ] && bad "no-push conflict-fix must clear the queue head" || ok "no-push conflict-fix cleared the queue head"
check "no-push conflict-fix escalated to a human" "1" "$(grep -c '^808|' "$HUMAN_LOG")"
[ -f "$QDIR/.conflictfix-pr88-bbbb2222" ] && bad "conflict marker must be cleared" || ok "conflict marker cleared"
# pushed-head variant: the resolved merge goes to a fresh review, not a human
: >"$HUMAN_LOG"; : >"$CONFLICT_CALLS"
REQUEUED=$T/requeued.log; : >"$REQUEUED"
requeue_for_review(){ printf '%s|%s|%s\n' "$1" "$2" "$3" >>"$REQUEUED"; rm -f "$1"; }
jq -nc '{pr:99,issue:909,touches:["z/**"],approved_head:"cccc3333",approval_kind:"reviewer",approval_comment_id:"7"}' >"$QDIR/1002-pr99.json"
mf_pr_head(){ if [ -f "$T/pushed99" ]; then echo dddd4444; else echo cccc3333; fi; }
mf_cc(){ printf '%s %s\n' "$1" "$2" >>"$CONFLICT_CALLS"; : >"$T/pushed99"; }
merger_step
check "pushed conflict-fix goes to a fresh review, not a human" "1" "$(grep -c '|909|' "$REQUEUED")"
check "pushed conflict-fix never escalates" "0" "$(grep -c '^909|' "$HUMAN_LOG")"
[ -f "$QDIR/1002-pr99.json" ] && bad "requeued head must leave the queue" || ok "requeued head left the queue"
[ -f "$QDIR/.conflictfix-pr99-cccc3333" ] && bad "pushed-variant marker must be cleared" || ok "pushed-variant marker cleared"
# orphaned-marker regression (independent review 2026-07-28): a marker left
# behind by an earlier head (transient post-attempt head-read failure, entry
# requeued by the head check) must never deny the freshly-approved head its
# own attempt — and must be swept.
: >"$QDIR/.conflictfix-pr55-oldhead1"
: >"$CONFLICT_CALLS"; : >"$REQUEUED"; : >"$HUMAN_LOG"
jq -nc '{pr:55,issue:505,touches:["w/**"],approved_head:"newhead2",approval_kind:"reviewer",approval_comment_id:"8"}' >"$QDIR/1003-pr55.json"
mf_pr_head(){ if [ -f "$T/pushed55" ]; then echo pushedhead3; else echo newhead2; fi; }
mf_cc(){ printf '%s %s\n' "$1" "$2" >>"$CONFLICT_CALLS"; : >"$T/pushed55"; }
merger_step
check "orphaned old-head marker never denies the new head its attempt" "1" "$(grep -c '^ci-fix hard$' "$CONFLICT_CALLS")"
[ -f "$QDIR/.conflictfix-pr55-oldhead1" ] && bad "stale old-head marker must be swept" || ok "stale old-head marker swept"
check "new head still routes to fresh review" "1" "$(grep -c '|505|' "$REQUEUED")"

echo "— merger: bounded same-head merge refusals (BLOCKED/DRAFT class)"
: >"$HUMAN_LOG"
jq -nc '{pr:66,issue:606,touches:["v/**"],approved_head:"eeee5555",approval_kind:"reviewer",approval_comment_id:"9"}' >"$QDIR/1004-pr66.json"
gh(){ case "$*" in
  *"--json state"*) echo OPEN;;
  *"--json statusCheckRollup"*) echo '[{"conclusion":"SUCCESS","status":"","state":""}]';;
  *"--json mergeStateStatus"*) echo BLOCKED;;
  *"pr merge"*) return 1;;
  *) : ;;
esac; }
mf_pr_head(){ echo eeee5555; }
MF_MERGE_FAIL_MAX=2
merger_step
[ -f "$QDIR/1004-pr66.json" ] && ok "first same-head merge refusal retains the queue head" || bad "queue head dropped on first refusal"
check "merge-refusal counter recorded" "1" "$(cat "$QDIR/.mergefail-pr66-eeee5555" 2>/dev/null)"
merger_step
[ -f "$QDIR/1004-pr66.json" ] && bad "queue head must park after the refusal cap" || ok "queue head parked after the refusal cap"
check "refused head escalated to a human" "1" "$(grep -c '^606|' "$HUMAN_LOG")"
[ -f "$QDIR/.mergefail-pr66-eeee5555" ] && bad "refusal counter must be cleared" || ok "refusal counter cleared"
MF_DRY_RUN=1

echo "— opus5 cap binds at the mflib runtime layer (hand-written files)"
# set-models and the editor already refuse over-cap routes; diff_cfg is the
# belt for files written by hand: an over-cap slot falls to flat, an over-cap
# flat falls to the builtin default, pins were already capped (role_pin_cfg).
(
  MF_MODELS_FILE=$T/opus5-cap.json
  cat >"$MF_MODELS_FILE" <<'JSON'
{"version":2,"difficulties":{
  "easy":{"provider":"codex","model":"flat-easy","effort":"low",
    "writer":{"provider":"claude","model":"claude-opus-5","effort":"ultra"}},
  "hard":{"provider":"claude","model":"claude-opus-5","effort":"max",
    "writer":{"provider":"claude","model":"claude-opus-5","effort":"max"},
    "reviewer1":{"provider":"claude","model":"claude-opus-5-20260514","effort":"max"},
    "completion":{"provider":"codex","model":"gpt-5.6-sol","effort":"ultra"}},
  "max":{"provider":"claude","model":"claude-fable-5","effort":"max",
    "reviewer1":{"provider":"claude","model":"claude-opus-5","effort":"xhigh"}}}}
JSON
  printf '%s\n' "$(diff_cfg easy writer 2>/dev/null)" "$(diff_cfg hard writer 2>/dev/null)" \
    "$(diff_cfg hard reviewer1 2>/dev/null)" "$(diff_cfg hard completion 2>/dev/null)" \
    "$(diff_cfg hard 2>/dev/null)" "$(diff_cfg max 2>/dev/null)" "$(diff_cfg max reviewer1 2>/dev/null)"
) >"$T/opus5-out"
check "over-cap slot falls back to a valid flat entry" "codex|flat-easy|low" "$(sed -n 1p "$T/opus5-out")"
check "over-cap slot above over-cap flat lands on the builtin" "claude|claude-opus-4-8|max" "$(sed -n 2p "$T/opus5-out")"
check "dated opus5 id is capped identically" "claude|claude-opus-4-8|max" "$(sed -n 3p "$T/opus5-out")"
check "non-opus5 ultra slot is untouched" "codex|gpt-5.6-sol|ultra" "$(sed -n 4p "$T/opus5-out")"
check "over-cap flat read lands on the builtin" "claude|claude-opus-4-8|max" "$(sed -n 5p "$T/opus5-out")"
check "fable at max stays allowed" "claude|claude-fable-5|max" "$(sed -n 6p "$T/opus5-out")"
check "opus5 at the xhigh cap stays allowed" "claude|claude-opus-5|xhigh" "$(sed -n 7p "$T/opus5-out")"

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1

"$TEST_SCRIPT_DIR/protocol-test.sh" || exit 1
"$TEST_SCRIPT_DIR/claudex-test.sh" || exit 1

printf '\n— control-plane Node tests\n'
node --test "$TEST_SCRIPT_DIR"/control/*.test.mjs
