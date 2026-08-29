import { tmpdir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { existsSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';

import { unzipSync, strFromU8 } from 'fflate';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { exportRequestResponseSchema, exportStatusResponseSchema } from '@bettertrack/contracts';

import * as schema from '../../../data/schema';
import { hashToken } from '../../crypto/tokens';
import { collectUserExport } from '../collector';
import { EXPORTED_ENTITY_NAMES, PARANOID_SERVER_EXPORTED_ENTITY_NAMES } from '../manifest';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const EXPORT_DIR = joinPath(tmpdir(), 'bettertrack-test-exports');

// TEST VECTOR: one complete durable E4 move-out receipt, reused only across
// isolated test databases. The pending bit is the account-export fence.
const PENDING_MOVE_OUT_VECTOR = {
  vaultId: '00000000-0000-7000-8000-000000000901',
  moveOutId: '00000000-0000-7000-8000-000000000902',
  documentDigest: 'TEST_VECTOR_pending_export_document_digest',
  documentSetHash: 'TEST_VECTOR_pending_export_document_set_hash',
  proofPublicKey: 'TEST VECTOR pending export proof public key',
  completedAt: new Date('2026-08-21T12:34:56.000Z'),
} as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp({ env: { BT_EXPORT_DIR: EXPORT_DIR } });
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

/** Give a seeded user a portfolio row directly (seedUser mints no portfolio). */
async function seedPortfolio(userId: string, name: string): Promise<string> {
  const [row] = await harness.db
    .insert(schema.portfolios)
    .values({ userId, name })
    .returning({ id: schema.portfolios.id });
  return row!.id;
}

async function seedPendingPortfolioMoveOut(userId: string, portfolioId: string): Promise<void> {
  await harness.db.insert(schema.portfolioVaultTransitionStates).values({
    portfolioId,
    userId,
    lifecycleGeneration: 1,
    moveOutVaultId: PENDING_MOVE_OUT_VECTOR.vaultId,
    moveOutId: PENDING_MOVE_OUT_VECTOR.moveOutId,
    moveOutDocumentDigest: PENDING_MOVE_OUT_VECTOR.documentDigest,
    moveOutDocumentSetHash: PENDING_MOVE_OUT_VECTOR.documentSetHash,
    moveOutProofPublicKey: PENDING_MOVE_OUT_VECTOR.proofPublicKey,
    moveOutCompletedAt: PENDING_MOVE_OUT_VECTOR.completedAt,
    moveOutPostCommitPending: true,
    moveOutPostCommitCustomAssetIds: [],
  });
}

async function clearPendingPortfolioMoveOut(portfolioId: string): Promise<void> {
  await harness.db
    .update(schema.portfolioVaultTransitionStates)
    .set({
      moveOutPostCommitPending: false,
      moveOutPostCommitCustomAssetIds: [],
      moveOutPostCommitLastAttemptAt: null,
    })
    .where(eq(schema.portfolioVaultTransitionStates.portfolioId, portfolioId));
}

/** Unzip a downloaded archive into { path -> text }. */
function unzipText(body: Buffer): Record<string, string> {
  const files = unzipSync(new Uint8Array(body));
  const out: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) out[name] = strFromU8(bytes);
  return out;
}

describe('account data export', () => {
  it('requests → builds → notifies → downloads a valid zip; stores only the token hash', async () => {
    const user = await harness.seedUser();
    const portfolioId = await seedPortfolio(user.id, 'Main');
    const agent = await loginAgent(harness.app, user.email, user.password);

    // Request: re-auth by password. The build runs synchronously under the test
    // seam, so the job is ready by the time the response returns.
    const reqRes = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    expect(reqRes.status).toBe(200);
    const { jobId, downloadToken } = exportRequestResponseSchema.parse(reqRes.body);

    // Only the hash is persisted; the row is ready with a file + expiry.
    const [row] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(row!.downloadTokenHash).toBe(hashToken(downloadToken));
    expect(row!.status).toBe('ready');
    expect(row!.filePath).toBeTruthy();
    expect(row!.expiresAt).toBeTruthy();
    const [directoryStat, fileStat] = await Promise.all([
      stat(dirname(row!.filePath!)),
      stat(row!.filePath!),
    ]);
    expect(directoryStat.mode & 0o777).toBe(0o700);
    expect(fileStat.mode & 0o777).toBe(0o600);

    // The completion notification landed in the inbox (deep-links to Settings).
    const notes = await harness.db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.userId, user.id),
          eq(schema.notifications.type, 'account.data_export'),
        ),
      );
    expect(notes.length).toBe(1);

    // Status poll reports ready with the size + expiry (no secret).
    const statusRes = await agent.get('/api/v1/account/export');
    const status = exportStatusResponseSchema.parse(statusRes.body);
    expect(status.status).toBe('ready');
    expect(status.jobId).toBe(jobId);
    expect(status.sizeBytes).toBeGreaterThan(0);

    // The legacy query-string route is gone: a token in a URL never downloads.
    const legacyQuery = await agent.get(
      `/api/v1/account/export/download?token=${encodeURIComponent(downloadToken)}`,
    );
    expect(legacyQuery.status).toBe(404);

    // Exchange the held token in a POST body: a valid no-store zip with JSON
    // per entity + CSVs.
    const dl = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken })
      .responseType('blob');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['cache-control']).toBe('no-store');
    expect(dl.headers['referrer-policy']).toBe('no-referrer');
    const files = unzipText(dl.body as Buffer);

    expect(files['manifest.json']).toBeTruthy();
    expect(files['csv/transactions.csv']).toBeTruthy();
    expect(files['csv/cash-movements.csv']).toBeTruthy();
    expect(files['csv/holdings.csv']).toBeTruthy();
    // Every classified entity has a JSON file that parses to an array.
    for (const entity of EXPORTED_ENTITY_NAMES) {
      const raw = files[`data/${entity}.json`];
      expect(raw, `missing data/${entity}.json`).toBeTruthy();
      expect(Array.isArray(JSON.parse(raw!))).toBe(true);
    }
    // The user's own portfolio is present.
    const portfolios = JSON.parse(files['data/portfolios.json']!) as { id: string }[];
    expect(portfolios.map((p) => p.id)).toContain(portfolioId);

    // The conditional claim clears the hash. Replaying the exact same exchange
    // fails closed without streaming the file again.
    const [consumed] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(consumed!.downloadTokenHash).toBeNull();
    const replay = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken });
    expect(replay.status).toBe(404);
    expect(replay.body.error.code).toBe('EXPORT_NOT_FOUND');
  });

  it('exports only the requesting user’s rows', async () => {
    const alice = await harness.seedUser({ email: 'alice@bettertrack.test', username: 'alice' });
    const bob = await harness.seedUser({ email: 'bob@bettertrack.test', username: 'bob' });
    const aliceP = await seedPortfolio(alice.id, 'Alice-Main');
    const bobP = await seedPortfolio(bob.id, 'Bob-Main');
    const [aliceFeedback, bobFeedback] = await harness.db
      .insert(schema.feedback)
      .values([
        {
          userId: alice.id,
          category: 'feature',
          subject: 'Alice forecast idea',
          message: 'Alice feature',
          context: { screen: '/forecast' },
        },
        {
          userId: bob.id,
          category: 'bug',
          subject: 'Bob private subject',
          message: 'Bob bug',
        },
      ])
      .returning({ id: schema.feedback.id });

    const agent = await loginAgent(harness.app, alice.email, alice.password);
    const reqRes = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: alice.password });
    const { downloadToken } = exportRequestResponseSchema.parse(reqRes.body);
    const dl = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken })
      .responseType('blob');
    const files = unzipText(dl.body as Buffer);
    const ids = (JSON.parse(files['data/portfolios.json']!) as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(aliceP);
    expect(ids).not.toContain(bobP);
    const feedbackRows = JSON.parse(files['data/feedback.json']!) as Record<string, unknown>[];
    expect(feedbackRows).toHaveLength(1);
    expect(feedbackRows[0]).toMatchObject({
      id: aliceFeedback!.id,
      userId: alice.id,
      category: 'feature',
      subject: 'Alice forecast idea',
      message: 'Alice feature',
      context: { screen: '/forecast' },
      status: 'new',
    });
    expect(feedbackRows).not.toContainEqual(expect.objectContaining({ id: bobFeedback!.id }));
  });

  it('omits the admin-workspace feedback columns from the submitter’s export', async () => {
    const user = await harness.seedUser({
      email: 'archived@bettertrack.test',
      username: 'archived',
    });
    const archivedAt = new Date('2026-08-20T09:00:00.000Z');
    const adminLastReadAt = new Date('2026-08-21T10:30:00.000Z');
    const [submission] = await harness.db
      .insert(schema.feedback)
      .values({
        userId: user.id,
        category: 'bug',
        subject: 'Chart legend overlaps',
        message: 'The legend covers the last candle.',
        context: { screen: '/portfolio' },
        status: 'declined',
        declinedReason: 'Working as intended.',
        // Admin workspace hygiene: invisible on every submitter surface.
        archivedAt,
        adminLastReadAt,
      })
      .returning({ id: schema.feedback.id });

    const agent = await loginAgent(harness.app, user.email, user.password);
    const reqRes = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    const { downloadToken } = exportRequestResponseSchema.parse(reqRes.body);
    const dl = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken })
      .responseType('blob');
    const files = unzipText(dl.body as Buffer);
    const rows = JSON.parse(files['data/feedback.json']!) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // The admin-side columns never reach the ZIP — not as a value, not as a key.
    expect(Object.keys(row)).not.toContain('archivedAt');
    expect(Object.keys(row)).not.toContain('adminLastReadAt');
    expect(JSON.stringify(row)).not.toContain(archivedAt.toISOString());
    expect(JSON.stringify(row)).not.toContain(adminLastReadAt.toISOString());

    // …while everything the submitter authored or is shown survives unchanged.
    expect(row).toMatchObject({
      id: submission!.id,
      userId: user.id,
      category: 'bug',
      subject: 'Chart legend overlaps',
      message: 'The legend covers the last candle.',
      context: { screen: '/portfolio' },
      status: 'declined',
      declinedReason: 'Working as intended.',
      shippedVersion: null,
    });
    for (const key of ['createdAt', 'updatedAt', 'lastStatusChangeAt']) {
      expect(typeof row[key], `${key} should be a serialized timestamp`).toBe('string');
    }
    // Pinned exactly, so a future admin-only column added to the table without
    // touching the collector cannot silently join the submitter's export.
    expect(Object.keys(row).sort()).toEqual(
      [
        'category',
        'context',
        'createdAt',
        'declinedReason',
        'deletedByUserAt',
        'id',
        'lastStatusChangeAt',
        'message',
        'shippedVersion',
        'status',
        'subject',
        'submitterLastReadAt',
        'updatedAt',
        'userId',
      ].sort(),
    );
  });

  it('exports staff replies without the replying admin’s internal user id', async () => {
    const user = await harness.seedUser({
      email: 'threaded@bettertrack.test',
      username: 'threaded',
    });
    const admin = await harness.seedAdmin();
    const [submission] = await harness.db
      .insert(schema.feedback)
      .values({ userId: user.id, category: 'bug', message: 'Something is off.' })
      .returning({ id: schema.feedback.id });
    await harness.db.insert(schema.feedbackMessages).values([
      {
        feedbackId: submission!.id,
        authorSide: 'submitter',
        authorUserId: user.id,
        body: 'Here are the details.',
      },
      {
        feedbackId: submission!.id,
        authorSide: 'admin',
        authorUserId: admin.id,
        body: 'Thanks — fixed in the next release.',
      },
    ]);

    const collected = await collectUserExport(harness.db, user.id);
    const messages = collected.entities.feedbackMessages as Record<string, unknown>[];
    expect(messages).toHaveLength(2);
    // The staff body is the user's own correspondence and stays exported; the
    // admin account id behind it is identity the product never surfaces.
    expect(messages).toContainEqual(
      expect.objectContaining({
        authorSide: 'admin',
        authorUserId: null,
        body: 'Thanks — fixed in the next release.',
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ authorSide: 'submitter', authorUserId: user.id }),
    );
    expect(JSON.stringify(messages)).not.toContain(admin.id);
  });

  it('the collector produces exactly the classified entity set', async () => {
    const user = await harness.seedUser();
    await harness.db.insert(schema.oauthClients).values({
      userId: user.id,
      clientId: 'btc_export_client',
      name: 'Export client',
      clientSecretHash: 'secret-hash',
      redirectUris: ['https://client.example/callback'],
      scopes: ['portfolio:read'],
      isPublic: false,
      logoUrl: 'https://client.example/logo.png',
      logoBytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      logoContentType: 'image/png',
    });
    await harness.db.insert(schema.externalIdentities).values({
      userId: user.id,
      provider: 'google',
      subject: 'opaque-google-subject',
      email: user.email,
      emailVerified: true,
    });
    const collected = await collectUserExport(harness.db, user.id);
    expect(Object.keys(collected.entities).sort()).toEqual([...EXPORTED_ENTITY_NAMES]);
    // The account entity always carries the user's own sanitized row, with no
    // credentials or server-internal security state leaked.
    const account = collected.entities.account as Record<string, unknown>[];
    expect(account.length).toBe(1);
    expect(account[0]).not.toHaveProperty('passwordHash');
    expect(account[0]).not.toHaveProperty('securityGeneration');
    // Cached raster bytes have no account-export value and can expand into a
    // multi-megabyte JSON byte array. Keep the source metadata, not the blob.
    const oauthClients = collected.entities.oauthClients as Record<string, unknown>[];
    expect(oauthClients).toHaveLength(1);
    expect(oauthClients[0]).not.toHaveProperty('clientSecretHash');
    expect(oauthClients[0]).not.toHaveProperty('logoBytes');
    expect(oauthClients[0]).toMatchObject({
      logoUrl: 'https://client.example/logo.png',
      logoContentType: 'image/png',
    });
    // `subject` is table-sensitive: the opaque OIDC identifier stays redacted
    // even though user-authored feedback subjects remain in account exports.
    const identities = collected.entities.externalIdentities as Record<string, unknown>[];
    expect(identities).toHaveLength(1);
    expect(identities[0]).not.toHaveProperty('subject');
    expect(identities[0]).toMatchObject({ provider: 'google', email: user.email });
  });

  it('rejects a wrong re-auth without creating a job', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const res = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: 'not-the-password' });
    expect(res.status).toBe(401);
    const jobs = await harness.db.select().from(schema.exportJobs);
    expect(jobs.length).toBe(0);
  });

  it('rate-limits to one export per day', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const first = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    expect(first.status).toBe(200);
    const second = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('EXPORT_RATE_LIMITED');
  });

  it('atomically admits exactly one concurrent request and enqueue', async () => {
    const enqueueBuild = vi.fn(async (_jobId: string) => undefined);
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      exportEnqueue: enqueueBuild,
    });
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);

    const responses = await Promise.all([
      agent
        .post('/api/v1/account/export')
        .set(...XRW)
        .send({ password: user.password }),
      agent
        .post('/api/v1/account/export')
        .set(...XRW)
        .send({ password: user.password }),
    ]);

    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 429]);
    expect(responses.find((response) => response.status === 429)?.body.error.code).toBe(
      'EXPORT_RATE_LIMITED',
    );
    const jobs = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.userId, user.id));
    expect(jobs).toHaveLength(1);
    expect(enqueueBuild).toHaveBeenCalledTimes(1);
    expect(enqueueBuild).toHaveBeenCalledWith(jobs[0]!.id);
  });

  it('fails a download closed for a foreign or expired token', async () => {
    const alice = await harness.seedUser({ email: 'a2@bettertrack.test', username: 'a2' });
    const bob = await harness.seedUser({ email: 'b2@bettertrack.test', username: 'b2' });
    const aliceAgent = await loginAgent(harness.app, alice.email, alice.password);
    const bobAgent = await loginAgent(harness.app, bob.email, bob.password);

    const reqRes = await aliceAgent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: alice.password });
    const { jobId, downloadToken } = exportRequestResponseSchema.parse(reqRes.body);

    // Bob presents Alice's token → 404 (foreign).
    const foreign = await bobAgent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken });
    expect(foreign.status).toBe(404);

    // Expire Alice's window → her own valid token now 404s.
    await harness.db
      .update(schema.exportJobs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.exportJobs.id, jobId));
    const expired = await aliceAgent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken });
    expect(expired.status).toBe(404);
    expect(expired.body.error.code).toBe('EXPORT_NOT_FOUND');
  });

  it('fails a download closed when the ready archive is gone from disk', async () => {
    // A `ready` row can outlive its bytes: a paranoid enable unlinks the staged
    // archive BEFORE its transaction commits, and that commit is allowed to fail
    // outcome-ambiguously (an unlink that started is never undone). Operator-side
    // deletion lands in the same state. The reply must be the ordinary opaque 404,
    // not a 500 raised mid-stream — asserted through the real HTTP route.
    const user = await harness.seedUser({ email: 'gone@bettertrack.test', username: 'gone' });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const reqRes = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    const { jobId, downloadToken } = exportRequestResponseSchema.parse(reqRes.body);
    const [row] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    await rm(row!.filePath!);
    expect(existsSync(row!.filePath!)).toBe(false);

    const gone = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken });
    expect(gone.status, JSON.stringify(gone.body)).toBe(404);
    expect(gone.body.error.code).toBe('EXPORT_NOT_FOUND');
  });

  it('defers a pending build without poisoning the job, then builds that same job after E4 clears', async () => {
    const enqueueBuild = vi.fn(async (_jobId: string) => undefined);
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      exportEnqueue: enqueueBuild,
    });
    const user = await harness.seedUser({
      email: 'pending-export-build@bettertrack.test',
      username: 'pending_export_build',
    });
    const portfolioId = await seedPortfolio(user.id, 'TEST VECTOR pending build portfolio');
    const agent = await loginAgent(harness.app, user.email, user.password);
    const requested = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    expect(requested.status).toBe(200);
    const { jobId } = exportRequestResponseSchema.parse(requested.body);
    await seedPendingPortfolioMoveOut(user.id, portfolioId);

    await expect(harness.ctx.dataExport.buildExport(jobId)).rejects.toThrow(
      'account export deferred by portfolio vault finalization',
    );
    const [deferred] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(deferred).toMatchObject({
      status: 'pending',
      error: null,
      filePath: null,
      fileSize: null,
    });
    expect(enqueueBuild).toHaveBeenCalledOnce();
    expect(enqueueBuild).toHaveBeenCalledWith(jobId);

    await clearPendingPortfolioMoveOut(portfolioId);
    await expect(harness.ctx.dataExport.buildExport(jobId)).resolves.toBeUndefined();
    const [ready] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(ready).toMatchObject({ status: 'ready', error: null });
    expect(ready!.filePath).toBeTruthy();
    expect(existsSync(ready!.filePath!)).toBe(true);
  });

  it('does not consume a ready download token while E4 is pending, then accepts the same token', async () => {
    const user = await harness.seedUser({
      email: 'pending-export-download@bettertrack.test',
      username: 'pending_export_download',
    });
    const portfolioId = await seedPortfolio(user.id, 'TEST VECTOR pending download portfolio');
    const agent = await loginAgent(harness.app, user.email, user.password);
    const requested = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    expect(requested.status).toBe(200);
    const { jobId, downloadToken } = exportRequestResponseSchema.parse(requested.body);
    await seedPendingPortfolioMoveOut(user.id, portfolioId);

    const blocked = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken });
    expect(blocked.status).toBe(404);
    expect(blocked.body.error.code).toBe('EXPORT_NOT_FOUND');
    const [preserved] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(preserved).toMatchObject({
      status: 'ready',
      downloadTokenHash: hashToken(downloadToken),
    });

    await clearPendingPortfolioMoveOut(portfolioId);
    const downloaded = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken })
      .responseType('blob');
    expect(downloaded.status).toBe(200);
    expect(unzipText(downloaded.body as Buffer)['manifest.json']).toBeTruthy();
    const [consumed] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(consumed!.downloadTokenHash).toBeNull();
  });

  it('cleanup deletes expired export files and rows', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(harness.app, user.email, user.password);
    const reqRes = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    const { jobId } = exportRequestResponseSchema.parse(reqRes.body);

    const [row] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(existsSync(row!.filePath!)).toBe(true);

    // Move the window into the past and run the cleanup sweep.
    await harness.db
      .update(schema.exportJobs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.exportJobs.id, jobId));
    const pruned = await harness.ctx.dataExport.cleanupExpired();
    expect(pruned).toBeGreaterThanOrEqual(1);

    expect(existsSync(row!.filePath!)).toBe(false);
    const after = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(after.length).toBe(0);
  });

  it('exports only owner-scoped current docs from server-backed per-vault configs', async () => {
    const owner = await harness.seedUser({
      email: 'vault-export@bettertrack.test',
      username: 'vault-export',
    });
    const stranger = await harness.seedUser({
      email: 'foreign-vault-export@bettertrack.test',
      username: 'foreign-vault-export',
    });

    // TEST VECTORS: fixed UUIDs, timestamps and opaque bytes make manifest paths,
    // ordering, metadata and byte-exact ZIP assertions deterministic.
    const SERVER_VAULT_ID = '00000000-0000-7000-8000-000000000101';
    const EMPTY_SERVER_DRIVE_VAULT_ID = '00000000-0000-7000-8000-000000000102';
    const DRIVE_ONLY_VAULT_ID = '00000000-0000-7000-8000-000000000103';
    const FOREIGN_SERVER_VAULT_ID = '00000000-0000-7000-8000-000000000104';
    const SERVER_HEADER_DOC_ID = '00000000-0000-7000-8000-000000000201';
    const SERVER_COMMON_DOC_ID = '00000000-0000-7000-8000-000000000202';
    const EMPTY_HEADER_DOC_ID = '00000000-0000-7000-8000-000000000211';
    const EMPTY_COMMON_DOC_ID = '00000000-0000-7000-8000-000000000212';
    const DRIVE_HEADER_DOC_ID = '00000000-0000-7000-8000-000000000221';
    const DRIVE_COMMON_DOC_ID = '00000000-0000-7000-8000-000000000222';
    const FOREIGN_HEADER_DOC_ID = '00000000-0000-7000-8000-000000000231';
    const FOREIGN_COMMON_DOC_ID = '00000000-0000-7000-8000-000000000232';
    const updatedAt = new Date('2026-08-20T12:34:56.000Z');
    const currentBytes = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x2a, 0x00, 0x4d]);
    const driveOnlyBytes = Buffer.from('DRIVE_ONLY_DOC_MUST_NOT_EXPORT');
    const foreignBytes = Buffer.from('FOREIGN_DOC_MUST_NOT_EXPORT');
    const historyBytes = Buffer.from('HISTORY_DOC_MUST_NOT_EXPORT');
    const candidateBytes = Buffer.from('CANDIDATE_DOC_MUST_NOT_EXPORT');
    const retiredBytes = Buffer.from('RETIRED_DOC_MUST_NOT_EXPORT');
    const verifierSentinel = ['retirement', 'verifier', 'must', 'not', 'export'].join('-');
    const fingerprintSentinel = ['key', 'fingerprint', 'must', 'not', 'export'].join('-');
    const vaultNameSentinel = 'VAULT_NAME_MUST_NOT_EXPORT';

    const [driveConnection] = await harness.db
      .insert(schema.driveConnections)
      .values({
        userId: owner.id,
        googleSub: 'test-vector-google-sub',
        email: 'vault-drive@bettertrack.test',
        displayName: 'Drive identity must not export',
      })
      .returning({ id: schema.driveConnections.id });

    await harness.db.insert(schema.vaults).values([
      {
        id: SERVER_VAULT_ID,
        userId: owner.id,
        name: vaultNameSentinel,
        media: ['server'],
        driveConnectionId: null,
        headerDocId: SERVER_HEADER_DOC_ID,
        commonDocId: SERVER_COMMON_DOC_ID,
        retirementProofPublicKey: verifierSentinel,
        keyFingerprint: fingerprintSentinel,
      },
      {
        id: EMPTY_SERVER_DRIVE_VAULT_ID,
        userId: owner.id,
        name: 'EMPTY_SERVER_DRIVE_NAME_MUST_NOT_EXPORT',
        media: ['server', 'drive'],
        driveConnectionId: driveConnection!.id,
        headerDocId: EMPTY_HEADER_DOC_ID,
        commonDocId: EMPTY_COMMON_DOC_ID,
        retirementProofPublicKey: verifierSentinel,
        keyFingerprint: fingerprintSentinel,
      },
      {
        id: DRIVE_ONLY_VAULT_ID,
        userId: owner.id,
        name: 'DRIVE_ONLY_NAME_MUST_NOT_EXPORT',
        media: ['drive'],
        driveConnectionId: driveConnection!.id,
        headerDocId: DRIVE_HEADER_DOC_ID,
        commonDocId: DRIVE_COMMON_DOC_ID,
        retirementProofPublicKey: verifierSentinel,
        keyFingerprint: fingerprintSentinel,
      },
      {
        id: FOREIGN_SERVER_VAULT_ID,
        userId: stranger.id,
        name: 'FOREIGN_VAULT_NAME_MUST_NOT_EXPORT',
        media: ['server'],
        driveConnectionId: null,
        headerDocId: FOREIGN_HEADER_DOC_ID,
        commonDocId: FOREIGN_COMMON_DOC_ID,
        retirementProofPublicKey: verifierSentinel,
        keyFingerprint: fingerprintSentinel,
      },
    ]);

    await harness.db.insert(schema.vaultBlobs).values([
      {
        vaultId: SERVER_VAULT_ID,
        docId: SERVER_HEADER_DOC_ID,
        docKind: 'header',
        portfolioId: null,
        version: 4,
        formatVersion: 17,
        sizeBytes: currentBytes.byteLength,
        blob: currentBytes,
        updatedAt,
      },
      {
        vaultId: DRIVE_ONLY_VAULT_ID,
        docId: DRIVE_HEADER_DOC_ID,
        docKind: 'header',
        portfolioId: null,
        version: 8,
        formatVersion: 1,
        sizeBytes: driveOnlyBytes.byteLength,
        blob: driveOnlyBytes,
      },
      {
        vaultId: FOREIGN_SERVER_VAULT_ID,
        docId: FOREIGN_HEADER_DOC_ID,
        docKind: 'header',
        portfolioId: null,
        version: 2,
        formatVersion: 1,
        sizeBytes: foreignBytes.byteLength,
        blob: foreignBytes,
      },
    ]);

    // Only `vault_blobs` is exportable. These three server-side lifecycle stores
    // carry conspicuous bytes so an accidental broad query cannot pass silently.
    await Promise.all([
      harness.db.insert(schema.vaultBlobHistory).values({
        vaultId: SERVER_VAULT_ID,
        docId: SERVER_HEADER_DOC_ID,
        version: 3,
        formatVersion: 17,
        sizeBytes: historyBytes.byteLength,
        blob: historyBytes,
      }),
      harness.db.insert(schema.vaultServerCandidates).values({
        transitionId: '00000000-0000-7000-8000-000000000301',
        vaultId: SERVER_VAULT_ID,
        docId: SERVER_COMMON_DOC_ID,
        version: 1,
        formatVersion: 17,
        sizeBytes: candidateBytes.byteLength,
        blob: candidateBytes,
        expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      }),
      harness.db.insert(schema.vaultRetired).values({
        vaultId: SERVER_VAULT_ID,
        docId: SERVER_HEADER_DOC_ID,
        version: 2,
        formatVersion: 17,
        sizeBytes: retiredBytes.byteLength,
        blob: retiredBytes,
        createdAt: new Date('2026-08-18T00:00:00.000Z'),
      }),
    ]);

    const lockedPortfolioId = await seedPortfolio(owner.id, 'Locked stub config may export');
    await harness.db
      .update(schema.portfolios)
      .set({ vaultId: SERVER_VAULT_ID, vaultAlias: 'Locked alias config may export' })
      .where(eq(schema.portfolios.id, lockedPortfolioId));
    const [asset] = await harness.db
      .insert(schema.assets)
      .values({
        providerId: 'yahoo',
        providerRef: 'E1-EXPORT-LOCKED',
        type: 'stock',
        symbol: 'E1LOCK',
        name: 'Locked-child test asset',
        currency: 'EUR',
        exchange: 'XETRA',
      })
      .returning({ id: schema.assets.id });
    const [cashSource] = await harness.db
      .insert(schema.portfolioCashSources)
      .values({
        portfolioId: lockedPortfolioId,
        name: 'LOCKED_CASH_SOURCE_MUST_NOT_EXPORT',
        type: 'bank',
        isMain: true,
      })
      .returning({ id: schema.portfolioCashSources.id });
    await Promise.all([
      harness.db.insert(schema.transactions).values({
        portfolioId: lockedPortfolioId,
        assetId: asset!.id,
        side: 'buy',
        quantity: '1',
        price: '123',
        executedAt: new Date('2026-08-01T00:00:00.000Z'),
        note: 'LOCKED_TRANSACTION_MUST_NOT_EXPORT',
      }),
      harness.db.insert(schema.dividends).values({
        portfolioId: lockedPortfolioId,
        assetId: asset!.id,
        cashSourceId: cashSource!.id,
        grossAmountEur: '7',
        executedAt: new Date('2026-08-02T00:00:00.000Z'),
        note: 'LOCKED_DIVIDEND_MUST_NOT_EXPORT',
        taxMode: 'none',
      }),
      harness.db.insert(schema.portfolioCashMovements).values({
        portfolioId: lockedPortfolioId,
        sourceId: cashSource!.id,
        kind: 'deposit',
        amountEur: '9',
        executedAt: new Date('2026-08-03T00:00:00.000Z'),
        note: 'LOCKED_CASH_MOVEMENT_MUST_NOT_EXPORT',
      }),
      harness.db.insert(schema.portfolioSettings).values({
        portfolioId: lockedPortfolioId,
        key: 'locked-export-test',
        value: { sentinel: 'LOCKED_SETTING_MUST_NOT_EXPORT' },
      }),
    ]);

    // The account deliberately remains legacy `privacyMode = normal`: E1 vault
    // discovery must not depend on that account-wide switch.
    const agent = await loginAgent(harness.app, owner.email, owner.password);
    const requested = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: owner.password });
    expect(requested.status).toBe(200);
    const { downloadToken } = exportRequestResponseSchema.parse(requested.body);
    const downloaded = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken })
      .responseType('blob');
    expect(downloaded.status).toBe(200);

    const files = unzipSync(new Uint8Array(downloaded.body as Buffer));
    const manifestRaw = strFromU8(files['manifest.json']!);
    const manifest = JSON.parse(manifestRaw) as {
      vaults: {
        vaultId: string;
        media: string[];
        docs: Record<string, unknown>[];
      }[];
    };
    expect(manifest.vaults.map((vault) => vault.vaultId)).toEqual([
      SERVER_VAULT_ID,
      EMPTY_SERVER_DRIVE_VAULT_ID,
    ]);
    expect(manifest.vaults[0]).toEqual({
      vaultId: SERVER_VAULT_ID,
      media: ['server'],
      docs: [
        {
          docId: SERVER_HEADER_DOC_ID,
          docKind: 'header',
          version: 4,
          formatVersion: 17,
          sizeBytes: currentBytes.byteLength,
          updatedAt: updatedAt.toISOString(),
          file: `paranoid/vaults/${SERVER_VAULT_ID}/docs/${SERVER_HEADER_DOC_ID}.btvault`,
        },
      ],
    });
    expect(manifest.vaults[1]).toEqual({
      vaultId: EMPTY_SERVER_DRIVE_VAULT_ID,
      media: ['server', 'drive'],
      docs: [],
    });
    expect(Object.keys(manifest.vaults[0]!).sort()).toEqual(['docs', 'media', 'vaultId']);
    expect(Object.keys(manifest.vaults[0]!.docs[0]!).sort()).toEqual([
      'docId',
      'docKind',
      'file',
      'formatVersion',
      'sizeBytes',
      'updatedAt',
      'version',
    ]);

    const currentPath = `paranoid/vaults/${SERVER_VAULT_ID}/docs/${SERVER_HEADER_DOC_ID}.btvault`;
    expect(Buffer.from(files[currentPath]!)).toEqual(currentBytes);
    expect(Object.keys(files).filter((path) => path.startsWith('paranoid/vaults/'))).toEqual([
      currentPath,
    ]);

    const portfolioRows = JSON.parse(strFromU8(files['data/portfolios.json']!)) as {
      id: string;
      vaultId: string | null;
    }[];
    expect(portfolioRows).toContainEqual(
      expect.objectContaining({ id: lockedPortfolioId, vaultId: SERVER_VAULT_ID }),
    );
    for (const entity of [
      'transactions',
      'cashSources',
      'dividends',
      'cashMovements',
      'portfolioSettings',
    ]) {
      expect(JSON.parse(strFromU8(files[`data/${entity}.json`]!))).toEqual([]);
    }

    const archiveText = Object.values(files)
      .map((bytes) => strFromU8(bytes))
      .join('\n');
    for (const forbidden of [
      driveOnlyBytes.toString(),
      foreignBytes.toString(),
      historyBytes.toString(),
      candidateBytes.toString(),
      retiredBytes.toString(),
      verifierSentinel,
      fingerprintSentinel,
      vaultNameSentinel,
      'DRIVE_ONLY_NAME_MUST_NOT_EXPORT',
      'FOREIGN_VAULT_NAME_MUST_NOT_EXPORT',
      'Drive identity must not export',
      'LOCKED_CASH_SOURCE_MUST_NOT_EXPORT',
      'LOCKED_TRANSACTION_MUST_NOT_EXPORT',
      'LOCKED_DIVIDEND_MUST_NOT_EXPORT',
      'LOCKED_CASH_MOVEMENT_MUST_NOT_EXPORT',
      'LOCKED_SETTING_MUST_NOT_EXPORT',
    ]) {
      expect(archiveText).not.toContain(forbidden);
    }
    expect(manifestRaw).not.toContain('retirementProofPublicKey');
    expect(manifestRaw).not.toContain('keyFingerprint');
    expect(manifestRaw).not.toContain('headerDocId');
    expect(manifestRaw).not.toContain('commonDocId');
  });

  it('exports only server-classified data plus the current opaque server vault', async () => {
    const user = await harness.seedUser();
    const blob = Buffer.from([0, 1, 2, 3, 255, 42]);
    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['server'],
        paranoidDriveAttestedVersion: null,
      })
      .where(eq(schema.users.id, user.id));
    await harness.db.insert(schema.paranoidVaults).values({
      userId: user.id,
      version: 7,
      formatVersion: 1,
      sizeBytes: blob.byteLength,
      blob,
    });
    const agent = await loginAgent(harness.app, user.email, user.password);
    const requested = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    const { downloadToken } = exportRequestResponseSchema.parse(requested.body);
    const downloaded = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken })
      .responseType('blob');
    expect(downloaded.status).toBe(200);

    const files = unzipSync(new Uint8Array(downloaded.body as Buffer));
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as {
      entities: Record<string, number>;
      csv: string[];
      paranoidVault: Record<string, unknown>;
    };
    expect(Object.keys(manifest.entities).sort()).toEqual([
      ...PARANOID_SERVER_EXPORTED_ENTITY_NAMES,
    ]);
    expect(manifest.csv).toEqual([]);
    expect(manifest.paranoidVault).toMatchObject({
      mediaSet: ['server'],
      included: true,
      file: 'paranoid/current-vault.btvault',
      version: 7,
      formatVersion: 1,
      sizeBytes: blob.byteLength,
    });
    expect(Buffer.from(files['paranoid/current-vault.btvault']!)).toEqual(blob);
    expect(files['data/portfolios.json']).toBeUndefined();
    expect(files['csv/transactions.csv']).toBeUndefined();
    expect(strFromU8(files['README.txt']!)).toContain('client-encrypted vault');
  });

  it('exports no blob and no cleartext portfolio files for Drive-only accounts', async () => {
    const user = await harness.seedUser();
    await harness.db
      .update(schema.users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 3,
      })
      .where(eq(schema.users.id, user.id));
    const agent = await loginAgent(harness.app, user.email, user.password);
    const requested = await agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password });
    const { downloadToken } = exportRequestResponseSchema.parse(requested.body);
    const downloaded = await agent
      .post('/api/v1/account/export/download')
      .set(...XRW)
      .send({ token: downloadToken })
      .responseType('blob');
    const files = unzipSync(new Uint8Array(downloaded.body as Buffer));
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as {
      paranoidVault: Record<string, unknown>;
    };
    expect(manifest.paranoidVault).toMatchObject({
      mediaSet: ['drive'],
      included: false,
    });
    expect(files['paranoid/current-vault.btvault']).toBeUndefined();
    expect(files['data/portfolios.json']).toBeUndefined();
    expect(files['csv/transactions.csv']).toBeUndefined();
  });

  it('serializes a normal build with enable and retires the cleartext archive before commit', async () => {
    let collectionReached!: () => void;
    let releaseCollection!: () => void;
    const reached = new Promise<void>((resolve) => {
      collectionReached = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCollection = resolve;
    });
    harness = await createTestApp({
      env: { BT_EXPORT_DIR: EXPORT_DIR },
      exportAfterCollect: async () => {
        collectionReached();
        await release;
      },
    });
    const user = await harness.seedUser();
    await seedPortfolio(user.id, 'Cleartext portfolio');
    const blob = Buffer.from('opaque transition vault');
    await harness.db.insert(schema.paranoidVaults).values({
      userId: user.id,
      version: 1,
      formatVersion: 1,
      sizeBytes: blob.byteLength,
      blob,
    });
    const agent = await loginAgent(harness.app, user.email, user.password);

    const exportPromise = agent
      .post('/api/v1/account/export')
      .set(...XRW)
      .send({ password: user.password })
      .then((response) => response);
    await reached;
    const { revision } = await harness.ctx.paranoidTransitions.normalDataRevision(user.id);
    const enablePromise = harness.ctx.paranoidTransitions.enable(user.id, {
      mediaSet: ['server'],
      vaultVersion: 1,
      driveAttestation: null,
      normalDataRevision: revision,
    });
    releaseCollection();
    const [exportResponse, enabled] = await Promise.all([exportPromise, enablePromise]);
    expect(exportResponse.status).toBe(200);
    expect(enabled.mode).toBe('paranoid');
    const { jobId } = exportRequestResponseSchema.parse(exportResponse.body);
    const expectedPath = joinPath(EXPORT_DIR, `${jobId}.zip`);
    expect(existsSync(expectedPath)).toBe(false);
    const [job] = await harness.db
      .select()
      .from(schema.exportJobs)
      .where(eq(schema.exportJobs.id, jobId));
    expect(job).toMatchObject({
      status: 'failed',
      filePath: null,
      fileSize: null,
      error: 'RETIRED_FOR_PARANOID_MODE',
      downloadTokenHash: null,
    });
  });
});
