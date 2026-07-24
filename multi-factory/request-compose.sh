#!/usr/bin/env bash
# Queue one owner-approved, exact-count composer brief in gitignored control state.
#
# Usage:
#   ./multi-factory/request-compose.sh 2 /absolute/path/to/brief.md [request-id]
#
# The exact count is also the effective COMPOSER_BATCH for this invocation. The
# master validates it against its configured COMPOSER_BATCH ceiling, claims the
# request once, and archives it only after an exact valid manifest.
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
MFSTATE=${MFSTATE:-"$SCRIPT_DIR/state"}
CONTROL="$MFSTATE/control"
COUNT=${1:-}
BRIEF_FILE=${2:-}
REQUEST_ID=${3:-"owner-$(date -u +%Y%m%dT%H%M%SZ)-$$"}
MAX_BATCH=${COMPOSER_BATCH:-10}

usage(){
  echo "usage: $0 <exact-count> <brief-file> [request-id]" >&2
  exit 2
}

[ -n "$COUNT" ] && [ -n "$BRIEF_FILE" ] || usage
printf '%s\n' "$COUNT" | grep -Eq '^[1-9][0-9]*$' || usage
printf '%s\n' "$MAX_BATCH" | grep -Eq '^[1-9][0-9]*$' \
  || { echo "invalid COMPOSER_BATCH ceiling: $MAX_BATCH" >&2; exit 2; }
[ "$COUNT" -le "$MAX_BATCH" ] \
  || { echo "exact count $COUNT exceeds COMPOSER_BATCH ceiling $MAX_BATCH" >&2; exit 2; }
[ -r "$BRIEF_FILE" ] || { echo "brief file is not readable: $BRIEF_FILE" >&2; exit 2; }
BRIEF_BYTES=$(wc -c <"$BRIEF_FILE" | tr -d ' ')
[ "$BRIEF_BYTES" -gt 0 ] && [ "$BRIEF_BYTES" -le 20000 ] \
  || { echo "brief must contain 1–20000 bytes" >&2; exit 2; }
case "$REQUEST_ID" in
  [A-Za-z0-9]*) ;;
  *) echo "request id must start with an ASCII letter or digit" >&2; exit 2;;
esac
case "$REQUEST_ID" in
  *[!A-Za-z0-9._-]*)
    echo "request id may contain only ASCII letters, digits, dot, underscore, and dash" >&2
    exit 2;;
esac
[ "${#REQUEST_ID}" -le 80 ] || { echo "request id is longer than 80 characters" >&2; exit 2; }

mkdir -p "$CONTROL"
READY="$CONTROL/composer-request.json"
ACTIVE="$CONTROL/.composer-request-active.json"
CLAIM="$CONTROL/.composer-request-claim"
SUBMIT="$CONTROL/.composer-request-submit"
mkdir "$SUBMIT" 2>/dev/null || {
  echo "another composer request submission is in progress" >&2
  exit 1
}
TMP=
cleanup(){
  [ -z "$TMP" ] || rm -f "$TMP"
  rmdir "$SUBMIT" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
[ ! -e "$READY" ] && [ ! -e "$ACTIVE" ] && [ ! -e "$CLAIM" ] || {
  echo "a composer request is already ready or active; inspect control state before replacing it" >&2
  exit 1
}

TMP=$(mktemp "$CONTROL/.composer-request.XXXXXX")
jq -n \
  --arg id "$REQUEST_ID" \
  --argjson exact "$COUNT" \
  --rawfile brief "$BRIEF_FILE" \
  '{version:1,approved:true,id:$id,exact_count:$exact,brief:$brief}' >"$TMP"
mv "$TMP" "$READY"
TMP=
rmdir "$SUBMIT"
trap - EXIT HUP INT TERM

printf 'queued composer request %s (exact issues: %s)\n' "$REQUEST_ID" "$COUNT"
printf 'state: %s\n' "$READY"
