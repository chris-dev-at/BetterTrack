#!/usr/bin/env bash
# Docker health probe for local backup and restore-drill freshness.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_MAX_HOURS="${BT_BACKUP_FRESHNESS_MAX_HOURS:-26}"
RESTORE_MAX_DAYS="${BT_BACKUP_RESTORE_MAX_AGE_DAYS:-35}"
NOW_EPOCH="${BT_BACKUP_HEALTH_NOW_EPOCH:-$(date -u +%s)}"

# shellcheck source=infra/backup/status.sh
source "$(dirname "${BASH_SOURCE[0]}")/status.sh"

require_positive_integer() {
    local name value
    name="$1"
    value="$2"
    if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
        echo "bettertrack-backup-health: ${name} must be a positive integer" >&2
        exit 2
    fi
}

mark_stale() {
    local reason backup_age restore_age
    reason="$1"
    backup_age="${2:-unknown}"
    restore_age="${3:-unknown}"
    bt_status_update \
        "health_last_check_epoch=${NOW_EPOCH}" \
        'health_outcome=stale' \
        "health_reason=${reason}" \
        "health_backup_age_seconds=${backup_age}" \
        "health_restore_age_seconds=${restore_age}"
    echo "bettertrack-backup-health: stale (${reason})" >&2
    exit 1
}

require_positive_integer 'BT_BACKUP_FRESHNESS_MAX_HOURS' "${BACKUP_MAX_HOURS}"
require_positive_integer 'BT_BACKUP_RESTORE_MAX_AGE_DAYS' "${RESTORE_MAX_DAYS}"
require_positive_integer 'BT_BACKUP_HEALTH_NOW_EPOCH' "${NOW_EPOCH}"

last_success="$(bt_status_get last_success_epoch || true)"
artifact="$(bt_status_get last_artifact || true)"
artifact_size="$(bt_status_get last_artifact_bytes || true)"
artifact_checksum="$(bt_status_get last_artifact_sha256 || true)"
restore_success="$(bt_status_get restore_last_success_epoch || true)"

[[ "${last_success}" =~ ^[0-9]+$ ]] || mark_stale 'backup_missing'
[[ "${restore_success}" =~ ^[0-9]+$ ]] || mark_stale 'restore_missing'
[[ "${artifact_size}" =~ ^[1-9][0-9]*$ ]] || mark_stale 'artifact_size_missing'
[[ "${artifact_checksum}" =~ ^[0-9a-f]{64}$ ]] || mark_stale 'artifact_checksum_missing'
[[ "${artifact}" =~ ^bettertrack-[0-9]{8}-[0-9]{6}\.sql\.gz$ ]] ||
    mark_stale 'artifact_invalid'
[ -f "${BACKUP_DIR}/${artifact}" ] || mark_stale 'artifact_missing'

actual_size="$(stat -c %s "${BACKUP_DIR}/${artifact}")"
[ "${actual_size}" = "${artifact_size}" ] || mark_stale 'artifact_size_mismatch'

backup_age=$((NOW_EPOCH - last_success))
restore_age=$((NOW_EPOCH - restore_success))
[ "${backup_age}" -ge 0 ] || mark_stale 'backup_clock_skew' "${backup_age}" "${restore_age}"
[ "${restore_age}" -ge 0 ] || mark_stale 'restore_clock_skew' "${backup_age}" "${restore_age}"

backup_max_seconds=$((BACKUP_MAX_HOURS * 60 * 60))
restore_max_seconds=$((RESTORE_MAX_DAYS * 24 * 60 * 60))
[ "${backup_age}" -le "${backup_max_seconds}" ] ||
    mark_stale 'backup_too_old' "${backup_age}" "${restore_age}"
[ "${restore_age}" -le "${restore_max_seconds}" ] ||
    mark_stale 'restore_too_old' "${backup_age}" "${restore_age}"

bt_status_update \
    "health_last_check_epoch=${NOW_EPOCH}" \
    'health_outcome=healthy' \
    'health_reason=none' \
    "health_backup_age_seconds=${backup_age}" \
    "health_restore_age_seconds=${restore_age}"
echo "bettertrack-backup-health: healthy"
