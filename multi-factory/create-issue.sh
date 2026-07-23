#!/usr/bin/env bash
# The only supported issue-creation path for multi-factory model roles.
# It validates the body before mutation, adds orchestration labels itself, tags
# the issue with an invocation token, and records the authoritative issue number.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/contracts.sh"

run_id=""; manifest=""; difficulty=""; title=""; body_file=""; relocated_from=""; mode=autopilot
while [ "$#" -gt 0 ]; do
  case "$1" in
    --run-id) run_id=${2:-}; shift 2;;
    --manifest) manifest=${2:-}; shift 2;;
    --difficulty) difficulty=${2:-}; shift 2;;
    --title) title=${2:-}; shift 2;;
    --body-file) body_file=${2:-}; shift 2;;
    --relocated-from) relocated_from=${2:-}; shift 2;;
    --mode) mode=${2:-}; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

case " $MF_DIFF_ORDER " in *" $difficulty "*) ;; *) echo "invalid difficulty" >&2; exit 2;; esac
case "$mode" in autopilot|awaiting-owner|relocated) ;; *) echo "invalid issue mode" >&2; exit 2;; esac
[[ "$run_id" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "invalid run id" >&2; exit 2; }
[ -n "$manifest" ] && [ -n "$title" ] && [ -f "$body_file" ] \
  || { echo "manifest, title and body file are required" >&2; exit 2; }
if [ -n "$relocated_from" ]; then
  [[ "$relocated_from" =~ ^[0-9]+$ ]] || { echo "invalid relocated parent" >&2; exit 2; }
  [ "$mode" = relocated ] || { echo "--relocated-from requires --mode relocated" >&2; exit 2; }
elif [ "$mode" = relocated ]; then
  echo "--mode relocated requires --relocated-from" >&2
  exit 2
fi

body=$(<"$body_file")
mf_issue_body_valid "$body" "" || {
  echo "body rejected: required sections or terminal mf-meta are invalid" >&2
  exit 3
}
grep -q '^[[:space:]]*factory-run:' <<<"$(mf_meta_block <<<"$body")" && {
  echo "body rejected: factory-run is orchestration-owned" >&2
  exit 3
}

tmp=$(mktemp "${TMPDIR:-/tmp}/mf-issue.XXXXXX")
trap 'rm -f "$tmp"' EXIT
awk -v run="$run_id" -v parent="$relocated_from" '
  /^[[:space:]]*<!--[[:space:]]*mf-meta[[:space:]]*$/ && !inserted {
    if (parent != "") print "Relocated from #" parent " by checker triage.\n"
    print
    print "factory-run: " run
    inserted=1
    next
  }
  { print }
' "$body_file" >"$tmp"
mf_issue_body_valid "$(<"$tmp")" "$run_id" || {
  echo "internal error: tagged body failed validation" >&2
  exit 3
}

labels=(--label "diff:$difficulty")
case "$mode" in
  relocated) labels+=(--label mf:relocated);;
  awaiting-owner) labels+=(--label awaiting-owner);;
esac
url=$(gh issue create --title "$title" --body-file "$tmp" "${labels[@]}")
number=${url##*/}
[[ "$number" =~ ^[0-9]+$ ]] || {
  echo "could not parse created issue number from: $url" >&2
  exit 4
}

mkdir -p "$(dirname "$manifest")"
printf 'ISSUE %s %s\n' "$number" "$mode" >>"$manifest"
# Relocations remain quarantined until worker-side validation publishes them.
# Awaiting-owner issues intentionally never become scheduler-visible.
[ "$mode" = autopilot ] && gh issue edit "$number" --add-label autopilot >/dev/null
printf '%s\n' "$url"
