#!/bin/bash
# BetterTrack scheduled local backup script.
#
# Runs in the `backup-scheduler` service, writes into the shared `pgbackups`
# volume, verifies the gzip, records status, and preserves the existing local
# retention behavior. It can still be invoked manually inside that service.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DB_NAME="${POSTGRES_DB:-bettertrack}"
DB_USER="${POSTGRES_USER:-bt}"
DB_HOST="${POSTGRES_HOST:-}"
DB_PORT="${POSTGRES_PORT:-5432}"

ts="$(date -u +%Y%m%d-%H%M%S)"
dest="${BACKUP_DIR}/bettertrack-${ts}.sql.gz"
attempt_epoch="$(date -u +%s)"
attempt_outcome='failed'
artifact_name="$(basename "${dest}")"
artifact_size=''
artifact_checksum=''
success_epoch=''

# shellcheck source=infra/backup/status.sh
source "$(dirname "${BASH_SOURCE[0]}")/status.sh"

if ! bt_status_get offsite_outcome >/dev/null 2>&1; then
    bt_status_update \
        'offsite_outcome=not_attempted' \
        'offsite_uploaded_count=0' \
        'offsite_retention=manual_or_provider'
fi

finalize() {
    local exit_code=$?
    local status_code
    status_code=0
    trap - EXIT
    rm -f -- "${dest}.tmp"

    if [ "${attempt_outcome}" = 'success' ] && [ "${exit_code}" -eq 0 ]; then
        bt_status_update \
            "last_attempt_epoch=${attempt_epoch}" \
            'last_attempt_outcome=success' \
            "last_success_epoch=${success_epoch}" \
            "last_artifact=${artifact_name}" \
            "last_artifact_bytes=${artifact_size}" \
            "last_artifact_sha256=${artifact_checksum}" ||
            status_code=$?
    else
        bt_status_update \
            "last_attempt_epoch=${attempt_epoch}" \
            'last_attempt_outcome=failed' ||
            status_code=$?
    fi
    [ "${status_code}" -eq 0 ] || exit_code=8
    exit "${exit_code}"
}
trap finalize EXIT

mkdir -p "${BACKUP_DIR}"
if [[ ! "${RETENTION_DAYS}" =~ ^[1-9][0-9]*$ ]]; then
    echo "bettertrack-backup: BACKUP_RETENTION_DAYS must be a positive integer" >&2
    exit 2
fi

pg_dump_args=(-U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists --no-owner)
if [ -n "${DB_HOST}" ]; then
    pg_dump_args=(-h "${DB_HOST}" -p "${DB_PORT}" "${pg_dump_args[@]}")
fi

echo "bettertrack-backup: dumping ${DB_NAME} -> ${dest}"
if pg_dump "${pg_dump_args[@]}" | gzip > "${dest}.tmp"; then
    gzip -t "${dest}.tmp"
    mv "${dest}.tmp" "${dest}"
    artifact_size="$(stat -c %s "${dest}")"
    artifact_checksum="$(sha256sum "${dest}" | awk '{ print $1 }')"
    success_epoch="$(date -u +%s)"
    echo "bettertrack-backup: wrote $(du -h "${dest}" | cut -f1) -> ${dest}"
else
    echo "bettertrack-backup: pg_dump failed, discarding partial file" >&2
    exit 1
fi

echo "bettertrack-backup: pruning dumps older than ${RETENTION_DAYS}d"
find "${BACKUP_DIR}" -maxdepth 1 -name 'bettertrack-*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete
attempt_outcome='success'
