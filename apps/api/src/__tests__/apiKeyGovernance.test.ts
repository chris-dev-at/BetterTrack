import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  adminApiKeyListResponseSchema,
  apiKeyAuditResponseSchema,
  apiKeyTierListResponseSchema,
  apiKeyTierSchema,
} from '@bettertrack/contracts';

import { apiKeyRequestLog, apiKeyTiers } from '../data/schema';
import { createApiKeyRequestLogRepository } from '../data/repositories/apiKeyRequestLogRepository';
import { createApiKeyService } from '../services/apiKeys/apiKeyService';
import { API_KEY_REQUEST_LOG_RETENTION_DAYS, createApiKeyRequestLogCleanupJob } from '../jobs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/** Mint a personal key straight through the service (no HTTP round trip). */
async function mintKey(
  scopes: string[] = ['portfolio:read'],
): Promise<{ userId: string; token: string; keyId: string }> {
  const user = await harness.seedUser();
  const { key, token } = await harness.ctx.apiKeys.create({
    userId: user.id,
    name: 'gov key',
    scopes: scopes as never,
  });
  return { userId: user.id, token, keyId: key.id };
}

describe('admin API-key rate tiers (§13.5 V5-P10, issue 2/2)', () => {
  it('resolves the sane default allowance for an unassigned key (existing keys unchanged)', async () => {
    // A brand-new key with no explicit tier resolves the default allowance
    // (config fallback = the seeded default's 120/60), so a key minted before
    // tiers existed keeps working unchanged.
    const { token } = await mintKey();
    const principal = await harness.ctx.apiKeys.authenticate(token);
    expect(principal?.rateLimit).toEqual({ limit: 120, windowSec: 60 });
  });

  it('lets an admin define, edit and delete tiers (name/limit/window)', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const created = await agent
      .post('/api/v1/admin/api-key-tiers')
      .set(...XRW)
      .send({ name: 'Pro', requestLimit: 600, windowSec: 60 });
    expect(created.status).toBe(201);
    const tier = apiKeyTierSchema.parse(created.body);
    expect(tier.name).toBe('Pro');
    expect(tier.isDefault).toBe(false);

    const edited = await agent
      .patch(`/api/v1/admin/api-key-tiers/${tier.id}`)
      .set(...XRW)
      .send({ requestLimit: 900 });
    expect(edited.status).toBe(200);
    expect(apiKeyTierSchema.parse(edited.body).requestLimit).toBe(900);

    const removed = await agent.delete(`/api/v1/admin/api-key-tiers/${tier.id}`).set(...XRW);
    expect(removed.status).toBe(204);

    const rows = await harness.db.select().from(apiKeyTiers).where(eq(apiKeyTiers.id, tier.id));
    expect(rows).toHaveLength(0);
  });

  it('keeps exactly one default when a new default is marked, and refuses to delete it', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const created = await agent
      .post('/api/v1/admin/api-key-tiers')
      .set(...XRW)
      .send({ name: 'Bulk', requestLimit: 5000, windowSec: 60, isDefault: true });
    const bulk = apiKeyTierSchema.parse(created.body);
    expect(bulk.isDefault).toBe(true);

    const list = apiKeyTierListResponseSchema.parse(
      (await agent.get('/api/v1/admin/api-key-tiers')).body,
    );
    expect(list.tiers.filter((t) => t.isDefault)).toHaveLength(1);
    expect(list.tiers.find((t) => t.isDefault)!.id).toBe(bulk.id);

    const refuse = await agent.delete(`/api/v1/admin/api-key-tiers/${bulk.id}`).set(...XRW);
    expect(refuse.status).toBe(400);
  });

  it('assigns a key to a tier and the principal resolves that tier', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const { token, keyId } = await mintKey();

    const tier = apiKeyTierSchema.parse(
      (
        await agent
          .post('/api/v1/admin/api-key-tiers')
          .set(...XRW)
          .send({ name: 'Slow', requestLimit: 10, windowSec: 30 })
      ).body,
    );

    const assigned = await agent
      .patch(`/api/v1/admin/api-keys/${keyId}/tier`)
      .set(...XRW)
      .send({ tierId: tier.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.tierId).toBe(tier.id);
    expect(assigned.body.tierName).toBe('Slow');

    const principal = await harness.ctx.apiKeys.authenticate(token);
    expect(principal?.rateLimit).toEqual({ limit: 10, windowSec: 30 });

    // Clearing the tier (null) re-homes the key onto the default.
    const cleared = await agent
      .patch(`/api/v1/admin/api-keys/${keyId}/tier`)
      .set(...XRW)
      .send({ tierId: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.tierId).toBeNull();
  });

  it('lists every user’s keys on the admin governance surface', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const { keyId } = await mintKey();

    const res = await agent.get('/api/v1/admin/api-keys');
    expect(res.status).toBe(200);
    const { keys } = adminApiKeyListResponseSchema.parse(res.body);
    expect(keys.some((k) => k.id === keyId)).toBe(true);
  });

  it('is a no-leak 404 to non-admin callers', async () => {
    const user = await harness.seedUser();
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    const res = await agent.get('/api/v1/admin/api-key-tiers');
    expect(res.status).toBe(404);
  });
});

describe('per-key request-log audit trail (§13.5 V5-P10, issue 2/2)', () => {
  it('captures a PII-scrubbed request line the audit view returns', async () => {
    const { userId, keyId } = await mintKey();
    await harness.ctx.apiKeys.recordRequest({
      keyId,
      userId,
      method: 'GET',
      // A token that slipped into the path must be scrubbed before storage.
      path: '/portfolios?token=btk_secretsecretsecret',
      status: 200,
    });

    const [row] = await harness.db
      .select()
      .from(apiKeyRequestLog)
      .where(eq(apiKeyRequestLog.keyId, keyId));
    expect(row).toBeDefined();
    expect(row!.path).not.toContain('btk_secretsecretsecret');
    expect(row!.path).toContain('[redacted-token]');

    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const res = await agent.get(`/api/v1/admin/api-keys/${keyId}/audit`);
    expect(res.status).toBe(200);
    const audit = apiKeyAuditResponseSchema.parse(res.body);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]!.status).toBe(200);
    expect(audit.entries[0]!.path).toContain('[redacted-token]');
  });

  it('captures one line per personal-key request end-to-end (including denied)', async () => {
    const { token, keyId } = await mintKey(['portfolio:read']);

    // A read the key is allowed to make…
    await request(harness.app).get('/api/v1/portfolios').set('Authorization', `Bearer ${token}`);
    // …and a write it is NOT scoped for (403) — still recorded.
    await request(harness.app)
      .post('/api/v1/portfolios')
      .set('Authorization', `Bearer ${token}`)
      .set(...XRW)
      .send({ name: 'x', baseCurrency: 'EUR' });

    // The capture is fire-and-forget on `finish`; poll briefly for the rows.
    const repo = createApiKeyRequestLogRepository(harness.db);
    let rows = await repo.listForKey(keyId, 50);
    for (let i = 0; i < 40 && rows.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      rows = await repo.listForKey(keyId, 50);
    }
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.status === 403)).toBe(true);
  });

  it('never lets a log-write failure surface — recordRequest swallows repo errors', async () => {
    const failingLog = {
      record: async () => {
        throw new Error('db down');
      },
    };
    const warnings: unknown[] = [];
    const service = createApiKeyService({
      repo: {} as never,
      tierRepo: {} as never,
      requestLogRepo: failingLog as never,
      audit: {} as never,
      redis: {} as never,
      logger: { warn: (obj: unknown) => warnings.push(obj) } as never,
      defaultRateLimit: { limit: 120, windowSec: 60 },
    });

    await expect(
      service.recordRequest({ keyId: 'k', userId: 'u', method: 'GET', path: '/x', status: 200 }),
    ).resolves.toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it('prunes request-log rows older than the retention window (cleanup job)', async () => {
    const { userId, keyId } = await mintKey();
    const dayMs = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - (API_KEY_REQUEST_LOG_RETENTION_DAYS + 2) * dayMs);
    const fresh = new Date();

    await harness.db.insert(apiKeyRequestLog).values([
      { keyId, userId, method: 'GET', path: '/old', status: 200, createdAt: old },
      { keyId, userId, method: 'GET', path: '/fresh', status: 200, createdAt: fresh },
    ]);

    const job = createApiKeyRequestLogCleanupJob({
      requestLog: createApiKeyRequestLogRepository(harness.db),
    });
    await job.handler({} as never, { logger: harness.ctx.logger } as never);

    const repo = createApiKeyRequestLogRepository(harness.db);
    const remaining = await repo.listForKey(keyId, 50);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.path).toBe('/fresh');
  });
});

describe('per-key rate tier — full HTTP stack (§13.5 V5-P10, issue 2/2)', () => {
  // Regression fence for the bearerAuth → rateLimit wiring: the earlier unit
  // test in `http/middleware/__tests__/apiKeyTierRateLimit.test.ts` synthesises
  // `req.apiKey.rateLimit` before invoking the limiter, so it cannot catch the
  // bearerAuth handler dropping the resolved tier on the floor. This test hits
  // the app with a real `Authorization: Bearer …` header and asserts a low-tier
  // key gets 429 back — the done-when clause for tier assignment.
  it('a low-tier key over its limit gets a 429 back over the wire', async () => {
    // Fresh harness with the HTTP limiter actually enabled (default is off in
    // test mode). Also swap NODE_ENV isn't necessary — the option flips the
    // one flag the limiter reads, leaving BullMQ + logger unchanged.
    const httpHarness = await createTestApp({ rateLimitsEnabled: true });

    const user = await httpHarness.seedUser();
    const { key, token } = await httpHarness.ctx.apiKeys.create({
      userId: user.id,
      name: 'wire test',
      scopes: ['portfolio:read'],
    });

    const actor = { id: user.id, ip: null };
    const tier = await httpHarness.ctx.apiKeys.createTier(
      { name: 'Trickle', requestLimit: 2, windowSec: 60 },
      actor,
    );
    await httpHarness.ctx.apiKeys.assignTier(key.id, tier.id, actor);

    const hit = () =>
      request(httpHarness.app).get('/api/v1/portfolios').set('Authorization', `Bearer ${token}`);

    // First two requests fit within the tier's allowance.
    for (let i = 0; i < 2; i += 1) {
      const res = await hit();
      expect(res.status).toBe(200);
    }
    // The third trips the per-key limiter — 429 with a Retry-After header, and
    // NOT because the general/burst counters (4500/15m, 60/10s) tripped.
    const over = await hit();
    expect(over.status).toBe(429);
    expect(over.headers['retry-after']).toBeDefined();
  });
});
