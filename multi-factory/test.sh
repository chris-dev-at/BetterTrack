#!/usr/bin/env bash
# multi-factory/test.sh — offline unit tests for the deterministic scheduler core.
#
# Sources master.sh with MF_SOURCE_ONLY=1 (lib.sh + boot + loop skipped), stubs
# gh/log/notify, and drives the pure functions with fabricated issues and state
# files: mf-meta parsing, claim conflicts, assignment, dependency gating, FIFO
# order, acks and stall recovery (BRIEF acceptance test 1, offline half).
# Run on the host: ./multi-factory/test.sh   (no Docker, no network, no tokens)
set -uo pipefail
cd "$(dirname "$0")"

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
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
check "conflicting #202 stays unassigned" "" "$(grep -l 202 "$MFSTATE"/assignments/*.json 2>/dev/null || true)"

echo "— scheduler: missing mf-meta serializes (runs alone)"
rm -f "$MFSTATE"/assignments/*.json
cat >"$TICK_ISSUES" <<'JSON'
[
 {"number":210,"title":"no meta","body":"no machine block here","labels":["autopilot"]},
 {"number":211,"title":"disjoint","body":"x\n<!-- mf-meta\ntouches: apps/web/**\n-->","labels":["autopilot"]}
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
 {"number":220,"title":"dep open","body":"x\n<!-- mf-meta\ndepends-on: 900\ntouches: apps/api/**\n-->","labels":["autopilot"]},
 {"number":221,"title":"dep closed","body":"x\n<!-- mf-meta\ndepends-on: 901\ntouches: apps/web/**\n-->","labels":["autopilot"]}
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
[{"number":231,"title":"overlaps queued PR","body":"x\n<!-- mf-meta\ntouches: apps/api/src/z.ts\n-->","labels":["autopilot"]}]
JSON
rm -rf "$TICK_DEPS"; mkdir -p "$TICK_DEPS"
scheduler run
check "issue overlapping queued PR stays unassigned" "0" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"
rm -f "$MFSTATE"/merge-queue/*.json

echo "— FIFO merge-queue head selection"
printf '{}' >"$MFSTATE/merge-queue/1700000200-pr7.json"
printf '{}' >"$MFSTATE/merge-queue/1700000100-pr9.json"
printf '{}' >"$MFSTATE/merge-queue/.cifix-pr9"
HEAD=$(ls "$MFSTATE/merge-queue" | grep -E '^[0-9]+-pr[0-9]+\.json$' | sort -n | head -1)
check "oldest epoch first, dotfiles ignored" "1700000100-pr9.json" "$HEAD"
rm -f "$MFSTATE"/merge-queue/* "$MFSTATE"/merge-queue/.cifix-pr9 2>/dev/null || true

echo "— process_acks removes finished assignments"
printf '%s\n' '{"issue":240,"assigned_at":"x","touches":["a/**"],"relocated":false}' >"$MFSTATE/assignments/worker-1.json"
printf '%s\n' '{"phase":"done","issue":240,"pr":91,"updated_at":"x"}' >"$MFSTATE/status/worker-1.json"
process_acks
check "done worker acked (assignment removed)" "0" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"

echo "— stall detection with fabricated state files"
printf '%s\n' '{"issue":250,"assigned_at":"x","touches":["a/**"],"relocated":false}' >"$MFSTATE/assignments/worker-2.json"
printf '%s\n' '{"phase":"writing","issue":250,"pr":null,"updated_at":"x"}' >"$MFSTATE/status/worker-2.json"
touch -t 202001010000 "$MFSTATE/status/worker-2.hb"
echo open >"$T/ghdeps/250"
MF_STALL_SECS=3600 stall_check
check "stalled assignment cleared for reschedule" "0" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"
printf '%s\n' '{"issue":251,"assigned_at":"x","touches":["a/**"],"relocated":false}' >"$MFSTATE/assignments/worker-2.json"
date -Is >"$MFSTATE/status/worker-2.hb" 2>/dev/null || date >"$MFSTATE/status/worker-2.hb"
MF_STALL_SECS=3600 stall_check
check "fresh heartbeat NOT treated as stall" "1" "$(ls "$MFSTATE"/assignments/*.json 2>/dev/null | wc -l | tr -d ' ')"

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
echo '[{"number":260,"title":"new issue appeared","body":"x","labels":["autopilot"]}]' >"$TICK_ISSUES"
composer_step run
check "open-issue set change resets backoff to base (900)" "900" "$(cat "$MFSTATE/control/.composer-backoff")"

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
check "cfg: invalid provider falls back to builtin" "claude|claude-fable-5|max" "$(diff_cfg max)"
check "cfg: unset difficulty uses builtin default" "claude|claude-opus-4-8|medium" "$(diff_cfg normal)"
check "cfg: composer role slot honored" "intermediate" "$(role_diff composer)"
check "cfg: checker role slot honored" "max" "$(role_diff checker)"
check "cfg: review floor honored" "hard" "$(review_floor)"
mf_uses_claude && ok "mixed config still detects claude" || bad "mixed config should detect claude"
cat >"$MFSTATE/control/models.json" <<'JSON'
{"difficulties":{
  "easy":{"provider":"gemini","model":"g"},"normal":{"provider":"gemini","model":"g"},
  "intermediate":{"provider":"codex","model":"c"},"hard":{"provider":"codex","model":"c"},
  "max":{"provider":"codex","model":"c","effort":"xhigh"}}}
JSON
mf_uses_claude && bad "claude-free config should report false" || ok "claude-free config → mf_uses_claude false"
rm -f "$MFSTATE/control/models.json"
check "cfg: missing file → builtin default" "claude|claude-sonnet-5|high" "$(diff_cfg easy)"
check "cfg: missing file → role default hard" "hard" "$(role_diff checker)"
check "cfg: missing file → floor default intermediate" "intermediate" "$(review_floor)"

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
