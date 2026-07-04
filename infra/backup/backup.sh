#!/bin/bash
# BetterTrack nightly backup script (PROJECTPLAN.md §10, §4.6).
#
# Bind-mounted read-only into the `db` service at /opt/bettertrack/backup.sh
# (infra/docker-compose.yml) and triggered by host cron:
#
#   0 3 * * * cd /path/to/infra && docker compose exec -T db bash /opt/bettertrack/backup.sh >> /var/log/bettertrack-backup.log 2>&1
#
# Runs *inside* the db container so it can write straight into the `pgbackups`
# volume already mounted there at /backups — no extra compose service needed,
# keeping the five-service topology (§4.6) intact. Takes a gzip'd `pg_dump`,
# verifies the archive, then prunes dumps older than BACKUP_RETENTION_DAYS.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DB_NAME="${POSTGRES_DB:-bettertrack}"
DB_USER="${POSTGRES_USER:-bt}"

ts="$(date -u +%Y%m%d-%H%M%S)"
dest="${BACKUP_DIR}/bettertrack-${ts}.sql.gz"

echo "bettertrack-backup: dumping ${DB_NAME} -> ${dest}"
if pg_dump -U "${DB_USER}" -d "${DB_NAME}" --clean --if-exists --no-owner | gzip > "${dest}.tmp"; then
    gzip -t "${dest}.tmp"
    mv "${dest}.tmp" "${dest}"
    echo "bettertrack-backup: wrote $(du -h "${dest}" | cut -f1) -> ${dest}"
else
    echo "bettertrack-backup: pg_dump failed, discarding partial file" >&2
    rm -f "${dest}.tmp"
    exit 1
fi

echo "bettertrack-backup: pruning dumps older than ${RETENTION_DAYS}d"
find "${BACKUP_DIR}" -maxdepth 1 -name 'bettertrack-*.sql.gz' -mtime "+${RETENTION_DAYS}" -print -delete
