#!/usr/bin/env bash
# Runs one backup and restore drill on container start, then hands both
# configured schedules to Alpine's cron daemon. The immediate run gives a fresh
# deployment its first local recovery point and restore evidence without owner
# setup or waiting for the next cron window.
set -euo pipefail

backup_schedule="${BT_BACKUP_CRON:-0 3 * * *}"
restore_schedule="${BT_BACKUP_RESTORE_CRON:-0 4 1 * *}"
cron_file='/etc/crontabs/root'

require_cron_schedule() {
    local name="$1"
    local schedule="$2"
    if [[ ! "${schedule}" =~ ^[0-9*/,\ -]+$ ]] ||
        [ "$(awk '{ print NF }' <<< "${schedule}")" -ne 5 ]; then
        echo "bettertrack-backup-scheduler: ${name} must be a five-field numeric cron expression" >&2
        exit 2
    fi
}

require_cron_schedule 'BT_BACKUP_CRON' "${backup_schedule}"
require_cron_schedule 'BT_BACKUP_RESTORE_CRON' "${restore_schedule}"

umask 027
{
    printf '%s %s\n' \
        "${backup_schedule}" \
        '/opt/bettertrack/backup.sh >>/proc/1/fd/1 2>>/proc/1/fd/2'
    printf '%s %s\n' \
        "${restore_schedule}" \
        '/opt/bettertrack/restore-drill.sh >>/proc/1/fd/1 2>>/proc/1/fd/2'
} > "${cron_file}"

echo "bettertrack-backup-scheduler: installed backup schedule ${backup_schedule}"
echo "bettertrack-backup-scheduler: installed restore-drill schedule ${restore_schedule}"
if /opt/bettertrack/backup.sh; then
    if ! /opt/bettertrack/restore-drill.sh; then
        echo "bettertrack-backup-scheduler: initial restore drill failed; cron will retry and health stays stale" >&2
    fi
else
    echo "bettertrack-backup-scheduler: initial backup failed; cron will retry and health stays stale" >&2
fi

exec crond -f -l 8 -L /dev/stdout
