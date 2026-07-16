import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { existsSync } from 'node:fs';

import { unzipSync, strFromU8 } from 'fflate';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { exportRequestResponseSchema, exportStatusResponseSchema } from '@bettertrack/contracts';

import * as schema from '../../../data/schema';
import { hashToken } from '../../crypto/tokens';
import { collectUserExport } from '../collector';
import { EXPORTED_ENTITY_NAMES } from '../manifest';
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

    // Download with the held token: a valid zip with JSON per entity + CSVs.
    const dl = await agent
      .get(`/api/v1/account/export/download?token=${encodeURIComponent(downloadToken)}`)
      .responseType('blob');
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
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
      .get(`/api/v1/account/export/download?token=${encodeURIComponent(downloadToken)}`)
      .responseType('blob');
    const files = unzipText(dl.body as Buffer);
    const ids = (JSON.parse(files['data/portfolios.json']!) as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(aliceP);
    expect(ids).not.toContain(bobP);
  });

  it('the collector produces exactly the classified entity set', async () => {
    const user = await harness.seedUser();
    const collected = await collectUserExport(harness.db, user.id);
    expect(Object.keys(collected.entities).sort()).toEqual([...EXPORTED_ENTITY_NAMES]);
    // The account entity always carries the user's own (sanitized) row, with no
    // password hash leaked.
    const account = collected.entities.account as Record<string, unknown>[];
    expect(account.length).toBe(1);
    expect(account[0]).not.toHaveProperty('passwordHash');
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
      .get(`/api/v1/account/export/download?token=${encodeURIComponent(downloadToken)}`)
      .responseType('blob');
    expect(foreign.status).toBe(404);

    // Expire Alice's window → her own valid token now 404s.
    await harness.db
      .update(schema.exportJobs)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.exportJobs.id, jobId));
    const expired = await aliceAgent
      .get(`/api/v1/account/export/download?token=${encodeURIComponent(downloadToken)}`)
      .responseType('blob');
    expect(expired.status).toBe(404);
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
});
