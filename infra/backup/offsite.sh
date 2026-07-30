#!/usr/bin/env bash
# BetterTrack offsite backup step (PROJECTPLAN.md §13.4 V4-P6 arc-b).
#
# Runs inside the `backup-offsite` sidecar (infra/docker-compose.offsite.yml)
# AFTER `backup.sh` has produced the daily gzip'd pg_dump into the shared
# `pgbackups` volume. Enumerates every eligible local dump newest-first and
# encrypts/uploads each artifact absent from the configured remote. The age
# recipient is encrypt-only on the box — the decryption key stays offline with
# the owner. Rclone works with Google Drive in production and any supported
# backend (including a `local` remote for CI/demo), then prunes remote objects
# older than BT_BACKUP_REMOTE_RETENTION_DAYS (default 30).
#
# Env-gated: if the recipient file or the rclone remote is not configured,
# the step logs a single "offsite skipped" line and exits 0 — today's local
# behavior is untouched. A configured but unreadable recipient, failed remote
# listing, encryption, upload, or prune exits non-zero so host cron surfaces
# the failure. Encrypted temp files are discarded and local .sql.gz dumps stay
# intact for the next retry. See docs/ops.md for the full runbook.
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
    log "ERROR: recipient file not readable at expected in-container path — check the bind mount"
    exit 2
fi

# ─── find eligible local dumps ───────────────────────────────────────────────
# Filenames are UTC timestamps, so reverse lexical order is newest-first even
# if a restore or copy has changed the files' mtimes. The sidecar includes GNU
# find/sort specifically for the NUL-safe enumeration below.
if [ ! -d "${BACKUP_DIR}" ] || [ ! -r "${BACKUP_DIR}" ] || [ ! -x "${BACKUP_DIR}" ]; then
    log "ERROR: backup source directory is not readable at ${BACKUP_DIR}"
    exit 3
fi

work_dir="$(mktemp -d)"
trap 'rm -rf -- "${work_dir}"' EXIT

local_listing="${work_dir}/local-dumps"
if ! find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'bettertrack-*.sql.gz' -print0 \
    | LC_ALL=C sort -zr > "${local_listing}"; then
    log "ERROR: could not enumerate local dumps in ${BACKUP_DIR}"
    exit 3
fi
mapfile -d '' -t local_dumps < "${local_listing}"

if [ ${#local_dumps[@]} -eq 0 ]; then
    log "no local dump found in ${BACKUP_DIR} — nothing to upload"
    exit 0
fi

# ─── find remote artifacts already uploaded ──────────────────────────────────
# Ensure a freshly configured destination is usable before listing it: `rclone
# lsf` alone treats a missing directory as an error even though `copy` creates
# it on first upload.
log "ensuring remote backup directory exists: ${RCLONE_REMOTE}"
if ! rclone mkdir "${RCLONE_REMOTE}"; then
    log "ERROR: rclone could not create or access the remote backup directory"
    exit 4
fi

# `rclone lsf` lists the direct contents of the configured backup folder. The
# local script writes there too, so each remote path is the encrypted basename.
remote_listing="${work_dir}/remote-artifacts"
if ! rclone lsf "${RCLONE_REMOTE}" \
    --files-only \
    --format p \
    --include 'bettertrack-*.sql.gz.age' > "${remote_listing}"; then
    log "ERROR: rclone could not list existing remote artifacts"
    exit 4
fi

# ─── encrypt and upload every missing artifact ───────────────────────────────
uploaded=0
for local_dump in "${local_dumps[@]}"; do
    base="$(basename "${local_dump}")"
    artifact="${base}.age"

    if grep -Fqx -- "${artifact}" "${remote_listing}"; then
        log "already present remotely: ${artifact}"
        continue
    fi

    encrypted="${work_dir}/${artifact}"
    log "encrypting ${base} -> ${artifact} (recipients from file)"
    if ! age -R "${RECIPIENT_FILE}" -o "${encrypted}" "${local_dump}"; then
        log "ERROR: age encryption failed for ${base}; local dump preserved"
        exit 5
    fi
    log "encrypted ${artifact} ($(du -h "${encrypted}" | cut -f1))"

    # --no-traverse avoids an extra per-file destination listing; the complete
    # remote listing above is the authoritative missing-artifact check.
    log "uploading ${artifact} -> ${RCLONE_REMOTE}"
    if ! rclone copy "${encrypted}" "${RCLONE_REMOTE}" --no-traverse; then
        log "ERROR: rclone upload failed; local dump preserved for next run"
        exit 6
    fi
    uploaded=$((uploaded + 1))
    log "upload ok: ${artifact}"
    rm -f -- "${encrypted}"
done

if [ "${uploaded}" -eq 0 ]; then
    log "all eligible local dumps are already present remotely"
fi

# ─── prune remote per retention window ───────────────────────────────────────
log "pruning remote artifacts older than ${RETENTION_DAYS}d in ${RCLONE_REMOTE}"
if ! rclone delete "${RCLONE_REMOTE}" \
    --min-age "${RETENTION_DAYS}d" \
    --include 'bettertrack-*.sql.gz.age'; then
    log "ERROR: remote prune failed; next run will retry"
    exit 7
fi

log "offsite backup done"
