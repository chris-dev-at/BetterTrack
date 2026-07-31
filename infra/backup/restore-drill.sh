#!/usr/bin/env bash
# Restores the most recent successful local dump into a disposable database,
# probes it, records an attestation, and removes the scratch database.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DB_HOST="${POSTGRES_HOST:-db}"
DB_PORT="${POSTGRES_PORT:-5432}"
DB_USER="${POSTGRES_USER:-bt}"
PRODUCTION_DB="${POSTGRES_DB:-bettertrack}"
ADMIN_DB="${BT_BACKUP_RESTORE_ADMIN_DATABASE:-postgres}"
SCRATCH_DB="${BT_BACKUP_RESTORE_DATABASE:-bettertrack_restore_drill}"
ATTESTATION_FILE="${BT_BACKUP_RESTORE_ATTESTATION_FILE:-${BACKUP_DIR}/restore-attestations.jsonl}"

# shellcheck source=infra/backup/status.sh
source "$(dirname "${BASH_SOURCE[0]}")/status.sh"

attempt_epoch="$(date -u +%s)"
outcome='failed'
artifact=''
checksum=''
connectivity_probe='not_run'
schema_probe='not_run'
cleanup_probe='not_run'
scratch_created=false

connection_args=(-h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}")

finalize() {
    local exit_code=$?
    local status_code attestation_outcome
    trap - EXIT

    if [ "${scratch_created}" = true ]; then
        if dropdb "${connection_args[@]}" --maintenance-db="${ADMIN_DB}" --if-exists "${SCRATCH_DB}"; then
            cleanup_probe='pass'
        else
            cleanup_probe='fail'
            exit_code=9
        fi
    fi

    if [ "${exit_code}" -eq 0 ]; then
        outcome='success'
    else
        outcome='failed'
    fi
    attestation_outcome="${outcome}"

    mkdir -p "$(dirname "${ATTESTATION_FILE}")"
    if ! printf \
        '{"schemaVersion":1,"attemptEpoch":%s,"outcome":"%s","artifact":"%s","checksum":"%s","probes":{"connectivity":"%s","schemaTables":"%s","scratchCleanup":"%s"}}\n' \
        "${attempt_epoch}" \
        "${attestation_outcome}" \
        "${artifact}" \
        "${checksum}" \
        "${connectivity_probe}" \
        "${schema_probe}" \
        "${cleanup_probe}" >> "${ATTESTATION_FILE}"; then
        exit_code=10
        outcome='failed'
    fi

    status_code=0
    if [ "${outcome}" = 'success' ]; then
        bt_status_update \
            "restore_last_attempt_epoch=${attempt_epoch}" \
            'restore_last_outcome=success' \
            "restore_last_success_epoch=${attempt_epoch}" \
            "restore_last_artifact=${artifact}" \
            "restore_last_artifact_sha256=${checksum}" \
            "restore_last_probes=connectivity:${connectivity_probe},schema_tables:${schema_probe},scratch_cleanup:${cleanup_probe}" ||
            status_code=$?
    else
        bt_status_update \
            "restore_last_attempt_epoch=${attempt_epoch}" \
            'restore_last_outcome=failed' \
            "restore_last_artifact=${artifact:-none}" \
            "restore_last_artifact_sha256=${checksum:-none}" \
            "restore_last_probes=connectivity:${connectivity_probe},schema_tables:${schema_probe},scratch_cleanup:${cleanup_probe}" ||
            status_code=$?
    fi
    [ "${status_code}" -eq 0 ] || exit_code=11
    exit "${exit_code}"
}
trap finalize EXIT

if [[ ! "${SCRATCH_DB}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] ||
    [[ ! "${ADMIN_DB}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]] ||
    [ "${SCRATCH_DB}" = "${PRODUCTION_DB}" ] ||
    [ "${ADMIN_DB}" = "${PRODUCTION_DB}" ] ||
    [ "${SCRATCH_DB}" = "${ADMIN_DB}" ] ||
    [ "${SCRATCH_DB}" = 'template0' ] ||
    [ "${SCRATCH_DB}" = 'template1' ]; then
    echo "bettertrack-restore-drill: scratch database name is unsafe" >&2
    exit 2
fi

artifact="$(bt_status_get last_artifact || true)"
checksum="$(bt_status_get last_artifact_sha256 || true)"
if [[ ! "${artifact}" =~ ^bettertrack-[0-9]{8}-[0-9]{6}\.sql\.gz$ ]] ||
    [ ! -f "${BACKUP_DIR}/${artifact}" ]; then
    echo "bettertrack-restore-drill: no successful local artifact is recorded" >&2
    exit 3
fi
if [[ ! "${checksum}" =~ ^[0-9a-f]{64}$ ]] ||
    [ "$(sha256sum "${BACKUP_DIR}/${artifact}" | awk '{ print $1 }')" != "${checksum}" ]; then
    echo "bettertrack-restore-drill: recorded artifact checksum does not match" >&2
    exit 4
fi

echo "bettertrack-restore-drill: recreating disposable database ${SCRATCH_DB}"
dropdb "${connection_args[@]}" --maintenance-db="${ADMIN_DB}" --if-exists "${SCRATCH_DB}"
createdb "${connection_args[@]}" --maintenance-db="${ADMIN_DB}" "${SCRATCH_DB}"
scratch_created=true

gzip -cd "${BACKUP_DIR}/${artifact}" |
    psql "${connection_args[@]}" -d "${SCRATCH_DB}" -v ON_ERROR_STOP=1 >/dev/null

connectivity="$(
    psql "${connection_args[@]}" -d "${SCRATCH_DB}" -v ON_ERROR_STOP=1 -Atq -c 'SELECT 1;'
)"
[ "${connectivity}" = '1' ] || {
    echo "bettertrack-restore-drill: connectivity probe failed" >&2
    exit 5
}
connectivity_probe='pass'

table_count="$(
    psql "${connection_args[@]}" -d "${SCRATCH_DB}" -v ON_ERROR_STOP=1 -Atq \
        -c "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';"
)"
[[ "${table_count}" =~ ^[1-9][0-9]*$ ]] || {
    echo "bettertrack-restore-drill: restored schema has no public tables" >&2
    exit 6
}
schema_probe='pass'

echo "bettertrack-restore-drill: probes passed for ${artifact}"
