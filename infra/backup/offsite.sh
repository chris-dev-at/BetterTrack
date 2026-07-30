#!/usr/bin/env bash
# BetterTrack offsite backup utility.
#
# Upload mode encrypts and copies every missing local dump. It never calls a
# delete operation, so its rclone credential can be append-only/delete-less.
# Retention mode is a separate, explicitly enabled invocation with a distinct
# rclone configuration. Both modes update the shared machine-readable status.
set -euo pipefail

BACKUP_DIR="${BT_BACKUP_SOURCE_DIR:-/backups}"
MODE="${BT_BACKUP_OFFSITE_MODE:-upload}"
RECIPIENT_FILE="${BT_BACKUP_AGE_RECIPIENT_FILE:-}"
UPLOAD_CONFIG="${BT_BACKUP_UPLOAD_RCLONE_CONFIG:-${RCLONE_CONFIG:-}}"
UPLOAD_REMOTE="${BT_BACKUP_RCLONE_REMOTE:-}"
RETENTION_ENABLED="${BT_BACKUP_REMOTE_RETENTION_ENABLED:-false}"
RETENTION_CONFIG="${BT_BACKUP_RETENTION_RCLONE_CONFIG:-}"
RETENTION_REMOTE="${BT_BACKUP_RETENTION_RCLONE_REMOTE:-}"
RETENTION_DAYS="${BT_BACKUP_REMOTE_RETENTION_DAYS:-30}"

# shellcheck source=infra/backup/status.sh
source "$(dirname "${BASH_SOURCE[0]}")/status.sh"

attempt_epoch="$(date -u +%s)"
outcome='failed'
uploaded=0

log() {
    echo "bettertrack-offsite: $*"
}

record_status() {
    local exit_code="${1:-$?}"
    local status_code
    status_code=0
    trap - EXIT

    if [ "${MODE}" = 'retention' ]; then
        bt_status_update \
            "offsite_retention_last_attempt_epoch=${attempt_epoch}" \
            "offsite_retention_outcome=${outcome}" ||
            status_code=$?
    else
        bt_status_update \
            "offsite_last_attempt_epoch=${attempt_epoch}" \
            "offsite_outcome=${outcome}" \
            "offsite_uploaded_count=${uploaded}" \
            'offsite_retention=manual_or_provider' ||
            status_code=$?
    fi
    [ "${status_code}" -eq 0 ] || exit_code=8
    exit "${exit_code}"
}
trap record_status EXIT

rclone_upload() {
    if [ -n "${UPLOAD_CONFIG}" ]; then
        rclone --config "${UPLOAD_CONFIG}" "$@"
    else
        rclone "$@"
    fi
}

run_retention() {
    if [ "${RETENTION_ENABLED}" != 'true' ]; then
        outcome='disabled'
        log "remote retention disabled; use provider-side/versioned retention or the separately credentialed retention service"
        return 0
    fi
    if [ -z "${RETENTION_CONFIG}" ] || [ -z "${RETENTION_REMOTE}" ]; then
        log "ERROR: retention is enabled but its separate config or remote is unset"
        exit 7
    fi
    if [ ! -r "${RETENTION_CONFIG}" ]; then
        log "ERROR: retention rclone config is not readable"
        exit 7
    fi
    if [[ ! "${RETENTION_DAYS}" =~ ^[1-9][0-9]*$ ]]; then
        log "ERROR: BT_BACKUP_REMOTE_RETENTION_DAYS must be a positive integer"
        exit 7
    fi

    log "pruning remote artifacts older than ${RETENTION_DAYS}d with the retention-only credential"
    if ! rclone --config "${RETENTION_CONFIG}" delete "${RETENTION_REMOTE}" \
        --min-age "${RETENTION_DAYS}d" \
        --include 'bettertrack-*.sql.gz.age'; then
        log "ERROR: remote prune failed"
        exit 7
    fi
    outcome='success'
    log "remote retention done"
}

if [ "${MODE}" = 'retention' ]; then
    run_retention
    exit 0
fi
if [ "${MODE}" != 'upload' ]; then
    log "ERROR: BT_BACKUP_OFFSITE_MODE must be upload or retention"
    exit 2
fi

# ─── upload env gate ─────────────────────────────────────────────────────────
missing=()
[ -n "${RECIPIENT_FILE}" ] || missing+=('BT_BACKUP_AGE_RECIPIENT_FILE')
[ -n "${UPLOAD_REMOTE}" ] || missing+=('BT_BACKUP_RCLONE_REMOTE')
if [ ${#missing[@]} -gt 0 ]; then
    outcome='skipped_unconfigured'
    log "offsite skipped (unset: ${missing[*]})"
    exit 0
fi

if [ ! -r "${RECIPIENT_FILE}" ]; then
    log "ERROR: recipient file not readable at expected in-container path — check the bind mount"
    exit 2
fi
if [ -n "${UPLOAD_CONFIG}" ] && [ ! -r "${UPLOAD_CONFIG}" ]; then
    log "ERROR: upload rclone config is not readable"
    exit 2
fi
if [ ! -d "${BACKUP_DIR}" ] || [ ! -r "${BACKUP_DIR}" ] || [ ! -x "${BACKUP_DIR}" ]; then
    log "ERROR: backup source directory is not readable at ${BACKUP_DIR}"
    exit 3
fi

work_dir="$(mktemp -d)"
cleanup_and_record() {
    local exit_code=$?
    rm -rf -- "${work_dir}"
    record_status "${exit_code}"
}
trap cleanup_and_record EXIT

# Filenames contain UTC timestamps, so reverse lexical order is newest-first.
local_listing="${work_dir}/local-dumps"
if ! find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'bettertrack-*.sql.gz' -print0 |
    LC_ALL=C sort -zr > "${local_listing}"; then
    log "ERROR: could not enumerate local dumps in ${BACKUP_DIR}"
    exit 3
fi
mapfile -d '' -t local_dumps < "${local_listing}"

if [ ${#local_dumps[@]} -eq 0 ]; then
    outcome='success_no_artifacts'
    log "no local dump found in ${BACKUP_DIR} — nothing to upload"
    exit 0
fi

log "ensuring remote backup directory exists: ${UPLOAD_REMOTE}"
if ! rclone_upload mkdir "${UPLOAD_REMOTE}"; then
    log "ERROR: rclone could not create or access the remote backup directory"
    exit 4
fi

remote_listing="${work_dir}/remote-artifacts"
if ! rclone_upload lsf "${UPLOAD_REMOTE}" \
    --files-only \
    --format p \
    --include 'bettertrack-*.sql.gz.age' > "${remote_listing}"; then
    log "ERROR: rclone could not list existing remote artifacts"
    exit 4
fi

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

    log "uploading ${artifact} -> ${UPLOAD_REMOTE}"
    if ! rclone_upload copy "${encrypted}" "${UPLOAD_REMOTE}" --no-traverse; then
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

outcome='success'
log "upload complete; remote retention is manual/provider-side unless the separate retention service is enabled"
