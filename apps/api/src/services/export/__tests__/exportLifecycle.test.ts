import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import type { Application } from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXPORT_PENDING_STALE_MS,
  exportRequestResponseSchema,
  exportStatusResponseSchema,
} from '@bettertrack/contracts';

import * as schema from '../../../data/schema';
import { createExportRepository } from '../../../data/repositories/exportRepository';
import { createUserRepository } from '../../../data/repositories/userRepository';
import type { AuditService } from '../../audit/auditService';
import type { TwoFactorService } from '../../auth/twoFactorService';
import type { PasswordHasher } from '../../password/passwordHasher';
import { hashToken } from '../../crypto/tokens';
import { createExportService, type ExportService, type ExportServiceDeps } from '../exportService';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * Export ARTIFACT lifecycle (#1714). A finished export zip is a full cleartext
 * copy of an account, so the invariant under test is blunt: no zip and no
 * `.building` temp file may ever outlive the row that points at it, on any path
 * — a failure after the rename, a killed process, a deleted account — and the
 * build must refuse an over-ceiling account cleanly instead of OOM-ing the
 * worker. The token semantics themselves are covered by `exportFlow.test.ts`.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
// A directory of this file's own, so a planted orphan can never be another
// suite's live artifact (and vice versa).
const EXPORT_DIR = joinPath(tmpdir(), 'bettertrack-test-export-lifecycle');

let harness: TestHarness;

beforeEach(async () => {
  await rm(EXPORT_DIR, { recursive: true, force: true });
  await mkdir(EXPORT_DIR, { recursive: true, mode: 0o700 });
  harness = await createTestApp({ env: { BT_EXPORT_DIR: EXPORT_DIR } });
});

afterEach(async () => {
  await rm(EXPORT_DIR, { recursive: true, force: true });
});

type Agent = ReturnType<typeof request.agent>;

async function loginAgent(app: Application, identifier: string, password: string): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

/** Request an export through the real HTTP flow (the build runs synchronously). */
async function requestExport(
  agent: Agent,
  password: string,
): Promise<{ jobId: string; downloadToken: string }> {
  const res = await agent
    .post('/api/v1/account/export')
    .set(...XRW)
    .send({ password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const { jobId, downloadToken } = exportRequestResponseSchema.parse(res.body);
  return { jobId, downloadToken };
}

/**
 * An export service over the real database whose collaborators can be sabotaged
 * per test. Only the build/download paths are exercised, so the re-auth
 * collaborators are never reached and stay unbuilt.
 */
function buildService(overrides: Partial<ExportServiceDeps>): ExportService {
  return createExportService({
    config: harness.ctx.config,
    db: harness.db,
    redis: harness.ctx.redis,
    exportRepo: createExportRepository(harness.db),
    userRepo: createUserRepository(harness.db),
    passwordHasher: undefined as unknown as PasswordHasher,
    twoFactor: undefined as unknown as TwoFactorService,
    audit: undefined as unknown as AuditService,
    notify: { emit: async () => true },
    enqueueBuild: async () => undefined,
    withAccountTransitionLock: (_userId, run) => run(),
    ...overrides,
  });
}

/** Reserve a job row directly (no re-auth) and return its id + raw token. */
async function reserveJob(userId: string): Promise<{ jobId: string; token: string }> {
  const repo = createExportRepository(harness.db);
  const token = `test-token-${userId}`;
  const reservation = await repo.reserveWithinRateLimit({
    userId,
    downloadTokenHash: hashToken(token),
    since: new Date(Date.now() - 60_000),
    stalePendingBefore: new Date(Date.now() - EXPORT_PENDING_STALE_MS),
  });
  expect(reservation.kind).toBe('created');
  if (reservation.kind !== 'created') throw new Error('unreachable');
  return { jobId: reservation.job.id, token };
}

// TEST VECTOR: one server-backed per-vault config and its current document.
const VAULT_VECTOR = {
  vaultId: '00000000-0000-7000-8000-0000000009a1',
  headerDocId: '00000000-0000-7000-8000-0000000009a2',
  commonDocId: '00000000-0000-7000-8000-0000000009a3',
} as const;

/**
 * A server-media vault with current documents. `declaredSize` defaults to the
 * real byte length; a test that must prove the ceiling is consulted BEFORE the
 * bytes are read sets it to something the stored blob is not.
 */
async function seedServerVault(
  userId: string,
  vaultId: string,
  docs: { docId: string; docKind: 'header' | 'common'; bytes: number; declaredSize?: number }[],
): Promise<void> {
  await harness.db.insert(schema.vaults).values({
    id: vaultId,
    userId,
    name: 'TEST VECTOR export vault',
    headerDocId: VAULT_VECTOR.headerDocId,
    commonDocId: VAULT_VECTOR.commonDocId,
    media: ['server'],
    driveConnectionId: null,
    retirementProofPublicKey: 'TEST VECTOR export vault proof key',
    keyFingerprint: 'TEST VECTOR export vault fingerprint',
  });
  for (const doc of docs) {
    await harness.db.insert(schema.vaultBlobs).values({
      vaultId,
      docId: doc.docId,
      docKind: doc.docKind,
      version: 1,
      formatVersion: 1,
      sizeBytes: doc.declaredSize ?? doc.bytes,
      blob: Buffer.alloc(doc.bytes, 7),
    });
  }
}

async function jobRow(jobId: string) {
  const [row] = await harness.db
    .select()
    .from(schema.exportJobs)
    .where(eq(schema.exportJobs.id, jobId));
  return row ?? null;
}

describe('export artifact lifecycle', () => {
  it('leaves nothing on disk when the build fails after the rename', async () => {
    // The finished zip is already at its final path when `markReady` throws, and
    // the row it would have been reachable through never records the pointer —
    // so the archive must be removed here or nothing can ever reap it.
    const user = await harness.seedUser();
    const repo = createExportRepository(harness.db);
    const service = buildService({
      exportRepo: {
        ...repo,
        markReady: async () => {
          throw new Error('markReady exploded');
        },
      },
    });
    const { jobId } = await reserveJob(user.id);

    await expect(service.buildExport(jobId)).rejects.toThrow('markReady exploded');

    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip`))).toBe(false);
    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip.building`))).toBe(false);
    expect(await jobRow(jobId)).toMatchObject({ status: 'failed', filePath: null });
  });

  it('keeps a ready export downloadable when the ready notification fails', async () => {
    // The archive exists, the row is ready and the token is live: rolling the job
    // back to `failed` would 404 that token forever (consumption requires
    // `status = ready`). The notice is best-effort, the build is not.
    const user = await harness.seedUser();
    const service = buildService({
      notify: {
        emit: async () => {
          throw new Error('notification transport down');
        },
      },
    });
    const { jobId, token } = await reserveJob(user.id);

    await expect(service.buildExport(jobId)).resolves.toBeUndefined();

    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: 'ready' });
    expect(existsSync(row!.filePath!)).toBe(true);
    // The state is internally consistent: the live token still resolves.
    const download = await service.resolveDownload({ userId: user.id, token });
    expect(download.filePath).toBe(row!.filePath);
  });

  it('sweeps orphaned artifacts without touching live or in-flight ones', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { jobId } = await requestExport(agent, user.password);
    const live = (await jobRow(jobId))!.filePath!;

    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    // A partial archive a SIGKILL left behind mid-build, and a finished archive
    // whose row is gone (the account-deletion cascade, a failed reap).
    const killedTemp = joinPath(EXPORT_DIR, '00000000-0000-7000-8000-0000000000aa.zip.building');
    const orphanZip = joinPath(EXPORT_DIR, '00000000-0000-7000-8000-0000000000bb.zip');
    // A build in flight right now: young, so never a candidate.
    const inFlight = joinPath(EXPORT_DIR, '00000000-0000-7000-8000-0000000000cc.zip.building');
    await writeFile(killedTemp, 'partial cleartext');
    await writeFile(orphanZip, 'orphaned cleartext');
    await writeFile(inFlight, 'in flight');
    await utimes(killedTemp, stale, stale);
    await utimes(orphanZip, stale, stale);
    // Age the live artifact too: it must survive because a ROW points at it, not
    // merely because it is young.
    await utimes(live, stale, stale);

    expect(await harness.ctx.dataExport.sweepOrphanedArtifacts()).toBe(2);

    expect(existsSync(killedTemp)).toBe(false);
    expect(existsSync(orphanZip)).toBe(false);
    expect(existsSync(inFlight)).toBe(true);
    expect(existsSync(live)).toBe(true);
    // Idempotent: a second run has nothing left to reap.
    expect(await harness.ctx.dataExport.sweepOrphanedArtifacts()).toBe(0);
  });

  it('refuses an over-ceiling account cleanly and leaves the daily allowance intact', async () => {
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      // Far below any real archive, so the ordinary account trips the ceiling.
      exportLimits: { maxContentBytes: 512 },
    });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { jobId } = await requestExport(agent, user.password);

    // Typed terminal failure, not an OOM and not an opaque build error.
    expect(await jobRow(jobId)).toMatchObject({
      status: 'failed',
      error: 'EXPORT_TOO_LARGE',
      filePath: null,
      fileSize: null,
    });
    // No partial artifact survives.
    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip`))).toBe(false);
    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip.building`))).toBe(false);

    // The user is told what happened…
    const status = await agent.get('/api/v1/account/export').set(...XRW);
    expect(exportStatusResponseSchema.parse(status.body)).toMatchObject({
      status: 'failed',
      error: 'EXPORT_TOO_LARGE',
    });
    // …and the 1/day allowance is untouched, so a retry is admitted at once.
    const retry = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    expect(retry.status).toBe(200);
  });

  it('refuses before materializing rows when the account is past the row ceiling', async () => {
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      exportLimits: { maxRows: 0 },
    });
    const user = await harness.seedUser();
    await harness.db.insert(schema.notifications).values({
      userId: user.id,
      type: 'account.data_export',
      title: 'One append-only row',
      body: 'Enough to exceed a zero-row ceiling.',
    });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { jobId } = await requestExport(agent, user.password);

    expect(await jobRow(jobId)).toMatchObject({ status: 'failed', error: 'EXPORT_TOO_LARGE' });
    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip.building`))).toBe(false);
  });

  it('counts the expense ledger in the pre-flight, not only the portfolio tables', async () => {
    // The expense area became exported content in V5-P9, after this ceiling was
    // written. An append-only table the collector materializes but the
    // pre-flight does not count is exactly the OOM the ceiling exists to stop,
    // so an account whose ONLY bulk rows are expenses must still be refused.
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      exportLimits: { maxRows: 0 },
    });
    const user = await harness.seedUser();
    const [category] = await harness.db
      .insert(schema.expenseCategories)
      .values({ userId: user.id, name: 'Groceries' })
      .returning({ id: schema.expenseCategories.id });
    await harness.db.insert(schema.expenseTransactions).values({
      userId: user.id,
      categoryId: category!.id,
      amount: '12.34',
      bookedOn: '2026-03-02',
      description: 'One append-only expense row.',
    });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { jobId } = await requestExport(agent, user.password);

    expect(await jobRow(jobId)).toMatchObject({ status: 'failed', error: 'EXPORT_TOO_LARGE' });
    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip.building`))).toBe(false);
  });

  it('counts the auto-stamped cash-movement tags in the pre-flight, not only the movements', async () => {
    // `cash_movement_tags` is machine-generated at a MULTIPLE of the ledger: a
    // system tag is stamped on every movement INSERT and a matching rule stamps
    // its whole tag set on every noted movement, uncapped over the back
    // catalogue. Counting the movements alone admitted an account and then
    // materialized several times the ceiling in link rows (#1812).
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      // Two rows of headroom: the movement on its own is inside this ceiling,
      // and only the two tags stamped on it can carry the account past it.
      exportLimits: { maxRows: 2 },
    });

    /** One portfolio with one cash movement; optionally two tags stamped on it. */
    const seedMovement = async (tagged: boolean) => {
      const user = await harness.seedUser(
        tagged
          ? { email: 'tagged@bettertrack.test', username: 'taggeduser' }
          : { email: 'untagged@bettertrack.test', username: 'untaggeduser' },
      );
      const [portfolio] = await harness.db
        .insert(schema.portfolios)
        .values({ userId: user.id, name: 'TEST VECTOR tag ceiling portfolio' })
        .returning({ id: schema.portfolios.id });
      const [source] = await harness.db
        .insert(schema.portfolioCashSources)
        .values({ portfolioId: portfolio!.id, name: 'Bank', type: 'bank', isMain: true })
        .returning({ id: schema.portfolioCashSources.id });
      const [movement] = await harness.db
        .insert(schema.portfolioCashMovements)
        .values({
          portfolioId: portfolio!.id,
          sourceId: source!.id,
          kind: 'deposit',
          amountEur: '100',
          executedAt: new Date('2026-03-01T00:00:00.000Z'),
        })
        .returning({ id: schema.portfolioCashMovements.id });
      if (tagged) {
        for (const name of ['TEST VECTOR system tag', 'TEST VECTOR rule tag']) {
          const [tag] = await harness.db
            .insert(schema.cashTags)
            .values({ userId: user.id, name })
            .returning({ id: schema.cashTags.id });
          await harness.db
            .insert(schema.cashMovementTags)
            .values({ movementId: movement!.id, tagId: tag!.id });
        }
      }
      const agent = await loginAgent(harness.app, user.email, user.password);
      return requestExport(agent, user.password);
    };

    // Control: the identical account WITHOUT the tags is admitted, so the
    // refusal below is the tag count doing the work — not some other seeded row
    // drifting the account over the ceiling on its own.
    const admitted = await seedMovement(false);
    expect(await jobRow(admitted.jobId)).toMatchObject({ status: 'ready' });

    const { jobId } = await seedMovement(true);
    expect(await jobRow(jobId)).toMatchObject({ status: 'failed', error: 'EXPORT_TOO_LARGE' });
    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip.building`))).toBe(false);
  });

  it('describes the vault ciphertext it packaged, not the version it first read', async () => {
    // Reading the manifest projection and the bytes as two statements is what
    // keeps the ceiling pre-flight, but they are no longer one snapshot and vault
    // writes do not take the account transition lock. A doc rewritten in between
    // must therefore be described by the row its bytes came from — packaging new
    // bytes under the old version/sizeBytes would ship a manifest that lies
    // about the `.btvault` beside it (#1812).
    const user = await harness.seedUser();
    const original = Buffer.from([0x01, 0x02, 0x03]);
    const rewritten = Buffer.from('REWRITTEN_MID_BUILD_CIPHERTEXT');
    await harness.db
      .update(schema.users)
      .set({ privacyMode: 'paranoid', paranoidMediaSet: ['server'] })
      .where(eq(schema.users.id, user.id));
    await harness.db.insert(schema.paranoidVaults).values({
      userId: user.id,
      version: 1,
      formatVersion: 1,
      sizeBytes: original.byteLength,
      blob: original,
    });
    const service = buildService({
      // The one seam inside the build, between the metadata read and the byte
      // read: exactly the window a concurrent vault write occupies.
      afterCollect: async () => {
        await harness.db
          .update(schema.paranoidVaults)
          .set({ version: 2, sizeBytes: rewritten.byteLength, blob: rewritten })
          .where(eq(schema.paranoidVaults.userId, user.id));
      },
    });
    const { jobId } = await reserveJob(user.id);

    await service.buildExport(jobId);

    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: 'ready' });
    const files = unzipSync(new Uint8Array(await readFile(row!.filePath!)));
    const packaged = files['paranoid/current-vault.btvault']!;
    expect(Buffer.from(packaged).equals(rewritten)).toBe(true);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as {
      paranoidVault: { included: boolean; version: number; sizeBytes: number };
    };
    expect(manifest.paranoidVault).toMatchObject({
      included: true,
      version: 2,
      sizeBytes: rewritten.byteLength,
    });
    expect(manifest.paranoidVault.sizeBytes).toBe(packaged.byteLength);
  });

  it('refuses on the declared vault ciphertext size before a single blob is read', async () => {
    // The blobs used to be selected — unbounded, `bytea` and all — before any
    // ceiling was consulted, so a runaway account was resident in the worker
    // BEFORE being refused (#1812). The declared size here is a deliberate lie
    // (8 MiB claimed, 16 bytes stored): only a pre-flight sum over the metadata
    // can refuse this account, and packaging the actual bytes would succeed.
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      // Far above an ordinary archive, so nothing else can trip the ceiling.
      exportLimits: { maxContentBytes: 5_000_000 },
    });
    const user = await harness.seedUser();
    await seedServerVault(user.id, VAULT_VECTOR.vaultId, [
      {
        docId: VAULT_VECTOR.headerDocId,
        docKind: 'header',
        bytes: 16,
        declaredSize: 8 * 1024 * 1024,
      },
    ]);
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { jobId } = await requestExport(agent, user.password);

    expect(await jobRow(jobId)).toMatchObject({ status: 'failed', error: 'EXPORT_TOO_LARGE' });
    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip`))).toBe(false);
    expect(existsSync(joinPath(EXPORT_DIR, `${jobId}.zip.building`))).toBe(false);
  });

  it('exports an account whose ciphertext outgrew the ceiling once the deployment raises it', async () => {
    // The over-ceiling refusal is terminal, so without a knob an account past
    // the built-in limit could NEVER obtain its §6.1 archive. The ceiling is
    // deployment-configurable (BT_EXPORT_MAX_CONTENT_BYTES) — asserted end to
    // end: the same account, refused under a low ceiling, exports under a
    // raised one (#1812).
    const docBytes = 300_000;
    const seed = async () => {
      const user = await harness.seedUser();
      await seedServerVault(user.id, VAULT_VECTOR.vaultId, [
        { docId: VAULT_VECTOR.headerDocId, docKind: 'header', bytes: docBytes },
      ]);
      const agent = await loginAgent(harness.app, user.email, user.password);
      return requestExport(agent, user.password);
    };

    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR, BT_EXPORT_MAX_CONTENT_BYTES: '200000' },
    });
    const refused = await seed();
    expect(await jobRow(refused.jobId)).toMatchObject({
      status: 'failed',
      error: 'EXPORT_TOO_LARGE',
    });

    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR, BT_EXPORT_MAX_CONTENT_BYTES: '50000000' },
    });
    const built = await seed();
    const row = await jobRow(built.jobId);
    expect(row).toMatchObject({ status: 'ready', error: null });
    expect(existsSync(row!.filePath!)).toBe(true);
    // The ciphertext really is in the archive — raising the ceiling did not
    // quietly drop what it exists to carry.
    expect(row!.fileSize!).toBeGreaterThan(0);
  });

  it('releases the privacy lock at the absolute bound even when the reader never stops', async () => {
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      exportDownloadMaxMs: 150,
    });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { downloadToken } = await requestExport(agent, user.password);

    // A client that drip-feeds forever resets the route's INACTIVITY timeout on
    // every byte; only an absolute bound can end it.
    const started = Date.now();
    await expect(
      harness.ctx.dataExport.withDownload(
        { userId: user.id, token: downloadToken },
        () => new Promise<void>(() => undefined),
      ),
    ).rejects.toThrow(/time limit/);
    expect(Date.now() - started).toBeLessThan(10_000);

    // The lock (and with it the pooled connection and its open transaction) is
    // free again: another lock-taking operation completes immediately.
    await expect(harness.ctx.dataExport.purgeUserArtifacts(user.id)).resolves.toBe(1);
  });

  it('signals the deadline to the streaming caller', async () => {
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      exportDownloadMaxMs: 150,
    });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { downloadToken } = await requestExport(agent, user.password);

    let aborted = false;
    await harness.ctx.dataExport.withDownload(
      { userId: user.id, token: downloadToken },
      (_file, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        }),
    );
    expect(aborted).toBe(true);
  });

  it('purges the user artifacts and rows', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const { jobId } = await requestExport(agent, user.password);
    const filePath = (await jobRow(jobId))!.filePath!;
    expect(existsSync(filePath)).toBe(true);

    expect(await harness.ctx.dataExport.purgeUserArtifacts(user.id)).toBe(1);

    expect(existsSync(filePath)).toBe(false);
    expect(await jobRow(jobId)).toBeNull();
  });
});
