#!/usr/bin/env bash
# Runs one backup on container start, then hands the configured schedule to
# Alpine's cron daemon. The immediate run gives a fresh deployment its first
# local recovery point without waiting until the next 03:00 window.
set -euo pipefail

schedule="${BT_BACKUP_CRON:-0 3 * * *}"
cron_file='/etc/crontabs/root'

if [[ ! "${schedule}" =~ ^[0-9*/,\ -]+$ ]] ||
    [ "$(awk '{ print NF }' <<< "${schedule}")" -ne 5 ]; then
    echo "bettertrack-backup-scheduler: BT_BACKUP_CRON must be a five-field numeric cron expression" >&2
    exit 2
fi

umask 027
printf '%s %s\n' \
    "${schedule}" \
    '/opt/bettertrack/backup.sh >>/proc/1/fd/1 2>>/proc/1/fd/2' > "${cron_file}"

echo "bettertrack-backup-scheduler: installed schedule ${schedule}"
if ! /opt/bettertrack/backup.sh; then
    echo "bettertrack-backup-scheduler: initial backup failed; cron will retry and health stays stale" >&2
fi

exec crond -f -l 8 -L /dev/stdout
