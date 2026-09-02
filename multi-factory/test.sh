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
# Hermetic environment. The suite also runs INSIDE a factory container (the
# autorun.sh --self-test deploy hook), where compose exports MF_MODELS_FILE,
# MF_REQUEUE_MAX, MF_LIMIT_NAPS_MAX, the composer caps and CC_* for the live
# fleet. Every one of those silently overrides a fixture: an inherited
# MF_MODELS_FILE alone reddened 42 checks here. Own the whole namespace.
unset MF_MODELS_FILE MF_ROLE_TIMEOUT MF_REQUEUE_MAX MF_MERGE_LOOKAHEAD \
  MF_LIMIT_NAPS_MAX MF_COMPOSER_COOLDOWN MF_COMPOSER_BACKOFF_MAX \
  MF_COMPOSER_PROTOCOL_ATTEMPTS MF_COMPOSER_PROTOCOL_COOLDOWN \
  MF_COMPOSER_PROTOCOL_BACKOFF_MAX MF_COMPOSER_MAX_TURNS MF_COMPOSER_TIMEOUT \
  MF_SOL_COMPOSER_TIMEOUT MF_SOL_COMPOSER_MAX_TURNS COMPOSER_BATCH \
  CC_ROLE CC_SLOT CC_EFFORT CC_ISSUE CC_MAX_TURNS CC_TIMEOUT 2>/dev/null || true
# claudex-test.sh drives autorun.sh with a stubbed docker; without this the
# start path would re-enter this very suite.
export MF_SKIP_SELF_TEST=1
export MFSTATE=$T/state
export MF_MODELS_FILE=$MFSTATE/control/models.json
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

echo "— scheduler: missing mf-meta is labeled mf:bad-meta and skipped"
# Was "meta-less issue assigned first (alone)": a '**' claim conflicts with
# EVERYTHING, so one issue with an absent/empty mf-meta block silently
# serialized the whole fleet behind itself. master.sh now labels it and moves
# on, and the label keeps it out of runnable_issues on every later tick.
rm -f "$MFSTATE"/assignments/*.json
: >"$GH_STUB_DIR/calls.log"
cat >"$TICK_ISSUES" <<'JSON'
[
 {"number":210,"title":"no meta","body":"no machine block here","labels":["autopilot","tier:sonnet"]},
 {"number":211,"title":"disjoint","body":"x\n<!-- mf-meta\ntouches: apps/web/**\n-->","labels":["autopilot","tier:sonnet"]}
]
JSON
scheduler run
A1=$(jq -r '.issue' "$MFSTATE/assignments/worker-1.json" 2>/dev/null || echo none)
A2=$(jq -r '.issue' "$MFSTATE/assignments/worker-2.json" 2>/dev/null || echo none)
check "meta-less issue is NOT assigned" "" \
  "$(grep -l '"issue":210' "$MFSTATE"/assignments/*.json 2>/dev/null || true)"
# Exactly once per tick, not once per idle worker: the branch prunes the issue
# from $runnable so later workers in the SAME tick never re-reach it. That also
# bounds the failure path — the label edit is best-effort, and without the prune
# a failing edit would repeat WORKERS calls every tick forever.
check "meta-less issue is labeled mf:bad-meta exactly once" "1" \
  "$(grep -c 'issue edit 210 --add-label mf:bad-meta' "$GH_STUB_DIR/calls.log")"
check "the fleet is no longer serialized behind the wildcard claim" "211" "$A1"
check "no second worker is starved by the skipped issue" "none" "$A2"

# The label is durable: a later tick must not even consider the issue runnable,
# so it is never re-labeled and never re-inspected.
rm -f "$MFSTATE"/assignments/*.json
: >"$GH_STUB_DIR/calls.log"
cat >"$TICK_ISSUES" <<'JSON'
[
 {"number":210,"title":"no meta","body":"no machine block here","labels":["autopilot","tier:sonnet","mf:bad-meta"]},
 {"number":211,"title":"disjoint","body":"x\n<!-- mf-meta\ntouches: apps/web/**\n-->","labels":["autopilot","tier:sonnet"]}
]
JSON
check "an mf:bad-meta issue is dropped from runnable_issues" "211" "$(runnable_issues | tr '\n' ' ' | sed 's/ *$//')"
scheduler run
check "an already-labeled issue is not labeled twice" "0" \
  "$(grep -c 'issue edit 210 --add-label mf:bad-meta' "$GH_STUB_DIR/calls.log")"

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

echo "— Claude named-account runtime selection"
CLAUDE_RUNTIME_DIR=$T/claude-runtime
CLAUDE_RUNTIME_TOKEN_FILE=$CLAUDE_RUNTIME_DIR/oauth-token
CLAUDE_RUNTIME_PROFILE_FILE=$CLAUDE_RUNTIME_DIR/profile.json
CLAUDE_RUNTIME_CAPTURE=$T/claude-runtime.capture
CLAUDE_RUNTIME_LOG=$T/claude-runtime.log
mkdir -p "$CLAUDE_RUNTIME_DIR"
printf '%s\n' 'selected-profile-one' >"$CLAUDE_RUNTIME_TOKEN_FILE"
cat >"$CLAUDE_RUNTIME_PROFILE_FILE" <<'JSON'
{"version":1,"source":"profile","profileId":"00000000-0000-4000-8000-000000000001","name":"Second Claude account"}
JSON
(
  export MF_CLAUDE_TOKEN_FILE=$CLAUDE_RUNTIME_TOKEN_FILE
  export MF_CLAUDE_PROFILE_FILE=$CLAUDE_RUNTIME_PROFILE_FILE
  # Pin the sandbox answer: the probe is host-dependent by design, and this
  # battery is about credential precedence, not about where bwrap exists.
  export MF_CLAUDE_ENV_SCRUB=1
  export CLAUDE_CODE_OAUTH_TOKEN=legacy-factory-token
  export ANTHROPIC_API_KEY=legacy-api-key
  export ANTHROPIC_AUTH_TOKEN=legacy-auth-token
  export ANTHROPIC_BASE_URL=https://legacy-anthropic.invalid
  export ANTHROPIC_API_BASE_URL=https://legacy-api.invalid
  export ANTHROPIC_CUSTOM_HEADERS='Authorization: legacy'
  export ANTHROPIC_MODEL=legacy-model
  export ANTHROPIC_SMALL_FAST_MODEL=legacy-fast-model
  export CLAUDE_AGENT_API_BASE_URL=https://legacy-agent.invalid
  export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
  export CLAUDE_CODE_OAUTH_REFRESH_TOKEN=legacy-refresh
  export CLAUDE_CODE_OAUTH_SCOPES=user:inference
  export CLAUDE_CODE_USE_BEDROCK=1
  export CLAUDE_CODE_USE_FOUNDRY=1
  export CLAUDE_CODE_USE_VERTEX=1
  log(){ printf '%s\n' "$*" >>"$CLAUDE_RUNTIME_LOG"; }
  claude_runtime_probe(){
    printf 'before:%s\n' "$CLAUDE_CODE_OAUTH_TOKEN"
    if [ -z "${ANTHROPIC_API_KEY+x}" ] \
      && [ -z "${ANTHROPIC_AUTH_TOKEN+x}" ] \
      && [ -z "${ANTHROPIC_BASE_URL+x}" ] \
      && [ -z "${ANTHROPIC_API_BASE_URL+x}" ] \
      && [ -z "${ANTHROPIC_CUSTOM_HEADERS+x}" ] \
      && [ -z "${ANTHROPIC_MODEL+x}" ] \
      && [ -z "${ANTHROPIC_SMALL_FAST_MODEL+x}" ] \
      && [ -z "${CLAUDE_AGENT_API_BASE_URL+x}" ] \
      && [ -z "${CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY+x}" ] \
      && [ -z "${CLAUDE_CODE_OAUTH_REFRESH_TOKEN+x}" ] \
      && [ -z "${CLAUDE_CODE_OAUTH_SCOPES+x}" ] \
      && [ -z "${CLAUDE_CODE_USE_BEDROCK+x}" ] \
      && [ -z "${CLAUDE_CODE_USE_FOUNDRY+x}" ] \
      && [ -z "${CLAUDE_CODE_USE_VERTEX+x}" ] \
      && [ "${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB:-}" = 1 ]; then
      printf 'precedence:scrubbed\n'
    else
      printf 'precedence:leaked\n'
    fi
    # Simulate a dashboard assignment change while this role is still running.
    printf '%s\n' 'selected-profile-two' >"$MF_CLAUDE_TOKEN_FILE"
    printf 'after:%s\n' "$CLAUDE_CODE_OAUTH_TOKEN"
  }
  mf_with_claude_profile claude_runtime_probe >"$CLAUDE_RUNTIME_CAPTURE"
)
check "named Claude profile overrides env and scrubs higher-precedence credentials" \
"before:selected-profile-one
precedence:scrubbed
after:selected-profile-one" "$(<"$CLAUDE_RUNTIME_CAPTURE")"
check "named Claude profile logs only its safe label" \
  "  ↳ Claude account: Second Claude account" "$(<"$CLAUDE_RUNTIME_LOG")"
check "Claude profile tokens never enter the role log" 0 \
  "$(grep -Ec 'selected-profile-(one|two)' "$CLAUDE_RUNTIME_LOG" || true)"

# The subprocess env scrub is bubblewrap-backed on Linux. Demanding it where no
# usable bwrap exists aborts the CLI before the first request, and cc() reads
# that abort as exhausted capacity — the whole Claude side of the factory then
# sleeps in 30-minute rounds against a perfectly good account. The flag must
# track what the host can deliver, and must never be left for a CLI default.
claude_scrub_probe(){ printf '%s' "${CLAUDE_CODE_SUBPROCESS_ENV_SCRUB-unset}"; }
scrub_run(){ # $1=MF_CLAUDE_ENV_SCRUB value ('-' leaves it unset)
  (
    export MF_CLAUDE_TOKEN_FILE=$CLAUDE_RUNTIME_TOKEN_FILE
    export MF_CLAUDE_PROFILE_FILE=$CLAUDE_RUNTIME_PROFILE_FILE
    [ "$1" = - ] && unset MF_CLAUDE_ENV_SCRUB || export MF_CLAUDE_ENV_SCRUB=$1
    log(){ :; }
    mf_with_claude_profile claude_scrub_probe
  )
}
scrub_pinned(){ # $1=knob → "pinned" only when the flag came out 0 or 1
  local seen; seen=$(scrub_run "$1")
  case "$seen" in 0|1) printf pinned;; *) printf '%s' "$seen";; esac
}
check "sandboxless host does not demand the Claude subprocess env scrub" \
  "0" "$(scrub_run 0)"
check "an unresolvable scrub knob falls back to the probe, never to the raw value" \
  "pinned" "$(scrub_pinned maybe)"
check "the auto-probed scrub flag is always exported" \
  "pinned" "$(scrub_pinned -)"
leak_probe(){ printf '%s' "${ANTHROPIC_API_KEY-}"; }
check "turning the scrub off never relaxes credential precedence" \
  "" "$(
    export MF_CLAUDE_TOKEN_FILE=$CLAUDE_RUNTIME_TOKEN_FILE
    export MF_CLAUDE_PROFILE_FILE=$CLAUDE_RUNTIME_PROFILE_FILE
    export MF_CLAUDE_ENV_SCRUB=0 ANTHROPIC_API_KEY=legacy-api-key
    log(){ :; }
    mf_with_claude_profile leak_probe
  )"

(
  export MF_CLAUDE_TOKEN_FILE=$CLAUDE_RUNTIME_TOKEN_FILE
  export MF_CLAUDE_PROFILE_FILE=$CLAUDE_RUNTIME_PROFILE_FILE
  log(){ :; }
  claude_next_role_probe(){ printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN"; }
  mf_with_claude_profile claude_next_role_probe
) >"$CLAUDE_RUNTIME_CAPTURE"
check "next Claude role observes a changed profile materialization" \
  "selected-profile-two" "$(<"$CLAUDE_RUNTIME_CAPTURE")"

rm -f "$CLAUDE_RUNTIME_TOKEN_FILE"
(
  export MF_CLAUDE_TOKEN_FILE=$CLAUDE_RUNTIME_TOKEN_FILE
  export MF_CLAUDE_PROFILE_FILE=$CLAUDE_RUNTIME_PROFILE_FILE
  export CLAUDE_CODE_OAUTH_TOKEN=legacy-factory-token
  export ANTHROPIC_API_KEY=legacy-api-key
  log(){ :; }
  claude_legacy_probe(){
    printf '%s|%s' "$CLAUDE_CODE_OAUTH_TOKEN" "$ANTHROPIC_API_KEY"
  }
  mf_with_claude_profile claude_legacy_probe
) >"$CLAUDE_RUNTIME_CAPTURE"
CLAUDE_RUNTIME_MISSING_RC=$?
check "missing selected Claude token fails closed" "1" "$CLAUDE_RUNTIME_MISSING_RC"
check "missing selected Claude token never invokes the legacy credential path" \
  "" "$(<"$CLAUDE_RUNTIME_CAPTURE")"

mv "$CLAUDE_RUNTIME_PROFILE_FILE" "$CLAUDE_RUNTIME_PROFILE_FILE.saved"
(
  export MF_CLAUDE_TOKEN_FILE=$CLAUDE_RUNTIME_TOKEN_FILE
  export MF_CLAUDE_PROFILE_FILE=$CLAUDE_RUNTIME_PROFILE_FILE
  export MF_CLAUDE_PROFILE_REQUIRED=1
  export CLAUDE_CODE_OAUTH_TOKEN=legacy-factory-token
  log(){ :; }
  mf_with_claude_profile true
)
CLAUDE_RUNTIME_MARKER_RC=$?
mv "$CLAUDE_RUNTIME_PROFILE_FILE.saved" "$CLAUDE_RUNTIME_PROFILE_FILE"
check "production runtime refuses a missing Claude selection marker" \
  "1" "$CLAUDE_RUNTIME_MARKER_RC"

printf '%s\n' 'selected-profile-three' >"$CLAUDE_RUNTIME_TOKEN_FILE"
CLAUDE_RUNTIME_MODELS=$T/claude-runtime-models.json
printf '%s\n' \
  '{"difficulties":{"easy":{"provider":"claude","model":"claude-sonnet-5","effort":"high"}}}' \
  >"$CLAUDE_RUNTIME_MODELS"
(
  export MF_CLAUDE_TOKEN_FILE=$CLAUDE_RUNTIME_TOKEN_FILE
  export MF_CLAUDE_PROFILE_FILE=$CLAUDE_RUNTIME_PROFILE_FILE
  export MF_MODELS_FILE=$CLAUDE_RUNTIME_MODELS
  export ANTHROPIC_API_KEY=must-be-scrubbed
  log(){ :; }
  cc(){
    if [ -z "${ANTHROPIC_API_KEY+x}" ]; then clean=scrubbed; else clean=leaked; fi
    printf '%s|%s|%s|%s|%s|%s' \
      "$1" "$2" "$CLAUDE_CODE_OAUTH_TOKEN" "$clean" "$CC_ROLE" "$CC_EFFORT"
  }
  mf_cc writer easy runtime-prompt
) >"$CLAUDE_RUNTIME_CAPTURE"
check "mf_cc dispatches native Claude through the selected account" \
  "claude-sonnet-5|runtime-prompt|selected-profile-three|scrubbed|writer|high" \
  "$(<"$CLAUDE_RUNTIME_CAPTURE")"

(
  export MF_CLAUDE_TOKEN_FILE=$CLAUDE_RUNTIME_TOKEN_FILE
  export MF_CLAUDE_PROFILE_FILE=$CLAUDE_RUNTIME_PROFILE_FILE
  export ANTHROPIC_AUTH_TOKEN=must-be-scrubbed
  log(){ :; }
  wait_for_capacity(){
    if [ -z "${ANTHROPIC_AUTH_TOKEN+x}" ]; then clean=scrubbed; else clean=leaked; fi
    printf '%s|%s|%s' "$1" "$CLAUDE_CODE_OAUTH_TOKEN" "$clean"
  }
  mf_wait_for_claude_capacity startup
) >"$CLAUDE_RUNTIME_CAPTURE"
check "master startup capacity check uses the selected Claude account" \
  "startup|selected-profile-three|scrubbed" "$(<"$CLAUDE_RUNTIME_CAPTURE")"
unset CLAUDE_RUNTIME_DIR CLAUDE_RUNTIME_TOKEN_FILE CLAUDE_RUNTIME_PROFILE_FILE
unset CLAUDE_RUNTIME_CAPTURE CLAUDE_RUNTIME_LOG CLAUDE_RUNTIME_MODELS
unset CLAUDE_RUNTIME_MISSING_RC CLAUDE_RUNTIME_MARKER_RC

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
  "opencode openrouter/stealth/ox-alpha"; do
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
    printf '%s|%s|%s' "$MF_ROLE_TIMEOUT" "$CC_MAX_TURNS" "${CC_TIMEOUT:-none}" >"$FABLE_LIMITS"
  }
  mf_cc composer max "$FABLE_PROMPT"
)
check "Fable receives the shared composer prompt byte-identically" \
  "$FABLE_PROMPT" "$(<"$FABLE_CAPTURE")"
# Sol's tighter 1200s/40-turn caps must not leak onto Fable, but since #1623
# every composer is bounded: Fable runs under the MF_COMPOSER_* caps, and the
# ambient MF_ROLE_TIMEOUT the claude branch never consulted stays untouched.
check "Fable takes the composer caps, not Sol's and not an unbounded run" \
  "777|60|1800" "$(<"$FABLE_LIMITS")"

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
  "easy":{"provider":"opencode","model":"openrouter/stealth/ox-alpha"},
  "hard":{"provider":"codex","model":"gpt-5.5","effort":"xhigh"},
  "max":{"provider":"pigeon","model":"carrier"}},
 "roles":{"composer":"intermediate","checker":"max","reviewFloor":"hard"}}
JSON
check "cfg: owner-set opencode entry (no effort)" "opencode|openrouter/stealth/ox-alpha|" "$(diff_cfg easy)"
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
  "normal":{"provider":"opencode","model":"g"},
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

echo "— opencode provider registration (flat entry, slot, role pin, fail-closed)"
cat >"$MFSTATE/control/models.json" <<'JSON'
{"version":2,"difficulties":{
  "easy":{"provider":"opencode","model":"openrouter/stealth/ox-alpha"},
  "normal":{"provider":"claude","model":"claude-opus-4-8","effort":"high",
    "writer":{"provider":"opencode","model":"openrouter/stealth/ox-alpha"}},
  "hard":{"provider":"opencode","model":"bad|pipe"}},
 "roles":{"writer":{"provider":"opencode","model":"openrouter/stealth/ox-alpha"},
          "fixer":{"provider":"pigeon","model":"carrier"}}}
JSON
check "cfg: opencode flat entry accepted (slashed model, no effort)" \
  "opencode|openrouter/stealth/ox-alpha|" "$(diff_cfg easy)"
check "cfg: opencode writer slot accepted" \
  "opencode|openrouter/stealth/ox-alpha|" "$(diff_cfg normal writer)"
check "cfg: sibling slots of an opencode writer still fall back to the flat entry" \
  "claude|claude-opus-4-8|high" "$(diff_cfg normal completion)"
check "cfg: a pipe in an opencode model stays explicit/fail-closed" \
  "invalid|opencode|" "$(diff_cfg hard)"
check "cfg: opencode role pin resolves" \
  "opencode|openrouter/stealth/ox-alpha|" "$(role_pin_cfg writer)"
check "cfg: an UNKNOWN provider pin is still ignored, never bricking the run" \
  "malformed||" "$(role_pin_cfg fixer)"
mf_uses_claude \
  && ok "a mixed opencode config still detects the claude routes it keeps" \
  || bad "a mixed opencode config should still detect its claude routes"
type cc_opencode >/dev/null 2>&1 \
  && ok "cc_opencode runner is defined" || bad "cc_opencode runner should be defined"
rm -f "$MFSTATE/control/models.json"

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

echo "— merger: the review-requeue budget is bounded per issue (#1232: 140 reviewer runs)"
# Runs against the REAL requeue_for_review — every later merger section stubs it
# out, so this block must stay ahead of them.
RQ_HUMAN=$T/requeue-human.log; : >"$RQ_HUMAN"
RQ_LOG=$T/requeue.log; : >"$RQ_LOG"
mark_human(){ printf '%s|%s\n' "$1" "$2" >>"$RQ_HUMAN"; }
log(){ printf '%s\n' "$*" >>"$RQ_LOG"; }
rm -rf "$CONTROL/requeue-count"
MF_REQUEUE_MAX=3
mkdir -p "$CIFIX"
rq_record(){ # $1=path $2=issue $3=pr — a realistic queue record, not an empty file
  jq -nc --argjson issue "$2" --argjson pr "$3" \
    '{pr:$pr,issue:$issue,touches:["rq/**"],approved_head:"rqhead",
      approval_kind:"reviewer",approval_comment_id:"1"}' >"$1"
}
for i in 1 2 3; do
  rq_record "$MFSTATE/merge-queue/rq-$i.json" 1232 91
  requeue_for_review "$MFSTATE/merge-queue/rq-$i.json" 1232 "attempt $i"
done
check "requeues within budget do not escalate" "0" "$(wc -l <"$RQ_HUMAN" | tr -d ' ')"
check "the durable counter tracks the issue" "3" "$(cat "$CONTROL/requeue-count/1232")"
check "each in-budget requeue logs its position" "1" "$(grep -c 'requeueing for fresh review (3/3)' "$RQ_LOG")"
# An in-budget requeue must NOT clear the refusal budget — a PR that keeps
# earning refusals across review cycles still has to reach the park bound.
: >"$QUEUE/.mergefail-pr91"
rq_record "$MFSTATE/merge-queue/rq-keep.json" 1232 91
MF_REQUEUE_MAX=99 requeue_for_review "$MFSTATE/merge-queue/rq-keep.json" 1232 "in budget"
[ -f "$QUEUE/.mergefail-pr91" ] \
  && ok "an in-budget requeue preserves the refusal budget" \
  || bad "an in-budget requeue must not clear the refusal budget"
# The over-budget park retires the PR for good, so it owes the full cleanup.
: >"$QUEUE/.mergefail-pr91-oldhead"
CIFIX_STATE=$(ci_fix_state_file 1232 91); : >"$CIFIX_STATE"
rq_record "$MFSTATE/merge-queue/rq-4.json" 1232 91
requeue_for_review "$MFSTATE/merge-queue/rq-4.json" 1232 "attempt 4"
check "the requeue past the budget parks with a human" "1" "$(grep -c '^1232|' "$RQ_HUMAN")"
check "the park reason names the budget and the last cause" "1" \
  "$(grep -c 'requeued 5 times (budget 3) — last: attempt 4' "$RQ_HUMAN")"
[ -f "$MFSTATE/merge-queue/rq-4.json" ] \
  && bad "the parked requeue must drop its queue record" \
  || ok "the parked requeue dropped its queue record"
[ -f "$QUEUE/.mergefail-pr91" ] \
  && bad "the over-budget park must clear the refusal counter" \
  || ok "the over-budget park cleared the refusal counter"
[ -f "$QUEUE/.mergefail-pr91-oldhead" ] \
  && bad "the over-budget park must sweep legacy refusal counters" \
  || ok "the over-budget park swept legacy refusal counters"
[ -f "$CIFIX_STATE" ] \
  && bad "the over-budget park must clear the CI-fix state" \
  || ok "the over-budget park cleared the CI-fix state"
# A record with no readable PR still parks; it just has nothing to sweep.
rm -rf "$CONTROL/requeue-count"; : >"$RQ_HUMAN"
printf 'not json' >"$MFSTATE/merge-queue/rq-bad.json"
MF_REQUEUE_MAX=0 requeue_for_review "$MFSTATE/merge-queue/rq-bad.json" 1235 "unreadable record"
check "an unreadable queue record still parks with a human" "1" "$(grep -c '^1235|' "$RQ_HUMAN")"
[ -f "$MFSTATE/merge-queue/rq-bad.json" ] \
  && bad "an unreadable record must still leave the queue" \
  || ok "an unreadable record left the queue"
# The counter is per ISSUE, so an unrelated issue keeps its own full budget.
rm -rf "$CONTROL/requeue-count"; : >"$RQ_HUMAN"
rq_record "$MFSTATE/merge-queue/rq-other.json" 1233 92
requeue_for_review "$MFSTATE/merge-queue/rq-other.json" 1233 "unrelated"
check "the budget is keyed per issue, not globally" "1" "$(cat "$CONTROL/requeue-count/1233")"
check "an unrelated issue is not parked by another issue's budget" "0" "$(grep -c '^1233|' "$RQ_HUMAN")"
# A corrupt counter file must not abort the master under `set -e` arithmetic.
printf 'garbage' >"$CONTROL/requeue-count/1234"
rq_record "$MFSTATE/merge-queue/rq-x.json" 1234 93
requeue_for_review "$MFSTATE/merge-queue/rq-x.json" 1234 "corrupt counter"
check "a corrupt counter file restarts the budget instead of aborting" "1" "$(cat "$CONTROL/requeue-count/1234")"
rm -rf "$CONTROL/requeue-count" "$MFSTATE"/merge-queue/rq-*.json "$QUEUE"/.mergefail-pr9*
unset MF_REQUEUE_MAX
log(){ :; }

echo "— composer: defers to the merge lane while PRs are queued"
# A successful composer run blocks the tick for ~45 min, which freezes MERGING
# too. Reviewed PRs must always drain first.
COMPOSER_RAN=$T/composer-ran.log; : >"$COMPOSER_RAN"
CMP_LOG=$T/composer-defer.log; : >"$CMP_LOG"
CMP_SAVED_RUNNABLE=$(declare -f runnable_issues)
CMP_SAVED_READY=$(declare -f composer_protocol_ready)
CMP_SAVED_PREPARE=$(declare -f composer_request_prepare)
log(){ printf '%s\n' "$*" >>"$CMP_LOG"; }
# Reaching the protocol gate is the observable "the composer was allowed to run".
composer_protocol_ready(){ printf 'ready\n' >>"$COMPOSER_RAN"; return 1; }
runnable_issues(){ :; }                 # 0 runnable → composition is otherwise due
rm -f "$CONTROL/composer-discovery-fence"
rm -f "$MFSTATE"/merge-queue/*.json
# MF_DRY_RUN=1 with no retained request files drives composer_step's else branch,
# which pins COMPOSER_REQUEST_LOADED=0 — the ordinary, non-owner-brief tick.
MF_DRY_RUN=1
composer_step run || true
check "an empty merge queue lets the composer proceed to its protocol gate" "1" \
  "$(wc -l <"$COMPOSER_RAN" | tr -d ' ')"
jq -nc '{pr:70,issue:700,touches:["z/**"],approved_head:"cccc3333",approval_kind:"reviewer",approval_comment_id:"70"}' \
  >"$MFSTATE/merge-queue/1099-pr70.json"
: >"$COMPOSER_RAN"; : >"$CMP_LOG"
composer_step run || true
check "a non-empty merge queue defers composition" "0" "$(wc -l <"$COMPOSER_RAN" | tr -d ' ')"
check "the deferral is logged" "1" "$(grep -c 'composer deferred: merge queue non-empty' "$CMP_LOG")"
# A non-queue file in the queue dir must not be mistaken for a waiting PR.
rm -f "$MFSTATE"/merge-queue/*.json; : >"$MFSTATE/merge-queue/.mergefail-pr70"
: >"$COMPOSER_RAN"; : >"$CMP_LOG"
composer_step run || true
check "queue bookkeeping files alone do not defer composition" "1" \
  "$(wc -l <"$COMPOSER_RAN" | tr -d ' ')"
rm -f "$MFSTATE/merge-queue/.mergefail-pr70"
# An owner brief was explicitly asked for and is exempt from the deferral.
# Case A: an ALREADY-CLAIMED request (.composer-request-active.json), which is
# what sets COMPOSER_REQUEST_LOADED=1 above the mode gate.
jq -nc '{pr:70,issue:700,touches:["z/**"],approved_head:"cccc3333",approval_kind:"reviewer",approval_comment_id:"70"}' \
  >"$MFSTATE/merge-queue/1099-pr70.json"
: >"$COMPOSER_RAN"; : >"$CMP_LOG"
MF_DRY_RUN=0
: >"$CONTROL/.composer-request-active.json"
composer_request_prepare(){ COMPOSER_REQUEST_LOADED=1; return 0; }
composer_step run || true
check "a claimed owner request is exempt from the merge-lane deferral" "1" \
  "$(wc -l <"$COMPOSER_RAN" | tr -d ' ')"
rm -f "$CONTROL/.composer-request-active.json"
COMPOSER_REQUEST_LOADED=0
eval "$CMP_SAVED_PREPARE"        # back to the REAL composer_request_prepare

# Case B — the regression that mattered: a FRESH owner brief. composer-request.json
# is not claimed until composer_request_prepare runs BELOW the deferral guard, so
# COMPOSER_REQUEST_LOADED is still 0 here. Guarding on the flag alone let a stuck
# queue record swallow every new brief while the docs promised exemption. This
# runs the REAL prepare — stubbing it is exactly what hid the bug.
rm -rf "$CONTROL/.composer-request-claim"
rm -f "$CONTROL/.composer-request-active.json"
jq -nc '{version:1,approved:true,id:"brief-1",exact_count:1,brief:"do the thing"}' \
  >"$CONTROL/composer-request.json"
: >"$COMPOSER_RAN"; : >"$CMP_LOG"
composer_step run || true
check "a FRESH owner brief is not swallowed by the merge-lane deferral" "1" \
  "$(wc -l <"$COMPOSER_RAN" | tr -d ' ')"
check "a fresh brief does not log a deferral" "0" \
  "$(grep -c 'composer deferred: merge queue non-empty' "$CMP_LOG")"
# The claim itself sits BELOW the protocol gate (deliberately — a request is only
# claimed once this tick could actually run it), so the stub above stops short of
# it. Drive the real claim directly to prove the fresh file the guard now honours
# is the same one composer_request_prepare goes on to consume.
rm -rf "$CONTROL/.composer-request-claim"
rm -f "$CONTROL/.composer-request-active.json"
composer_request_prepare 1
check "the real prepare claims a fresh brief" "0" "$?"
[ -f "$CONTROL/.composer-request-active.json" ] \
  && ok "the fresh brief is claimed into .composer-request-active.json" \
  || bad "the fresh brief should have been claimed into .composer-request-active.json"
[ -f "$CONTROL/composer-request.json" ] \
  && bad "the ready request must be moved, not copied" \
  || ok "the ready request was moved out of composer-request.json"
check "the claimed brief is loaded for the run" "1" "$COMPOSER_REQUEST_LOADED"
check "the claimed brief carries its id" "brief-1" "$COMPOSER_REQUEST_ID"
check "the claimed brief carries its exact count" "1" "$COMPOSER_REQUEST_EXACT_COUNT"
rm -rf "$CONTROL/.composer-request-claim" "$CONTROL/.composer-request-active.json" \
       "$CONTROL/composer-request.json" "$MFSTATE"/merge-queue/*.json
COMPOSER_REQUEST_LOADED=0
MF_DRY_RUN=1
eval "$CMP_SAVED_RUNNABLE"; eval "$CMP_SAVED_READY"; eval "$CMP_SAVED_PREPARE"
log(){ :; }

echo "— composer outcome model: created / idle / protocol-failure (#1202, #1623)"
# The 2026-08-30 live log: a composer run that CREATED six issues was booked as a
# protocol failure because they were quarantined as not-schedulable, and the
# bounded retry then started a second ~20-minute claude-opus-5 (xhigh) run 31 s
# later — inside the same tick. Three rules are pinned here: created wins over a
# bad artifact contract, an empty run is idle, and a real protocol failure waits
# a full cooldown before its next attempt.
OC_LOG=$T/outcome.log
OC_SAVED_RUNNABLE=$(declare -f runnable_issues)
# An earlier battery leaves the shell in a temp clone — never use $(pwd) here.
MF_PROMPTS=$TEST_SCRIPT_DIR/prompts
MF_COMPOSER_COOLDOWN=900
MF_COMPOSER_PROTOCOL_COOLDOWN=900
MF_COMPOSER_PROTOCOL_BACKOFF_MAX=14400
MF_COMPOSER_PROTOCOL_ATTEMPTS=2
MF_COMPOSER_DISCOVERY_ATTEMPTS=2
MF_COMPOSER_DISCOVERY_SLEEP=0
MF_DRY_RUN=0
COMPOSER_REQUEST_LOADED=0
OC_CALLS=0
OC_AFTER='[]'
OC_CASE=none
log(){ printf '%s\n' "$*" >>"$OC_LOG"; }
runnable_issues(){ :; }
mf_recent_issues_json(){ printf '%s\n' "$OC_AFTER"; }
mf_issue_json_by_number(){ return 1; }
role_diff(){ echo hard; }
with_pack(){ printf '%s' "$1"; }
fetch_issues(){ :; }
mstatus(){ :; }
# Stands in for the model. Reads the run id and manifest path out of the real
# composer prompt, exactly as the helper the composer is told to call would.
mf_cc(){
  local run manifest body
  OC_CALLS=$((OC_CALLS + 1))
  run=$(sed -n 's/^This invocation is `\([^`]*\)`. Issue creation.*/\1/p' <<<"$3" | head -1)
  manifest=$(awk '
    index($0, "/work/mf/create-issue.sh --run-id ") {
      for (i=1; i<=NF; i++) if ($i == "--manifest") { print $(i+1); exit }
    }
  ' <<<"$3")
  case "$OC_CASE" in
    none)     printf 'NONE\n' >"$manifest"; OC_AFTER='[]';;
    silent)   OC_AFTER='[]';;   # no manifest at all: a genuine protocol failure
    created-invalid)
      # Issues WERE filed, but the artifact contract does not hold: the manifest
      # claims an autopilot issue and #913 carries no such label.
      body=$(printf '## Context\nquoted\n\n## Scope\ninvalid\n\n## Acceptance criteria\n- [ ] invalid\n\n## Out of scope\nnone\n\n<!-- mf-meta\nfactory-run: %s\ntouches: invalid\n-->' "$run")
      printf 'ISSUE 913 autopilot\n' >"$manifest"
      OC_AFTER=$(jq -cn --arg body "$body" \
        '[{number:913,title:"invalid",body:$body,labels:["diff:normal"],created_at:"now"}]')
      ;;
  esac
  return 0
}
oc_reset(){
  rm -rf "$CONTROL/composer-discovery-fence" "$CONTROL/composer-manifests"
  rm -f "$CONTROL"/.composer-{last,backoff,snapshot,protocol-last,protocol-backoff,protocol-attempt} \
        "$CONTROL/composer-quarantine"
  rm -f "$MFSTATE"/merge-queue/*.json
  mkdir -p "$CONTROL/composer-manifests"
  printf '[]\n' >"$TICK_ISSUES"
  OC_CALLS=0; OC_AFTER='[]'; : >"$OC_LOG"
}

oc_reset
OC_CASE=created-invalid
composer_step run || true
check "a run whose issues were all quarantined invokes the model once" "1" "$OC_CALLS"
check "quarantined-but-created issues are still fenced off from the scheduler" "913" \
  "$(cat "$CONTROL/composer-quarantine" 2>/dev/null)"
check "created-but-quarantined is NOT booked as a protocol failure" "0" \
  "$(grep -c 'composer protocol failure' "$OC_LOG")"
check "created-but-quarantined is logged as a created outcome" "1" \
  "$(grep -c 'composer outcome created: issues \[913\] quarantined' "$OC_LOG")"
check "created-but-quarantined books the ordinary composer cooldown" "1" \
  "$([ -f "$CONTROL/.composer-last" ] && echo 1 || echo 0)"
check "created-but-quarantined arms no protocol retry" "0" \
  "$([ -e "$CONTROL/.composer-protocol-last" ] && echo 1 || echo 0)"
# The same tick again: the cooldown, not a retry counter, is what must stop it.
composer_step run || true
check "no second composer starts in the same tick after a created run" "1" "$OC_CALLS"

oc_reset
OC_CASE=none
composer_step run || true
check "a valid empty run invokes the model once" "1" "$OC_CALLS"
check "a valid empty run is booked idle, not protocol" "0" \
  "$(grep -c 'composer protocol failure' "$OC_LOG")"
check "a valid empty run feeds the idle backoff (#1202)" "900" \
  "$(cat "$CONTROL/.composer-backoff" 2>/dev/null)"
check "a valid empty run quarantines nothing" "0" \
  "$([ -e "$CONTROL/composer-quarantine" ] && echo 1 || echo 0)"

oc_reset
OC_CASE=silent
composer_step run || true
check "a malformed run invokes the model ONCE per tick, never back-to-back" "1" "$OC_CALLS"
check "a malformed run is booked as attempt 1 of 2" "1" \
  "$(grep -c 'composer protocol failure (attempt 1/2' "$OC_LOG")"
check "the malformed-run retry waits a full composer cooldown" "900" \
  "$(cat "$CONTROL/.composer-protocol-backoff")"
check "the attempt counter outlives the tick" "1" \
  "$(cat "$CONTROL/.composer-protocol-attempt")"
composer_step run || true
check "the next 15-second tick does not re-run the composer" "1" "$OC_CALLS"
backdate "$CONTROL/.composer-protocol-last" 901
composer_step run || true
check "the corrective retry runs only after the protocol cooldown" "2" "$OC_CALLS"
check "the retry is the second attempt, and the backoff doubles" "1" \
  "$(grep -c 'composer protocol failure (attempt 2/2' "$OC_LOG")"
check "repeated malformed runs back off independently" "1800" \
  "$(cat "$CONTROL/.composer-protocol-backoff")"
# A later good run clears the whole correction sequence.
OC_CASE=none
backdate "$CONTROL/.composer-protocol-last" 1801
composer_step run || true
check "a later valid run clears the persisted attempt counter" "0" \
  "$([ -e "$CONTROL/.composer-protocol-attempt" ] && echo 1 || echo 0)"

oc_reset
unset MF_PROMPTS MF_COMPOSER_COOLDOWN MF_COMPOSER_PROTOCOL_COOLDOWN \
  MF_COMPOSER_PROTOCOL_BACKOFF_MAX MF_COMPOSER_PROTOCOL_ATTEMPTS \
  MF_COMPOSER_DISCOVERY_ATTEMPTS MF_COMPOSER_DISCOVERY_SLEEP
unset -f mf_cc mf_recent_issues_json mf_issue_json_by_number role_diff with_pack \
  fetch_issues mstatus
eval "$OC_SAVED_RUNNABLE"
MF_DRY_RUN=1
log(){ :; }
MF_SOURCE_ONLY=1 . "$TEST_SCRIPT_DIR/master.sh"   # restore the real orchestration functions
. "$TEST_SCRIPT_DIR/mflib.sh"

echo "— composer role caps: the priciest role is bounded in turns and wall clock"
# Until #1623 only the Sol branch was capped; a Claude composer inherited
# MF_ROLE_TIMEOUT=7200 with no turn cap at all, which is how one tick could buy
# two ~20-minute xhigh runs. Assert the dispatch mf_cc assembles, per branch.
CAPS_MODELS=$T/caps-models.json
CAPS_OUT=$T/caps-dispatch
cat >"$CAPS_MODELS" <<'JSON'
{"version":2,"difficulties":{"hard":{"provider":"claude","model":"claude-opus-4-8","effort":"max"}},
 "roles":{"composer":{"provider":"claude","model":"claude-opus-5","effort":"xhigh"}}}
JSON
(
  MF_MODELS_FILE=$CAPS_MODELS
  mf_with_claude_profile(){ "$@"; }
  cc(){ printf '%s turns=%s timeout=%s\n' "$1" "${CC_MAX_TURNS:-none}" "${CC_TIMEOUT:-none}"; }
  : >"$CAPS_OUT"
  mf_cc composer hard p >>"$CAPS_OUT"
  mf_cc writer hard p >>"$CAPS_OUT"
  MF_COMPOSER_MAX_TURNS=25 MF_COMPOSER_TIMEOUT=600 mf_cc composer hard p >>"$CAPS_OUT"
  MF_COMPOSER_MAX_TURNS=nonsense MF_COMPOSER_TIMEOUT=99999 mf_cc composer hard p >>"$CAPS_OUT"
)
check "the claude composer carries --max-turns 60 and a 1800s role timeout" \
  "claude-opus-5 turns=60 timeout=1800" "$(sed -n 1p "$CAPS_OUT")"
check "no other role is capped by the composer knobs" \
  "claude-opus-4-8 turns=none timeout=none" "$(sed -n 2p "$CAPS_OUT")"
check "the owner can tighten the composer caps by env" \
  "claude-opus-5 turns=25 timeout=600" "$(sed -n 3p "$CAPS_OUT")"
check "unusable composer caps fall back to the defaults, never to unbounded" \
  "claude-opus-5 turns=60 timeout=1800" "$(sed -n 4p "$CAPS_OUT")"
CAPS_SOL=$T/caps-sol.json
cat >"$CAPS_SOL" <<'JSON'
{"version":2,"difficulties":{"hard":{"provider":"claudex","model":"gpt-5.6-terra","effort":"high"}},
 "roles":{"composer":{"provider":"claudex","model":"gpt-5.6-sol","effort":"high"}}}
JSON
(
  MF_MODELS_FILE=$CAPS_SOL
  cc_claudex(){ printf '%s turns=%s timeout=%s\n' "$1" "${CC_MAX_TURNS:-none}" "${MF_ROLE_TIMEOUT:-none}"; }
  : >"$CAPS_OUT"
  mf_cc composer hard p >>"$CAPS_OUT"
)
check "the Sol composer keeps its own tighter caps" "gpt-5.6-sol turns=40 timeout=1200" \
  "$(sed -n 1p "$CAPS_OUT")"
unset CAPS_MODELS CAPS_OUT CAPS_SOL

echo "— merger: bounded approval-read failures park the queue head (#891 jam)"
MF_DRY_RUN=0
QDIR=$MFSTATE/merge-queue
HUMAN_LOG=$T/human.log; : >"$HUMAN_LOG"
READFAIL_MERGES=$T/readfail-merges.log; : >"$READFAIL_MERGES"
mark_human(){ printf '%s|%s\n' "$1" "$2" >>"$HUMAN_LOG"; }
mstatus(){ :; }
notify(){ :; }
jq -nc '{pr:77,issue:707,touches:["x/**"],approved_head:"aaaa1111",approval_kind:"reviewer",approval_comment_id:"5"}' >"$QDIR/1000-pr77.json"
jq -nc '{pr:78,issue:708,touches:["clean/**"],approved_head:"head78",approval_kind:"reviewer",approval_comment_id:"78"}' >"$QDIR/1001-pr78.json"
mf_pr_comments_json(){
  [ "$1" = 78 ] || return 1
  printf '%s\n' '[{"id":78,"body":"reviewed\nFACTORY-REVIEW-HEAD: head78\nFACTORY-VERDICT: APPROVE"}]'
}
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      mergeStateStatus) echo CLEAN;;
      statusCheckRollup) echo '[{"conclusion":"SUCCESS","status":"COMPLETED"}]';;
    esac
    return 0
  fi
  if [ "$1 $2" = "pr merge" ]; then printf '%s\n' "$3" >>"$READFAIL_MERGES"; return 0; fi
  return 1
}
mf_pr_head(){ [ "$1" != 77 ] || return 1; echo "head$1"; }
: >"$QDIR/.mergefail-pr77"
: >"$QDIR/.mergefail-pr77-oldhead"
MF_APPROVAL_READ_MAX=2
merger_step
[ -f "$QDIR/1000-pr77.json" ] && ok "first read failure retains the queue head" || bad "queue head dropped on first read failure"
check "read-failure counter recorded" "1" "$(cat "$QDIR/.apprfail-pr77" 2>/dev/null)"
check "look-ahead scans past a transient approval read failure" "78" "$(<"$READFAIL_MERGES")"
merger_step
[ -f "$QDIR/1000-pr77.json" ] && bad "queue head must park after the failure cap" || ok "queue head parked after the failure cap"
check "parked head escalated to a human" "1" "$(grep -c '^707|' "$HUMAN_LOG")"
[ -f "$QDIR/.apprfail-pr77" ] && bad "failure counter must be cleared" || ok "failure counter cleared"
[ -f "$QDIR/.mergefail-pr77" ] && bad "parked head must clear its refusal counter" || ok "parked head cleared its refusal counter"
[ -f "$QDIR/.mergefail-pr77-oldhead" ] && bad "parked head must clear legacy refusal counters" || ok "parked head cleared legacy refusal counters"

echo "— merger: DIRTY queue head gets one conflict-fix, then review or human"
: >"$HUMAN_LOG"
CONFLICT_CALLS=$T/conflict-calls; : >"$CONFLICT_CALLS"
jq -nc '{pr:88,issue:808,touches:["y/**"],approved_head:"bbbb2222",approval_kind:"reviewer",approval_comment_id:"6"}' >"$QDIR/1001-pr88.json"
: >"$QDIR/.mergefail-pr88"
: >"$QDIR/.mergefail-pr88-oldhead"
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
[ -f "$QDIR/.mergefail-pr88" ] && bad "conflict human park must clear its refusal counter" || ok "conflict human park cleared its refusal counter"
[ -f "$QDIR/.mergefail-pr88-oldhead" ] && bad "conflict human park must clear legacy refusal counters" || ok "conflict human park cleared legacy refusal counters"
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

echo "— merger: bounded look-ahead skips pending records without reordering"
LOOKAHEAD_MERGES=$T/lookahead-merges.log; : >"$LOOKAHEAD_MERGES"
jq -nc '{pr:41,issue:401,touches:["pending/**"],approved_head:"head41",approval_kind:"reviewer",approval_comment_id:"41"}' >"$QDIR/1004-pr41.json"
jq -nc '{pr:42,issue:402,touches:["clean/**"],approved_head:"head42",approval_kind:"reviewer",approval_comment_id:"42"}' >"$QDIR/1005-pr42.json"
queue_approval_check(){ QUEUE_APPROVAL_STATE=valid; }
mf_pr_head(){ case "$1" in 41) echo head41;; 42) echo head42;; esac; }
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      mergeStateStatus) echo CLEAN;;
      statusCheckRollup)
        if [ "$3" = 41 ]; then echo '[]'; else echo '[{"conclusion":"SUCCESS","status":"COMPLETED"}]'; fi
        ;;
    esac
    return 0
  fi
  if [ "$1 $2" = "pr merge" ]; then printf '%s\n' "$3" >>"$LOOKAHEAD_MERGES"; return 0; fi
  return 0
}
MF_MERGE_LOOKAHEAD=5
merger_step
check "look-ahead merges the clean second record" "42" "$(<"$LOOKAHEAD_MERGES")"
[ -f "$QDIR/1004-pr41.json" ] && ok "pending FIFO head remains in place" || bad "pending FIFO head was removed"
[ -f "$QDIR/1005-pr42.json" ] && bad "merged look-ahead record must leave the queue" || ok "merged look-ahead record left the queue"
rm -f "$QDIR/1004-pr41.json"

echo "— merger: protocol-backoff records do not stall the look-ahead window"
BACKOFF_MERGES=$T/backoff-merges.log; : >"$BACKOFF_MERGES"
jq -nc '{pr:60,issue:410,touches:["backoff/**"],approved_head:"head60",approval_kind:"reviewer",approval_comment_id:"60"}' >"$QDIR/1006-pr60.json"
jq -nc '{pr:61,issue:411,touches:["clean/**"],approved_head:"head61",approval_kind:"reviewer",approval_comment_id:"61"}' >"$QDIR/1007-pr61.json"
mkdir -p "$CIFIX"
jq -nc --argjson next_at "$(( $(date +%s) + 3600 ))" \
  '{issue:410,pr:60,invocations:1,valid_fix_used:false,status:"protocol-backoff",next_at:$next_at,source_head:"head60"}' \
  >"$(ci_fix_state_file 410 60)"
mf_pr_head(){ echo "head$1"; }
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      mergeStateStatus) echo CLEAN;;
      statusCheckRollup)
        if [ "$3" = 60 ]; then echo '[{"conclusion":"FAILURE","status":"COMPLETED"}]'; else echo '[{"conclusion":"SUCCESS","status":"COMPLETED"}]'; fi
        ;;
    esac
    return 0
  fi
  if [ "$1 $2" = "pr merge" ]; then printf '%s\n' "$3" >>"$BACKOFF_MERGES"; return 0; fi
  return 0
}
merger_step
check "look-ahead scans past a delayed CI-fix retry" "61" "$(<"$BACKOFF_MERGES")"
[ -f "$QDIR/1006-pr60.json" ] && ok "protocol-backoff record remains queued" || bad "protocol-backoff record was dropped"
rm -f "$QDIR/1006-pr60.json" "$(ci_fix_state_file 410 60)"

echo "— merger: look-ahead still prefers the FIFO head and merges once per tick"
# Every other merger case has at most ONE mergeable record, so a look-ahead that
# reordered the queue or kept scanning after a landed merge would stay green.
FIFO_MERGES=$T/fifo-merges.log; : >"$FIFO_MERGES"
jq -nc '{pr:43,issue:403,touches:["a/**"],approved_head:"head43",approval_kind:"reviewer",approval_comment_id:"43"}' >"$QDIR/1010-pr43.json"
jq -nc '{pr:44,issue:404,touches:["b/**"],approved_head:"head44",approval_kind:"reviewer",approval_comment_id:"44"}' >"$QDIR/1011-pr44.json"
mf_pr_head(){ case "$1" in 43) echo head43;; 44) echo head44;; esac; }
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      mergeStateStatus) echo CLEAN;;
      statusCheckRollup) echo '[{"conclusion":"SUCCESS","status":"COMPLETED"}]';;
    esac
    return 0
  fi
  if [ "$1 $2" = "pr merge" ]; then printf '%s\n' "$3" >>"$FIFO_MERGES"; return 0; fi
  return 0
}
merger_step
check "two mergeable records: only the FIFO head merges" "43" "$(<"$FIFO_MERGES")"
[ -f "$QDIR/1010-pr43.json" ] && bad "merged FIFO head must leave the queue" || ok "merged FIFO head left the queue"
[ -f "$QDIR/1011-pr44.json" ] && ok "the later mergeable record waits for the next tick" || bad "a second record merged in the same tick"
rm -f "$QDIR/1011-pr44.json"

echo "— merger: the look-ahead window is bounded and MF_MERGE_LOOKAHEAD sanitized"
BOUND_SEEN=$T/bound-seen.log
BOUND_MERGES=$T/bound-merges.log
clear_bound_queue(){
  local pr
  for pr in 45 46 47 48 49 50 51 52 53 54 55; do
    rm -f "$QDIR/$((967 + pr))-pr$pr.json"
  done
}
seed_bound_queue(){ # eleven records; BOUND_MERGEABLE selects the green one
  local pr
  clear_bound_queue
  for pr in 45 46 47 48 49 50 51 52 53 54 55; do
    jq -nc --argjson pr "$pr" --argjson issue "$((360 + pr))" --arg head "head$pr" --arg comment "$pr" \
      '{pr:$pr,issue:$issue,touches:["bound/**"],approved_head:$head,approval_kind:"reviewer",approval_comment_id:$comment}' \
      >"$QDIR/$((967 + pr))-pr$pr.json"
  done
  : >"$BOUND_SEEN"; : >"$BOUND_MERGES"
}
mf_pr_head(){ echo "head$1"; }
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) printf '%s\n' "$3" >>"$BOUND_SEEN"; echo OPEN;;   # first read of a record
      mergeStateStatus) echo CLEAN;;
      statusCheckRollup)
        if [ "$3" = "$BOUND_MERGEABLE" ]; then echo '[{"conclusion":"SUCCESS","status":"COMPLETED"}]'; else echo '[]'; fi
        ;;
    esac
    return 0
  fi
  if [ "$1 $2" = "pr merge" ]; then printf '%s\n' "$3" >>"$BOUND_MERGES"; return 0; fi
  return 0
}
BOUND_MERGEABLE=55
seed_bound_queue
MF_MERGE_LOOKAHEAD=2
merger_step
check "look-ahead stops at the limit — the 3rd record is never inspected" \
  "45 46" "$(tr '\n' ' ' <"$BOUND_SEEN" | sed 's/ *$//')"
check "a mergeable record beyond the limit does not merge" "0" "$(wc -l <"$BOUND_MERGES" | tr -d ' ')"
BOUND_MERGEABLE=50
seed_bound_queue
MF_MERGE_LOOKAHEAD=abc
merger_step
check "non-numeric limit inspects exactly the default five" \
  "45 46 47 48 49" "$(tr '\n' ' ' <"$BOUND_SEEN" | sed 's/ *$//')"
check "fallback-to-5 leaves the mergeable 6th record untouched" "0" "$(wc -l <"$BOUND_MERGES" | tr -d ' ')"
BOUND_MERGEABLE=55
seed_bound_queue
MF_MERGE_LOOKAHEAD=0
merger_step
check "zero limit clamps to the FIFO head alone" "45" "$(tr -d '\n' <"$BOUND_SEEN")"
check "zero limit merges nothing behind the pending head" "0" "$(wc -l <"$BOUND_MERGES" | tr -d ' ')"
seed_bound_queue
MF_MERGE_LOOKAHEAD=999
merger_step
check "oversized limit clamps to ten records" \
  "45 46 47 48 49 50 51 52 53 54" "$(tr '\n' ' ' <"$BOUND_SEEN" | sed 's/ *$//')"
check "upper clamp leaves the mergeable 11th record untouched" "0" "$(wc -l <"$BOUND_MERGES" | tr -d ' ')"
MF_MERGE_LOOKAHEAD=5
clear_bound_queue

echo "— merger: look-ahead never leaks the queue listing into a fixer's stdin"
# `while read … done < <(ls …)` binds the queue-listing pipe to fd 0 for the
# WHOLE compound command, body included. The remediation paths a non-head record
# can now reach spawn `claude -p` (factory/lib.sh cc() redirects stdout only),
# and claude folds non-TTY stdin into the prompt — so the fixer would silently
# receive the remaining queue filenames as input. Feed merger_step a known
# sentinel and assert the fixer sees exactly that, not `1016-pr49.json`.
CIFIX_STDIN=$T/cifix-stdin.log; : >"$CIFIX_STDIN"
jq -nc '{pr:48,issue:408,touches:["f/**"],approved_head:"head48",approval_kind:"reviewer",approval_comment_id:"48"}' >"$QDIR/1015-pr48.json"
jq -nc '{pr:49,issue:409,touches:["g/**"],approved_head:"head49",approval_kind:"reviewer",approval_comment_id:"49"}' >"$QDIR/1016-pr49.json"
mf_pr_head(){ case "$1" in 48) echo head48;; 49) echo head49;; esac; }
mf_cc(){ cat >"$CIFIX_STDIN"; return 0; }
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      mergeStateStatus) echo CLEAN;;
      statusCheckRollup) echo '[{"conclusion":"FAILURE","status":"COMPLETED"}]';;
    esac
    return 0
  fi
  return 0
}
merger_step <<<'MERGER-STDIN-SENTINEL'
check "ci-fix inherits the master's own stdin, not the queue listing" \
  "MERGER-STDIN-SENTINEL" "$(<"$CIFIX_STDIN")"
rm -f "$QDIR/1015-pr48.json" "$QDIR/1016-pr49.json" "$CIFIX/issue-408-pr48.json"

echo "— merger: merge-state recheck routes newly-BEHIND PRs to update-branch"
RECHECK_STATES=$T/recheck-states.log; : >"$RECHECK_STATES"
RECHECK_UPDATES=$T/recheck-updates.log; : >"$RECHECK_UPDATES"
RECHECK_MERGES=$T/recheck-merges.log; : >"$RECHECK_MERGES"
jq -nc '{pr:57,issue:507,touches:["race/**"],approved_head:"race-head",approval_kind:"reviewer",approval_comment_id:"57"}' >"$QDIR/1006-pr57.json"
mf_pr_head(){ echo race-head; }
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      statusCheckRollup) echo '[{"conclusion":"SUCCESS","status":"COMPLETED"}]';;
      mergeStateStatus)
        printf '%s\n' read >>"$RECHECK_STATES"
        if [ "$(wc -l <"$RECHECK_STATES" | tr -d ' ')" = 1 ]; then echo CLEAN; else echo BEHIND; fi
        ;;
    esac
    return 0
  fi
  if [ "$1 $2" = "pr update-branch" ]; then printf '%s\n' "$3" >>"$RECHECK_UPDATES"; return 0; fi
  if [ "$1 $2" = "pr merge" ]; then printf '%s\n' "$3" >>"$RECHECK_MERGES"; return 0; fi
  return 1
}
merger_step
check "merge state is read once at admission and once at the merge boundary" "2" "$(wc -l <"$RECHECK_STATES" | tr -d ' ')"
check "BEHIND recheck invokes update-branch" "57" "$(<"$RECHECK_UPDATES")"
check "BEHIND recheck never invokes merge" "0" "$(wc -l <"$RECHECK_MERGES" | tr -d ' ')"
[ -f "$QDIR/1006-pr57.json" ] && ok "updated BEHIND record stays queued" || bad "updated BEHIND record was dropped"
rm -f "$QDIR/1006-pr57.json"

echo "— merger: merge-state recheck routes newly-DIRTY PRs to conflict-fix"
DIRTY_RECHECK_STATES=$T/dirty-recheck-states.log; : >"$DIRTY_RECHECK_STATES"
DIRTY_RECHECK_FIXES=$T/dirty-recheck-fixes.log; : >"$DIRTY_RECHECK_FIXES"
DIRTY_RECHECK_MERGES=$T/dirty-recheck-merges.log; : >"$DIRTY_RECHECK_MERGES"
: >"$HUMAN_LOG"
jq -nc '{pr:58,issue:508,touches:["race-dirty/**"],approved_head:"dirty-race-head",approval_kind:"reviewer",approval_comment_id:"58"}' >"$QDIR/1006-pr58.json"
: >"$QDIR/.mergefail-pr58"
: >"$QDIR/.mergefail-pr58-oldhead"
mf_pr_head(){ echo dirty-race-head; }
mf_cc(){ printf '%s %s\n' "$1" "$2" >>"$DIRTY_RECHECK_FIXES"; }
gh(){
  if [ "$1 $2" = "pr view" ]; then
    case "$5" in
      state) echo OPEN;;
      statusCheckRollup) echo '[{"conclusion":"SUCCESS","status":"COMPLETED"}]';;
      mergeStateStatus)
        printf '%s\n' read >>"$DIRTY_RECHECK_STATES"
        if [ "$(wc -l <"$DIRTY_RECHECK_STATES" | tr -d ' ')" = 1 ]; then echo CLEAN; else echo DIRTY; fi
        ;;
    esac
    return 0
  fi
  if [ "$1 $2" = "pr merge" ]; then printf '%s\n' "$3" >>"$DIRTY_RECHECK_MERGES"; return 0; fi
  return 1
}
merger_step
check "DIRTY boundary race is read at admission and at the boundary" "2" "$(wc -l <"$DIRTY_RECHECK_STATES" | tr -d ' ')"
check "DIRTY boundary race invokes conflict-fix" "ci-fix hard" "$(<"$DIRTY_RECHECK_FIXES")"
check "DIRTY boundary race never invokes merge" "0" "$(wc -l <"$DIRTY_RECHECK_MERGES" | tr -d ' ')"
[ -f "$QDIR/1006-pr58.json" ] && bad "no-push boundary conflict-fix must clear the queue record" || ok "no-push boundary conflict-fix cleared the queue record"
[ -f "$QDIR/.mergefail-pr58" ] && bad "boundary conflict park must clear its refusal counter" || ok "boundary conflict park cleared its refusal counter"
[ -f "$QDIR/.mergefail-pr58-oldhead" ] && bad "boundary conflict park must clear legacy refusal counters" || ok "boundary conflict park cleared legacy refusal counters"

echo "— merger: refusal budget survives head churn (BLOCKED/DRAFT class)"
: >"$HUMAN_LOG"
MERGER_LOG=$T/merger.log; : >"$MERGER_LOG"
BLOCKED_LOOKAHEAD_MERGES=$T/blocked-lookahead-merges.log; : >"$BLOCKED_LOOKAHEAD_MERGES"
log(){ printf '%s\n' "$*" >>"$MERGER_LOG"; }
jq -nc '{pr:66,issue:606,touches:["v/**"],approved_head:"eeee5555",approval_kind:"reviewer",approval_comment_id:"9"}' >"$QDIR/1007-pr66.json"
jq -nc '{pr:67,issue:607,touches:["w/**"],approved_head:"ffff6666",approval_kind:"reviewer",approval_comment_id:"10"}' >"$QDIR/1008-pr67.json"
: >"$QDIR/.mergefail-pr66-oldhead"
gh(){ case "$*" in
  *"--json state"*) echo OPEN;;
  *"--json statusCheckRollup"*) echo '[{"conclusion":"SUCCESS","status":"","state":""}]';;
  *"pr view 66 --json mergeStateStatus"*) echo BLOCKED;;
  *"pr view 67 --json mergeStateStatus"*) echo CLEAN;;
  *"pr merge 66"*) return 1;;
  *"pr merge 67"*) printf '%s\n' 67 >>"$BLOCKED_LOOKAHEAD_MERGES"; return 0;;
  *) : ;;
esac; }
REFUSAL_HEAD=eeee5555
mf_pr_head(){ if [ "$1" = 66 ]; then echo "$REFUSAL_HEAD"; else echo ffff6666; fi; }
MF_MERGE_FAIL_MAX=2
merger_step
[ -f "$QDIR/1007-pr66.json" ] && ok "first merge refusal retains the queue head" || bad "queue head dropped on first refusal"
check "blocked head look-ahead merges the clean second record" "67" "$(<"$BLOCKED_LOOKAHEAD_MERGES")"
check "merge-refusal counter recorded" "1" "$(jq -r '.count' "$QDIR/.mergefail-pr66" 2>/dev/null)"
check "merge-refusal state carries its diagnostic head" "eeee5555" "$(jq -r '.head' "$QDIR/.mergefail-pr66" 2>/dev/null)"
[ -f "$QDIR/.mergefail-pr66-oldhead" ] && bad "refusal path must sweep legacy counters through mergefail_clear" || ok "refusal path swept legacy counters through mergefail_clear"
check "merge-failure log identifies PR and head" "1" "$(grep -c 'merge command failed for PR #66 at head eeee5555' "$MERGER_LOG")"
REFUSAL_HEAD=ffff7777
jq -nc '{pr:66,issue:606,touches:["v/**"],approved_head:"ffff7777",approval_kind:"reviewer",approval_comment_id:"11"}' >"$QDIR/1007-pr66.json"
merger_step
[ -f "$QDIR/1007-pr66.json" ] && bad "PR must park after failures across two heads reach the cap" || ok "cross-head refusal budget parks the PR at the cap"
check "cross-head refusal cap escalates to a human" "1" "$(grep -c '^606|' "$HUMAN_LOG")"
[ -f "$QDIR/.mergefail-pr66" ] && bad "refusal counter must be cleared" || ok "refusal counter cleared"
log(){ :; }

echo "— merger: BEHIND carry-forward (approval survives non-interacting updates)"
# disjoint files → carry; any overlap, truncated compare, oversized compare or
# read failure → fresh review. Pure function tests over stubbed gh reads.
gh(){ case "$*" in
  *"compare/main...h1"*) echo base1;;
  *"compare/base1...main"*) echo '{"truncated":false,"files":[{"filename":"apps/web/a.tsx"},{"filename":"apps/api/b.ts"}]}';;
  *"--json files"*) printf '%s\n' "apps/web/other.tsx";;
  *) : ;;
esac; }
carry_forward_ok 12 h1 && ok "disjoint files carry the approval" || bad "disjoint files should carry"
gh(){ case "$*" in
  *"compare/main...h1"*) echo base1;;
  *"compare/base1...main"*) echo '{"truncated":false,"files":[{"filename":"apps/web/a.tsx"}]}';;
  *"--json files"*) printf '%s\n' "apps/web/a.tsx";;
  *) : ;;
esac; }
carry_forward_ok 12 h1 && bad "overlapping file must NOT carry" || ok "overlap forces fresh review"
gh(){ case "$*" in
  *"compare/main...h1"*) echo base1;;
  *"compare/base1...main"*) echo '{"truncated":true,"files":[]}';;
  *"--json files"*) printf '%s\n' "apps/web/a.tsx";;
  *) : ;;
esac; }
carry_forward_ok 12 h1 && bad "truncated compare must NOT carry" || ok "truncated compare forces fresh review"
gh(){ return 1; }
carry_forward_ok 12 h1 && bad "read failure must NOT carry" || ok "read failure forces fresh review"
QF2=$QDIR/1005-pr13.json
jq -nc '{pr:13,issue:131,approved_head:"h1"}' >"$QF2"
queue_carry_head "$QF2" "h2" && ok "carry-head write ok" || bad "carry-head write failed"
check "carried head recorded beside the original approval" "h2" "$(jq -r '.carried_head' "$QF2")"
check "original approved head untouched" "h1" "$(jq -r '.approved_head' "$QF2")"
rm -f "$QF2"
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
