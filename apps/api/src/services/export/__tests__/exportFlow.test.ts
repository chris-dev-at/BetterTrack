import { tmpdir } from 'node:os';
import { dirname, join as joinPath } from 'node:path';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';

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
    const enablePromise = harness.ctx.paranoidTransitions.enable(user.id, {
      mediaSet: ['server'],
      vaultVersion: 1,
      driveAttestation: null,
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
