import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adminBackupStatusResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';
import { readBackupStatus } from '../services/health/backupStatus';

const NOW = new Date('2026-08-20T10:00:00.000Z');
const NOW_EPOCH = Math.floor(NOW.getTime() / 1000);
const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** A healthy status file, exactly as `infra/backup/status.sh` writes it. */
function statusFile(overrides: Record<string, string | null> = {}): string {
  const base: Record<string, string> = {
    schema_version: '1',
    last_attempt_epoch: String(NOW_EPOCH - HOUR),
    last_attempt_outcome: 'success',
    last_success_epoch: String(NOW_EPOCH - HOUR),
    last_artifact: 'bettertrack-20260820-040000.sql.gz',
    last_artifact_bytes: '4194304',
    last_artifact_sha256: 'a'.repeat(64),
    restore_last_attempt_epoch: String(NOW_EPOCH - 5 * DAY),
    restore_last_outcome: 'success',
    restore_last_success_epoch: String(NOW_EPOCH - 5 * DAY),
    offsite_outcome: 'success',
    offsite_uploaded_count: '3',
    health_last_check_epoch: String(NOW_EPOCH - 60),
    health_outcome: 'healthy',
    health_reason: 'none',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete base[key];
    else base[key] = value;
  }
  return `${Object.entries(base)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
}

describe('backup status reader', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bt-backup-status-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const write = async (contents: string): Promise<string> => {
    const path = join(directory, 'backup-status.env');
    await writeFile(path, contents, 'utf8');
    return path;
  };

  it('reports "not configured" without an env-configured path, and never throws', async () => {
    for (const path of [undefined, '', '   ']) {
      const status = await readBackupStatus(path, NOW);
      expect(status.configured).toBe(false);
      expect(status.level).toBe('unknown');
      expect(status.reason).toBe('not_configured');
      // The documented thresholds ride along even when nothing is wired, so the
      // tile can explain what it would be measuring.
      expect(status.backup.maxAgeSeconds).toBe(26 * HOUR);
      expect(status.restore.maxAgeSeconds).toBe(35 * DAY);
    }
  });

  it('degrades to "unreadable" for a missing file instead of throwing', async () => {
    const status = await readBackupStatus(join(directory, 'nope.env'), NOW);
    expect(status.configured).toBe(false);
    expect(status.reason).toBe('unreadable');
  });

  it('projects a healthy status file', async () => {
    const status = await readBackupStatus(await write(statusFile()), NOW);

    expect(status.configured).toBe(true);
    expect(status.level).toBe('ok');
    expect(status.reason).toBe('healthy');
    expect(status.backup.ageSeconds).toBe(HOUR);
    expect(status.backup.lastSuccessAt).toBe('2026-08-20T09:00:00.000Z');
    expect(status.backup.artifactBytes).toBe(4194304);
    expect(status.restore.ageSeconds).toBe(5 * DAY);
    expect(status.offsite).toEqual({ outcome: 'success', uploadedCount: 3 });
    expect(status.scheduler.outcome).toBe('healthy');
  });

  it('never echoes the artifact name, checksum or any unknown key', async () => {
    const status = await readBackupStatus(
      await write(`${statusFile()}rclone_remote=s3:secret-bucket\n`),
      NOW,
    );

    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('bettertrack-20260820-040000.sql.gz');
    expect(serialized).not.toContain('a'.repeat(64));
    expect(serialized).not.toContain('secret-bucket');
  });

  it('calls a stale or missing dump critical — there is no recent recovery point', async () => {
    const stale = await readBackupStatus(
      await write(statusFile({ last_success_epoch: String(NOW_EPOCH - 27 * HOUR) })),
      NOW,
    );
    expect(stale.level).toBe('critical');
    expect(stale.reason).toBe('backup_stale');

    const missing = await readBackupStatus(
      await write(statusFile({ last_success_epoch: null })),
      NOW,
    );
    expect(missing.level).toBe('critical');
    expect(missing.reason).toBe('backup_missing');
  });

  it('calls a stale or missing restore drill a warning — recovery is unproven, not lost', async () => {
    const stale = await readBackupStatus(
      await write(statusFile({ restore_last_success_epoch: String(NOW_EPOCH - 36 * DAY) })),
      NOW,
    );
    expect(stale.level).toBe('warn');
    expect(stale.reason).toBe('restore_stale');

    const missing = await readBackupStatus(
      await write(statusFile({ restore_last_success_epoch: null })),
      NOW,
    );
    expect(missing.level).toBe('warn');
    expect(missing.reason).toBe('restore_missing');
  });

  it("lets the scheduler's own verdict override fresh-looking timestamps", async () => {
    const status = await readBackupStatus(
      await write(statusFile({ health_outcome: 'stale', health_reason: 'backup_too_old' })),
      NOW,
    );
    expect(status.level).toBe('critical');
    expect(status.reason).toBe('scheduler_unhealthy');
  });

  it('flags a failed offsite upload without downgrading the local recovery point', async () => {
    const status = await readBackupStatus(
      await write(statusFile({ offsite_outcome: 'failed' })),
      NOW,
    );
    expect(status.level).toBe('warn');
    expect(status.reason).toBe('offsite_failed');
    expect(status.backup.ageSeconds).toBe(HOUR);
  });

  it('rejects a wrong schema version and refuses malformed values', async () => {
    const wrongVersion = await readBackupStatus(
      await write(statusFile({ schema_version: '2' })),
      NOW,
    );
    expect(wrongVersion.configured).toBe(false);
    expect(wrongVersion.reason).toBe('unreadable');

    // Non-numeric epochs and shell-ish tags are dropped, not trusted.
    const garbage = await readBackupStatus(
      await write(
        statusFile({
          last_success_epoch: '$(rm -rf /)',
          restore_last_outcome: 'success; echo pwned',
        }),
      ),
      NOW,
    );
    expect(garbage.reason).toBe('backup_missing');
    expect(garbage.restore.lastOutcome).toBeNull();
  });

  it('refuses an implausibly large status file rather than reading it', async () => {
    const status = await readBackupStatus(
      await write(`schema_version=1\n${'x'.repeat(70_000)}`),
      NOW,
    );
    expect(status.configured).toBe(false);
    expect(status.reason).toBe('unreadable');
  });

  it('clamps a future timestamp to a zero age instead of a negative one', async () => {
    const status = await readBackupStatus(
      await write(statusFile({ last_success_epoch: String(NOW_EPOCH + 5 * HOUR) })),
      NOW,
    );
    expect(status.backup.ageSeconds).toBe(0);
    expect(status.level).toBe('ok');
  });
});

describe('GET /admin/ops/backup-status', () => {
  let harness: TestHarness;
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'bt-backup-route-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('answers 200 with an unconfigured payload when no status file is wired', async () => {
    harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const res = await agent.get('/api/v1/admin/ops/backup-status');
    expect(res.status).toBe(200);

    const body = adminBackupStatusResponseSchema.parse(res.body);
    expect(body.configured).toBe(false);
    expect(body.level).toBe('unknown');
  });

  it('serves the projected readiness for an authenticated admin', async () => {
    const path = join(directory, 'backup-status.env');
    await writeFile(path, statusFile(), 'utf8');
    harness = await createTestApp({ env: { BT_BACKUP_STATUS_FILE: path } });
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const res = await agent.get('/api/v1/admin/ops/backup-status');
    expect(res.status).toBe(200);

    const body = adminBackupStatusResponseSchema.parse(res.body);
    expect(body.configured).toBe(true);
    expect(body.backup.lastSuccessAt).toBe('2026-08-20T09:00:00.000Z');
    expect(body.restore.lastOutcome).toBe('success');
  });

  it('404s for anonymous and user-kind callers (no leak), not for admins', async () => {
    harness = await createTestApp();

    // Anonymous → 404 (requireAdmin, §6.12 no information leak).
    const anon = await request(harness.app).get('/api/v1/admin/ops/backup-status');
    expect(anon.status).toBe(404);

    // A normal user session → 404 too: the admin boundary never answers 403.
    const user = await harness.seedUser({ email: 'plain@test.dev', username: 'plain_user' });
    const userAgent = request.agent(harness.app);
    const userLogin = await userAgent
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .send({ identifier: user.email, password: user.password });
    expect(userLogin.status).toBe(200);
    expect((await userAgent.get('/api/v1/admin/ops/backup-status')).status).toBe(404);

    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    expect((await adminAgent.get('/api/v1/admin/ops/backup-status')).status).toBe(200);
  });

  it('403s an admin who has not completed the mandatory 2FA enrollment', async () => {
    harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = request.agent(harness.app);
    const login = await agent
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .send({ identifier: admin.email, password: admin.password });
    expect(login.status).toBe(200);

    // Same gate every sibling admin route carries: a session that predates 2FA
    // enrollment reaches the mount but not the data.
    const res = await agent.get('/api/v1/admin/ops/backup-status');
    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('ADMIN_2FA_SETUP_REQUIRED');
  });
});
