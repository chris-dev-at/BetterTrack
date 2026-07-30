import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const backupDir = path.join(repoRoot, 'infra/backup');
const temporaryRoots: string[] = [];

interface Fixture {
  root: string;
  bin: string;
  backups: string;
  status: string;
  env: NodeJS.ProcessEnv;
}

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'bettertrack-backup-'));
  const bin = path.join(root, 'bin');
  const backups = path.join(root, 'backups');
  const status = path.join(backups, 'backup-status.env');
  mkdirSync(bin);
  mkdirSync(backups);
  temporaryRoots.push(root);
  return {
    root,
    bin,
    backups,
    status,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      BACKUP_DIR: backups,
      BT_BACKUP_SOURCE_DIR: backups,
      BT_BACKUP_STATUS_FILE: status,
      POSTGRES_DB: 'bettertrack',
      POSTGRES_USER: 'bt',
    },
  };
}

function executable(directory: string, name: string, source: string): string {
  const target = path.join(directory, name);
  writeFileSync(target, `#!/bin/sh\nset -eu\n${source}`);
  chmodSync(target, 0o755);
  return target;
}

function run(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [path.join(backupDir, script)], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
    maxBuffer: 1024 * 1024,
  });
}

function statusValues(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

function writeStatus(file: string, values: Record<string, string | number>): void {
  writeFileSync(
    file,
    ['schema_version=1', ...Object.entries(values).map(([key, value]) => `${key}=${value}`)].join(
      '\n',
    ) + '\n',
  );
}

function installOffsiteStubs(target: Fixture): string {
  const log = path.join(target.root, 'rclone.log');
  writeFileSync(log, '');
  executable(
    target.bin,
    'age',
    `
output=''
input=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -R) shift 2 ;;
    -o) output="$2"; shift 2 ;;
    *) input="$1"; shift ;;
  esac
done
cp "$input" "$output"
`,
  );
  executable(
    target.bin,
    'rclone',
    `
printf '%s\\n' "$*" >> "$RCLONE_LOG"
if [ "\${1:-}" = '--config' ]; then shift 2; fi
case "\${1:-}" in
  lsf)
    if [ -n "\${RCLONE_LISTING:-}" ] && [ -f "$RCLONE_LISTING" ]; then
      cat "$RCLONE_LISTING"
    fi
    ;;
esac
`,
  );
  return log;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('backup deployment topology', () => {
  const compose = read('infra/docker-compose.yml');
  const offsiteCompose = read('infra/docker-compose.offsite.yml');
  const dockerfile = read('infra/backup/Dockerfile');
  const schedulerBlock = compose.slice(
    compose.indexOf('\n  backup-scheduler:'),
    compose.indexOf('\n  db:'),
  );
  const uploadBlock = offsiteCompose.slice(
    offsiteCompose.indexOf('\n  backup-offsite:'),
    offsiteCompose.indexOf('\n  backup-offsite-retention:'),
  );
  const retentionBlock = offsiteCompose.slice(
    offsiteCompose.indexOf('\n  backup-offsite-retention:'),
    offsiteCompose.indexOf('\nvolumes:'),
  );

  it('ships the scheduler, status healthcheck, and shared backup volume in the base stack', () => {
    expect(schedulerBlock).toContain('context: ./backup');
    expect(schedulerBlock).toContain("'/opt/bettertrack/scheduler.sh'");
    expect(schedulerBlock).toContain("test: ['CMD', '/opt/bettertrack/healthcheck.sh']");
    expect(schedulerBlock).toContain('BT_BACKUP_CRON');
    expect(schedulerBlock).toContain('BT_BACKUP_FRESHNESS_MAX_HOURS');
    expect(schedulerBlock).toContain('BT_BACKUP_RESTORE_MAX_AGE_DAYS');
    expect(schedulerBlock).toContain('pgbackups:/backups');
    expect(schedulerBlock).toContain('condition: service_healthy');
  });

  it('builds every backup script on a digest-pinned utility image', () => {
    expect(dockerfile).toMatch(/^FROM [^\n]+@sha256:[0-9a-f]{64}$/m);
    for (const script of [
      'backup.sh',
      'healthcheck.sh',
      'offsite.sh',
      'restore-drill.sh',
      'scheduler.sh',
      'status.sh',
    ]) {
      expect(dockerfile).toContain(script);
    }
  });

  it('keeps upload and explicitly enabled retention in separately credentialed services', () => {
    expect(uploadBlock).toContain("profiles: ['offsite']");
    expect(uploadBlock).toContain("BT_BACKUP_OFFSITE_MODE: 'upload'");
    expect(uploadBlock).toContain('upload-rclone.conf');
    expect(uploadBlock).not.toContain('retention-rclone.conf');
    expect(retentionBlock).toContain("profiles: ['offsite-retention']");
    expect(retentionBlock).toContain("BT_BACKUP_OFFSITE_MODE: 'retention'");
    expect(retentionBlock).toContain('BT_BACKUP_REMOTE_RETENTION_ENABLED');
    expect(retentionBlock).toContain('retention-rclone.conf');
    expect(retentionBlock).not.toContain('upload-rclone.conf');
    expect(uploadBlock).toContain('pgbackups:/backups');
    expect(retentionBlock).toContain('pgbackups:/backups');
  });
});

describe('local backup status and freshness', () => {
  it('creates a verified dump and reports healthy from fresh status timestamps', () => {
    const target = fixture();
    executable(target.bin, 'pg_dump', "printf '%s\\n' 'CREATE TABLE probe(id integer);'");

    const backup = run('backup.sh', target.env);
    expect(backup.status, backup.stderr).toBe(0);

    const firstStatus = statusValues(target.status);
    expect(firstStatus).toMatchObject({
      schema_version: '1',
      last_attempt_outcome: 'success',
      offsite_outcome: 'not_attempted',
      offsite_retention: 'manual_or_provider',
    });
    expect(firstStatus.last_artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(firstStatus.last_artifact_bytes)).toBeGreaterThan(0);
    expect(readFileSync(path.join(target.backups, firstStatus.last_artifact!))).toBeTruthy();

    writeFileSync(
      target.status,
      `${readFileSync(target.status, 'utf8')}restore_last_success_epoch=${firstStatus.last_success_epoch}\n`,
    );
    const health = run('healthcheck.sh', {
      ...target.env,
      BT_BACKUP_HEALTH_NOW_EPOCH: String(Number(firstStatus.last_success_epoch) + 60 * 60),
    });
    expect(health.status, health.stderr).toBe(0);
    expect(statusValues(target.status)).toMatchObject({
      health_outcome: 'healthy',
      health_reason: 'none',
      health_backup_age_seconds: '3600',
      health_restore_age_seconds: '3600',
    });
  });

  it('records a failed attempt without inventing a successful artifact', () => {
    const target = fixture();
    executable(target.bin, 'pg_dump', 'exit 12');

    const backup = run('backup.sh', target.env);
    expect(backup.status).not.toBe(0);
    expect(statusValues(target.status)).toMatchObject({
      schema_version: '1',
      last_attempt_outcome: 'failed',
    });
    expect(statusValues(target.status).last_success_epoch).toBeUndefined();
  });

  it('returns stale and records the reason when no successful dump exists', () => {
    const target = fixture();
    const health = run('healthcheck.sh', {
      ...target.env,
      BT_BACKUP_HEALTH_NOW_EPOCH: '2000000000',
    });

    expect(health.status).not.toBe(0);
    expect(statusValues(target.status)).toMatchObject({
      health_outcome: 'stale',
      health_reason: 'backup_missing',
    });
  });

  it('returns stale from fixture timestamps when the newest success exceeds the window', () => {
    const target = fixture();
    const now = 2_000_000_000;
    const artifact = 'bettertrack-20200101-000000.sql.gz';
    writeFileSync(path.join(target.backups, artifact), 'x');
    writeStatus(target.status, {
      last_success_epoch: now - 27 * 60 * 60,
      last_artifact: artifact,
      last_artifact_bytes: 1,
      last_artifact_sha256: 'a'.repeat(64),
      restore_last_success_epoch: now,
    });

    const health = run('healthcheck.sh', {
      ...target.env,
      BT_BACKUP_HEALTH_NOW_EPOCH: String(now),
      BT_BACKUP_FRESHNESS_MAX_HOURS: '26',
    });
    expect(health.status).not.toBe(0);
    expect(statusValues(target.status)).toMatchObject({
      health_outcome: 'stale',
      health_reason: 'backup_too_old',
      health_backup_age_seconds: String(27 * 60 * 60),
    });
  });

  it('returns stale when restore evidence exceeds its independent window', () => {
    const target = fixture();
    const now = 2_000_000_000;
    const artifact = 'bettertrack-20200101-000000.sql.gz';
    writeFileSync(path.join(target.backups, artifact), 'x');
    writeStatus(target.status, {
      last_success_epoch: now,
      last_artifact: artifact,
      last_artifact_bytes: 1,
      last_artifact_sha256: 'a'.repeat(64),
      restore_last_success_epoch: now - 36 * 24 * 60 * 60,
    });

    const health = run('healthcheck.sh', {
      ...target.env,
      BT_BACKUP_HEALTH_NOW_EPOCH: String(now),
      BT_BACKUP_RESTORE_MAX_AGE_DAYS: '35',
    });
    expect(health.status).not.toBe(0);
    expect(statusValues(target.status)).toMatchObject({
      health_outcome: 'stale',
      health_reason: 'restore_too_old',
      health_restore_age_seconds: String(36 * 24 * 60 * 60),
    });
  });
});

describe('offsite upload and retention credentials', () => {
  it('uploads every missing local artifact and never invokes delete in upload mode', () => {
    const target = fixture();
    const log = installOffsiteStubs(target);
    const recipient = path.join(target.root, 'recipient');
    const uploadConfig = path.join(target.root, 'upload-rclone.conf');
    writeFileSync(recipient, 'age1test\n');
    writeFileSync(uploadConfig, '[remote]\n');
    writeFileSync(path.join(target.backups, 'bettertrack-20260101-030000.sql.gz'), 'one');
    writeFileSync(path.join(target.backups, 'bettertrack-20260102-030000.sql.gz'), 'two');

    const result = run('offsite.sh', {
      ...target.env,
      RCLONE_LOG: log,
      BT_BACKUP_AGE_RECIPIENT_FILE: recipient,
      BT_BACKUP_UPLOAD_RCLONE_CONFIG: uploadConfig,
      BT_BACKUP_RCLONE_REMOTE: 'upload:bettertrack',
    });
    expect(result.status, result.stderr).toBe(0);

    const invocations = readFileSync(log, 'utf8');
    expect(invocations.match(/\bcopy\b/g)).toHaveLength(2);
    expect(invocations).not.toMatch(/\bdelete\b/);
    expect(statusValues(target.status)).toMatchObject({
      offsite_outcome: 'success',
      offsite_uploaded_count: '2',
      offsite_retention: 'manual_or_provider',
    });
  });

  it('fails and records the outcome for an explicitly configured unreadable recipient', () => {
    const target = fixture();
    const log = installOffsiteStubs(target);
    const uploadConfig = path.join(target.root, 'upload-rclone.conf');
    writeFileSync(uploadConfig, '[remote]\n');

    const result = run('offsite.sh', {
      ...target.env,
      RCLONE_LOG: log,
      BT_BACKUP_AGE_RECIPIENT_FILE: path.join(target.root, 'missing-recipient'),
      BT_BACKUP_UPLOAD_RCLONE_CONFIG: uploadConfig,
      BT_BACKUP_RCLONE_REMOTE: 'upload:bettertrack',
    });
    expect(result.status).not.toBe(0);
    expect(statusValues(target.status).offsite_outcome).toBe('failed');
  });

  it('does not invoke delete when the separate retention step is disabled', () => {
    const target = fixture();
    const log = installOffsiteStubs(target);
    const result = run('offsite.sh', {
      ...target.env,
      RCLONE_LOG: log,
      BT_BACKUP_OFFSITE_MODE: 'retention',
      BT_BACKUP_REMOTE_RETENTION_ENABLED: 'false',
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(log, 'utf8')).not.toMatch(/\bdelete\b/);
    expect(statusValues(target.status).offsite_retention_outcome).toBe('disabled');
  });

  it('deletes only through the retention credential when explicitly enabled', () => {
    const target = fixture();
    const log = installOffsiteStubs(target);
    const retentionConfig = path.join(target.root, 'retention-rclone.conf');
    writeFileSync(retentionConfig, '[retention]\n');

    const result = run('offsite.sh', {
      ...target.env,
      RCLONE_LOG: log,
      BT_BACKUP_OFFSITE_MODE: 'retention',
      BT_BACKUP_REMOTE_RETENTION_ENABLED: 'true',
      BT_BACKUP_RETENTION_RCLONE_CONFIG: retentionConfig,
      BT_BACKUP_RETENTION_RCLONE_REMOTE: 'retention:bettertrack',
    });
    expect(result.status, result.stderr).toBe(0);

    const invocations = readFileSync(log, 'utf8');
    expect(invocations).toContain(
      `--config ${retentionConfig} delete retention:bettertrack --min-age 30d`,
    );
    expect(invocations).not.toMatch(/\b(copy|mkdir|lsf)\b/);
    expect(statusValues(target.status).offsite_retention_outcome).toBe('success');
  });
});

describe('restore drill', () => {
  it('restores and probes only a scratch database, then appends an attestation', () => {
    const target = fixture();
    const artifact = 'bettertrack-20260102-030000.sql.gz';
    const compressed = gzipSync('CREATE TABLE probe(id integer);\n');
    const checksum = createHash('sha256').update(compressed).digest('hex');
    const commandLog = path.join(target.root, 'database-commands.log');
    writeFileSync(path.join(target.backups, artifact), compressed);
    writeStatus(target.status, {
      last_success_epoch: 2_000_000_000,
      last_artifact: artifact,
      last_artifact_bytes: compressed.byteLength,
      last_artifact_sha256: checksum,
    });

    for (const command of ['createdb', 'dropdb']) {
      executable(target.bin, command, `printf '${command} %s\\n' "$*" >> "$DB_COMMAND_LOG"`);
    }
    executable(
      target.bin,
      'psql',
      `
printf 'psql %s\\n' "$*" >> "$DB_COMMAND_LOG"
case "$*" in
  *information_schema.tables*) printf '7\\n' ;;
  *'SELECT 1;'*) printf '1\\n' ;;
  *) cat >/dev/null ;;
esac
`,
    );

    const result = run('restore-drill.sh', {
      ...target.env,
      DB_COMMAND_LOG: commandLog,
      POSTGRES_DB: 'production_live',
      BT_BACKUP_RESTORE_DATABASE: 'bettertrack_restore_drill',
      BT_BACKUP_RESTORE_ATTESTATION_FILE: path.join(target.backups, 'restore-attestations.jsonl'),
    });
    expect(result.status, result.stderr).toBe(0);

    const commands = readFileSync(commandLog, 'utf8');
    expect(commands).toContain('createdb ');
    expect(commands).toContain('-d bettertrack_restore_drill');
    expect(commands).not.toContain('production_live');
    expect(commands.match(/^dropdb /gm)).toHaveLength(2);
    expect(statusValues(target.status)).toMatchObject({
      restore_last_outcome: 'success',
      restore_last_artifact: artifact,
      restore_last_artifact_sha256: checksum,
      restore_last_probes: 'connectivity:pass,schema_tables:pass,scratch_cleanup:pass',
    });

    const attestation = JSON.parse(
      readFileSync(path.join(target.backups, 'restore-attestations.jsonl'), 'utf8').trim(),
    ) as {
      outcome: string;
      artifact: string;
      checksum: string;
      probes: Record<string, string>;
    };
    expect(attestation).toMatchObject({
      outcome: 'success',
      artifact,
      checksum,
      probes: {
        connectivity: 'pass',
        schemaTables: 'pass',
        scratchCleanup: 'pass',
      },
    });
  });
});
