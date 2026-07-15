#!/usr/bin/env bash
# BetterTrack offsite backup step (PROJECTPLAN.md §13.4 V4-P6 arc-b).
#
# Runs inside the `backup-offsite` sidecar (infra/docker-compose.offsite.yml)
# AFTER `backup.sh` has produced the daily gzip'd pg_dump into the shared
# `pgbackups` volume. Encrypts the newest local dump to an owner-provided
# age recipient (encrypt-only on the box — the decryption key stays offline
# with the owner), uploads via rclone to a configured remote (Google Drive
# in production; any rclone remote works, including a `local` remote for
# CI/demo), then prunes remote objects older than
# BT_BACKUP_REMOTE_RETENTION_DAYS (default 30).
#
# Env-gated: if the recipient file or the rclone remote is not configured,
# the step logs a single "offsite skipped" line and exits 0 — today's local
# behavior is untouched. A failed upload leaves the local .sql.gz intact
# (the encrypted temp file is discarded) and exits non-zero so the cron log
# surfaces the failure. See docs/ops.md for the full runbook.
#
# NO shell tracing (`set -x`) anywhere. The rclone config file mounted at
# $RCLONE_CONFIG holds Drive OAuth tokens; the age recipient file holds
# public-key material only, but we still keep both out of logs.
set -euo pipefail

BACKUP_DIR="${BT_BACKUP_SOURCE_DIR:-/backups}"
RECIPIENT_FILE="${BT_BACKUP_AGE_RECIPIENT_FILE:-}"
RCLONE_REMOTE="${BT_BACKUP_RCLONE_REMOTE:-}"
RETENTION_DAYS="${BT_BACKUP_REMOTE_RETENTION_DAYS:-30}"

log() {
    echo "bettertrack-offsite: $*"
}

# ─── env gate ────────────────────────────────────────────────────────────────
missing=()
[ -n "${RECIPIENT_FILE}" ] || missing+=('BT_BACKUP_AGE_RECIPIENT_FILE')
[ -n "${RCLONE_REMOTE}" ] || missing+=('BT_BACKUP_RCLONE_REMOTE')
if [ ${#missing[@]} -gt 0 ]; then
    log "offsite skipped (unset: ${missing[*]})"
    exit 0
fi

if [ ! -r "${RECIPIENT_FILE}" ]; then
    log "ERROR: recipient file not readable at expected in-container path — check the bind mount; offsite skipped"
    exit 0
fi

# ─── pick the newest local dump ──────────────────────────────────────────────
# Sort by filename descending — the `bettertrack-YYYYmmdd-HHMMSS.sql.gz`
# pattern is lexicographically ordered by timestamp, so this picks the newest
# dump even if mtimes were touched (e.g. after a restore).
latest="$(find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'bettertrack-*.sql.gz' \
    2>/dev/null | LC_ALL=C sort -r | head -n1)"

if [ -z "${latest}" ]; then
    log "no local dump found in ${BACKUP_DIR} — nothing to upload"
    exit 0
fi

base="$(basename "${latest}")"
work_dir="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '${work_dir}'" EXIT
encrypted="${work_dir}/${base}.age"

# ─── encrypt to recipient ────────────────────────────────────────────────────
log "encrypting ${base} -> ${base}.age (recipients from file)"
if ! age -R "${RECIPIENT_FILE}" -o "${encrypted}" "${latest}"; then
    log "ERROR: age encryption failed for ${base}; local dump preserved"
    exit 4
fi
log "encrypted ${base}.age ($(du -h "${encrypted}" | cut -f1))"

# ─── upload via rclone ───────────────────────────────────────────────────────
# --no-traverse: skip listing the destination before uploading (single-file
# upload, cheaper on Drive). Rclone honours $RCLONE_CONFIG for the config path.
log "uploading ${base}.age -> ${RCLONE_REMOTE}"
if ! rclone copy "${encrypted}" "${RCLONE_REMOTE}" --no-traverse; then
    log "ERROR: rclone upload failed; local dump preserved for next run"
    exit 5
fi
log "upload ok"

# ─── prune remote per retention window ───────────────────────────────────────
log "pruning remote artifacts older than ${RETENTION_DAYS}d in ${RCLONE_REMOTE}"
if ! rclone delete "${RCLONE_REMOTE}" \
    --min-age "${RETENTION_DAYS}d" \
    --include 'bettertrack-*.sql.gz.age'; then
    log "WARN: remote prune failed (upload succeeded); next run will retry"
fi

log "offsite backup done"
