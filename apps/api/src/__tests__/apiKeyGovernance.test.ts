import { eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  adminApiKeyListResponseSchema,
  apiKeyAuditResponseSchema,
  apiKeyTierListResponseSchema,
  apiKeyTierSchema,
} from '@bettertrack/contracts';

import { apiKeyRequestLog, apiKeyTiers, portfolios, users, vaults } from '../data/schema';
import { createApiKeyRequestLogRepository } from '../data/repositories/apiKeyRequestLogRepository';
import { API_KEY_LIMITER_NAMESPACE } from '../http/middleware/rateLimit';
import { createApiKeyService } from '../services/apiKeys/apiKeyService';
import { createProgressiveLimiter, progressiveKeys } from '../services/security/progressiveLimiter';
import { API_KEY_REQUEST_LOG_RETENTION_DAYS, createApiKeyRequestLogCleanupJob } from '../jobs';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const RESOURCE_ASSET_ID = '018f0000-0000-7000-8000-000000001345';

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
    const repo = createApiKeyRequestLogRepository(harness.db, harness.db);
    let rows = await repo.listForKey(keyId, 50);
    for (let i = 0; i < 40 && rows.length < 2; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      rows = await repo.listForKey(keyId, 50);
    }
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.status === 403)).toBe(true);
  });

  it('keeps the concrete resource path for a normal account', async () => {
    const { token, keyId } = await mintKey(['portfolio:read']);
    const path = `/assets/${RESOURCE_ASSET_ID}/quote`;

    await request(harness.app).get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

    const repo = createApiKeyRequestLogRepository(harness.db, harness.db);
    let rows = await repo.listForKey(keyId, 10);
    for (let i = 0; i < 40 && rows.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      rows = await repo.listForKey(keyId, 10);
    }
    expect(rows[0]?.path).toBe(path);
  });

  it('suppresses request-log capture for a paranoid account', async () => {
    const { userId, keyId } = await mintKey(['portfolio:read']);
    await harness.db
      .update(users)
      .set({
        privacyMode: 'paranoid',
        paranoidMediaSet: ['drive'],
        paranoidDriveAttestedVersion: 1,
      })
      .where(eq(users.id, userId));

    await harness.ctx.apiKeys.recordRequest({
      keyId,
      userId,
      method: 'GET',
      path: `/assets/${RESOURCE_ASSET_ID}/quote`,
      status: 200,
    });

    const repo = createApiKeyRequestLogRepository(harness.db, harness.db);
    const rows = await repo.listForKey(keyId, 10);
    expect(rows).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain(RESOURCE_ASSET_ID);
  });

  it('suppresses vaulted targets and unattributed market-read ids but records a plain sibling', async () => {
    const { userId, token, keyId } = await mintKey(['portfolio:read', 'market:read']);
    const lockedId = await harness.ctx.portfolio.getDefaultPortfolioId(userId);
    const sibling = await harness.ctx.portfolio.createPortfolio(userId, { name: 'Audit sibling' });

    // TEST VECTOR: identity/config-only vault metadata. The request log must
    // retain neither the stub UUID nor quote-driven holdings identifiers.
    const vaultId = '018f0000-0000-7000-8000-000000001346';
    await harness.db.insert(vaults).values({
      id: vaultId,
      userId,
      name: 'Audit boundary',
      headerDocId: '018f0000-0000-7000-8000-000000001347',
      commonDocId: '018f0000-0000-7000-8000-000000001348',
      media: ['server'],
      driveConnectionId: null,
      retirementProofPublicKey: 'deterministic-audit-public-proof',
      keyFingerprint: 'deterministic-audit-fingerprint',
    });
    await harness.db.update(portfolios).set({ vaultId }).where(eq(portfolios.id, lockedId));

    await harness.ctx.apiKeys.recordRequest({
      keyId,
      userId,
      method: 'GET',
      path: `/portfolios/${lockedId}`,
      status: 403,
      targetPortfolioId: lockedId,
    });
    await harness.ctx.apiKeys.recordRequest({
      keyId,
      userId,
      method: 'GET',
      path: `/portfolios/${sibling.id}`,
      status: 200,
      targetPortfolioId: sibling.id,
    });
    await harness.ctx.apiKeys.recordRequest({
      keyId,
      userId,
      method: 'GET',
      path: `/assets/${RESOURCE_ASSET_ID}/quote`,
      status: 200,
      suppressIfAnyVault: true,
    });

    // Exercise the HTTP classifier shared with usage capture: quote, history,
    // and the vault client engine's daily-close lookup are all roster-bearing.
    await request(harness.app)
      .get(`/api/v1/assets/${RESOURCE_ASSET_ID}/quote`)
      .set('Authorization', `Bearer ${token}`);
    await request(harness.app)
      .get(`/api/v1/assets/${RESOURCE_ASSET_ID}/daily-closes`)
      .set('Authorization', `Bearer ${token}`);
    await request(harness.app)
      .get(`/api/v1/assets/${RESOURCE_ASSET_ID}/history?range=1M`)
      .set('Authorization', `Bearer ${token}`);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const rows = await createApiKeyRequestLogRepository(harness.db, harness.db).listForKey(
      keyId,
      10,
    );
    expect(rows.map((row) => row.path)).toEqual([`/portfolios/${sibling.id}`]);
    expect(JSON.stringify(rows)).not.toContain(lockedId);
    expect(JSON.stringify(rows)).not.toContain(RESOURCE_ASSET_ID);
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
      requestLog: createApiKeyRequestLogRepository(harness.db, harness.db),
    });
    await job.handler({} as never, { logger: harness.ctx.logger } as never);

    const repo = createApiKeyRequestLogRepository(harness.db, harness.db);
    const remaining = await repo.listForKey(keyId, 50);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.path).toBe('/fresh');
  });

  it('drains more rows than one batch holds without an unbounded delete', async () => {
    // This is the highest-volume table in the app — one row per bearer request —
    // so the sweep must converge in bounded statements, not one range delete.
    const { userId, keyId } = await mintKey();
    const dayMs = 24 * 60 * 60 * 1000;
    const expired = Date.now() - (API_KEY_REQUEST_LOG_RETENTION_DAYS + 2) * dayMs;

    await harness.db.insert(apiKeyRequestLog).values([
      ...Array.from({ length: 5 }, (_row, index) => ({
        keyId,
        userId,
        method: 'GET',
        path: `/old/${index}`,
        status: 200,
        createdAt: new Date(expired + index * 1000),
      })),
      { keyId, userId, method: 'GET', path: '/fresh', status: 200, createdAt: new Date() },
    ]);

    const requestLog = createApiKeyRequestLogRepository(harness.db, harness.db);
    const deleteOlderThan = vi.spyOn(requestLog, 'deleteOlderThan');
    const job = createApiKeyRequestLogCleanupJob({ requestLog, batchSize: 2 });
    await job.handler({} as never, { logger: harness.ctx.logger } as never);

    // 2 + 2 + the short batch that proves the cutoff is drained.
    expect(deleteOlderThan.mock.calls.map(([, limit]) => limit)).toEqual([2, 2, 2]);
    const remaining = await requestLog.listForKey(keyId, 50);
    expect(remaining.map((row) => row.path)).toEqual(['/fresh']);
  });

  it('defers rows past the per-run ceiling to the next run', async () => {
    const { userId, keyId } = await mintKey();
    const dayMs = 24 * 60 * 60 * 1000;
    const expired = Date.now() - (API_KEY_REQUEST_LOG_RETENTION_DAYS + 2) * dayMs;

    await harness.db.insert(apiKeyRequestLog).values(
      Array.from({ length: 5 }, (_row, index) => ({
        keyId,
        userId,
        method: 'GET',
        path: `/old/${index}`,
        status: 200,
        createdAt: new Date(expired + index * 1000),
      })),
    );

    const requestLog = createApiKeyRequestLogRepository(harness.db, harness.db);
    const job = createApiKeyRequestLogCleanupJob({ requestLog, batchSize: 2, maxRowsPerRun: 2 });

    await job.handler({} as never, { logger: harness.ctx.logger } as never);
    // The ceiling stops this run; the remaining rows are still eligible.
    expect(await requestLog.listForKey(keyId, 50)).toHaveLength(3);

    await job.handler({} as never, { logger: harness.ctx.logger } as never);
    await job.handler({} as never, { logger: harness.ctx.logger } as never);
    expect(await requestLog.listForKey(keyId, 50)).toHaveLength(0);
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

/**
 * #1730 — a tier change that does not clear the key's LIVE limiter state is not
 * a tier change the key can feel: `consume` short-circuits on the cooldown
 * marker before it ever reads the limit, and the escalation level outlives the
 * cooldown by its decay window.
 */
describe('#1730 an admin tier change takes effect on the very next request', () => {
  /** Put a key deep in the penalty box: rung-3 cooldown, live level, full window. */
  async function arm(keyId: string): Promise<ReturnType<typeof progressiveKeys>> {
    const keys = progressiveKeys(API_KEY_LIMITER_NAMESPACE, keyId);
    await harness.ctx.redis.set(keys.cooldown, '1', 'EX', 600);
    await harness.ctx.redis.set(keys.count, '999', 'EX', 60);
    await harness.ctx.redis.set(keys.level, '3', 'EX', 900);
    return keys;
  }

  it('raising a mid-cooldown key’s tier admits its next request at rung 0', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const { keyId } = await mintKey();
    const tier = apiKeyTierSchema.parse(
      (
        await agent
          .post('/api/v1/admin/api-key-tiers')
          .set(...XRW)
          .send({ name: 'Bulk', requestLimit: 5000, windowSec: 60 })
      ).body,
    );

    const keys = await arm(keyId);
    const assigned = await agent
      .patch(`/api/v1/admin/api-keys/${keyId}/tier`)
      .set(...XRW)
      .send({ tierId: tier.id });
    expect(assigned.status).toBe(200);

    expect(await harness.ctx.redis.get(keys.cooldown)).toBeNull();
    expect(await harness.ctx.redis.get(keys.count)).toBeNull();
    expect(await harness.ctx.redis.get(keys.level)).toBeNull();

    // The real limiter, on the freshly-assigned tier: admitted, and the next
    // overflow would start at rung 0 rather than jumping one.
    const limiter = createProgressiveLimiter(harness.ctx.redis, API_KEY_LIMITER_NAMESPACE, {
      windowSec: 60,
      limit: 5000,
      cooldownsSec: [60, 300, 600],
      decaySec: 900,
    });
    const decision = await limiter.consume(keyId);
    expect(decision.allowed).toBe(true);
    expect(decision.level).toBe(0);
  });

  it('clearing a key’s tier back to the default clears its cooldown too', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const { keyId } = await mintKey();
    const keys = await arm(keyId);

    const cleared = await agent
      .patch(`/api/v1/admin/api-keys/${keyId}/tier`)
      .set(...XRW)
      .send({ tierId: null });
    expect(cleared.status).toBe(200);
    expect(await harness.ctx.redis.get(keys.cooldown)).toBeNull();
  });

  it('editing a tier’s budget clears the keys on it, and its inheritors once it is default', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    // Two keys of the SAME user: one assigned to the edited tier, one left on
    // whatever tier is currently the default.
    const user = await harness.seedUser();
    const onTier = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'assigned key',
      scopes: ['portfolio:read'] as never,
    });
    const untiered = await harness.ctx.apiKeys.create({
      userId: user.id,
      name: 'inheriting key',
      scopes: ['portfolio:read'] as never,
    });
    const tier = apiKeyTierSchema.parse(
      (
        await agent
          .post('/api/v1/admin/api-key-tiers')
          .set(...XRW)
          .send({ name: 'Pro', requestLimit: 600, windowSec: 60 })
      ).body,
    );
    await agent
      .patch(`/api/v1/admin/api-keys/${onTier.key.id}/tier`)
      .set(...XRW)
      .send({ tierId: tier.id });

    const assignedKeys = await arm(onTier.key.id);
    const inheritingKeys = await arm(untiered.key.id);

    // A budget edit on a non-default tier reaches only the keys assigned to it.
    const raised = await agent
      .patch(`/api/v1/admin/api-key-tiers/${tier.id}`)
      .set(...XRW)
      .send({ requestLimit: 900 });
    expect(raised.status).toBe(200);
    expect(await harness.ctx.redis.get(assignedKeys.cooldown)).toBeNull();
    expect(await harness.ctx.redis.get(inheritingKeys.cooldown)).toBe('1');

    // Marking it default moves the untiered keys onto this allowance, so they
    // are cleared too.
    const promoted = await agent
      .patch(`/api/v1/admin/api-key-tiers/${tier.id}`)
      .set(...XRW)
      .send({ isDefault: true });
    expect(promoted.status).toBe(200);
    expect(await harness.ctx.redis.get(inheritingKeys.cooldown)).toBeNull();
  });

  // #1835 — the three sibling paths that change a key's effective budget without
  // touching the key itself: deleting its tier, creating a new default tier, and
  // flipping the current default off.
  it('deleting a tier releases the keys it held from the old cooldown', async () => {
    // Full HTTP stack with the real limiter: drive a genuine cooldown under a
    // tight tier, delete the tier, and the very next request must be served.
    const httpHarness = await createTestApp({ rateLimitsEnabled: true });
    const admin = await httpHarness.seedAdmin();
    const agent = await httpHarness.loginAdmin(admin);
    const user = await httpHarness.seedUser();
    const { key, token } = await httpHarness.ctx.apiKeys.create({
      userId: user.id,
      name: 'tight key',
      scopes: ['portfolio:read'],
    });
    const tier = apiKeyTierSchema.parse(
      (
        await agent
          .post('/api/v1/admin/api-key-tiers')
          .set(...XRW)
          .send({ name: 'Tight', requestLimit: 2, windowSec: 60 })
      ).body,
    );
    await agent
      .patch(`/api/v1/admin/api-keys/${key.id}/tier`)
      .set(...XRW)
      .send({ tierId: tier.id });

    const hit = () =>
      request(httpHarness.app).get('/api/v1/portfolios').set('Authorization', `Bearer ${token}`);
    for (let i = 0; i < 2; i += 1) {
      expect((await hit()).status).toBe(200);
    }
    expect((await hit()).status).toBe(429);

    const removed = await agent.delete(`/api/v1/admin/api-key-tiers/${tier.id}`).set(...XRW);
    expect(removed.status).toBe(204);

    // `tier_id` is ON DELETE SET NULL, so the key now falls back to the 120/60
    // default — cooldown, window counter and escalation rung all released.
    const keys = progressiveKeys(API_KEY_LIMITER_NAMESPACE, key.id);
    expect(await httpHarness.ctx.redis.get(keys.cooldown)).toBeNull();
    expect(await httpHarness.ctx.redis.get(keys.count)).toBeNull();
    expect(await httpHarness.ctx.redis.get(keys.level)).toBeNull();
    expect((await hit()).status).toBe(200);
  });

  it('creating a new default tier clears the untiered keys it just re-homed', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const { keyId } = await mintKey();
    const keys = await arm(keyId);

    // A non-default tier starts empty and re-homes nobody: it clears nothing.
    const sideways = await agent
      .post('/api/v1/admin/api-key-tiers')
      .set(...XRW)
      .send({ name: 'Side', requestLimit: 5000, windowSec: 60 });
    expect(sideways.status).toBe(201);
    expect(await harness.ctx.redis.get(keys.cooldown)).toBe('1');

    // Creating one AS the default demotes the previous default, moving every
    // untiered key onto the new allowance.
    const created = await agent
      .post('/api/v1/admin/api-key-tiers')
      .set(...XRW)
      .send({ name: 'Wide', requestLimit: 5000, windowSec: 60, isDefault: true });
    expect(created.status).toBe(201);
    expect(await harness.ctx.redis.get(keys.cooldown)).toBeNull();
    expect(await harness.ctx.redis.get(keys.count)).toBeNull();
    expect(await harness.ctx.redis.get(keys.level)).toBeNull();

    // The rung went with the cooldown: the next overflow starts at the bottom.
    const limiter = createProgressiveLimiter(harness.ctx.redis, API_KEY_LIMITER_NAMESPACE, {
      windowSec: 60,
      limit: 5000,
      cooldownsSec: [60, 300, 600],
      decaySec: 900,
    });
    const decision = await limiter.consume(keyId);
    expect(decision.allowed).toBe(true);
    expect(decision.level).toBe(0);

    // Exactly one default survives the create.
    const list = apiKeyTierListResponseSchema.parse(
      (await agent.get('/api/v1/admin/api-key-tiers')).body,
    );
    expect(list.tiers.filter((t) => t.isDefault)).toHaveLength(1);
  });

  it('flipping a tier off default clears the keys that stop inheriting it', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const { keyId, token } = await mintKey();
    const tier = apiKeyTierSchema.parse(
      (
        await agent
          .post('/api/v1/admin/api-key-tiers')
          .set(...XRW)
          .send({ name: 'Wide', requestLimit: 5000, windowSec: 60, isDefault: true })
      ).body,
    );
    expect((await harness.ctx.apiKeys.authenticate(token))?.rateLimit).toEqual({
      limit: 5000,
      windowSec: 60,
    });

    const keys = await arm(keyId);
    const demoted = await agent
      .patch(`/api/v1/admin/api-key-tiers/${tier.id}`)
      .set(...XRW)
      .send({ isDefault: false });
    expect(demoted.status).toBe(200);
    expect(apiKeyTierSchema.parse(demoted.body).isDefault).toBe(false);

    expect(await harness.ctx.redis.get(keys.cooldown)).toBeNull();
    expect(await harness.ctx.redis.get(keys.count)).toBeNull();
    expect(await harness.ctx.redis.get(keys.level)).toBeNull();

    // No default row resolves any more, so the key's next request is measured
    // against the config fallback — the allowance it now actually falls under.
    expect((await harness.ctx.apiKeys.authenticate(token))?.rateLimit).toEqual({
      limit: 120,
      windowSec: 60,
    });
    const list = apiKeyTierListResponseSchema.parse(
      (await agent.get('/api/v1/admin/api-key-tiers')).body,
    );
    expect(list.tiers.filter((t) => t.isDefault)).toHaveLength(0);
  });

  it('a rename changes no budget, so it never clears a live cooldown', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    const { keyId } = await mintKey();
    const tier = apiKeyTierSchema.parse(
      (
        await agent
          .post('/api/v1/admin/api-key-tiers')
          .set(...XRW)
          .send({ name: 'Pro', requestLimit: 600, windowSec: 60 })
      ).body,
    );
    await agent
      .patch(`/api/v1/admin/api-keys/${keyId}/tier`)
      .set(...XRW)
      .send({ tierId: tier.id });
    const keys = await arm(keyId);

    const renamed = await agent
      .patch(`/api/v1/admin/api-key-tiers/${tier.id}`)
      .set(...XRW)
      .send({ name: 'Pro plan' });
    expect(renamed.status).toBe(200);
    expect(await harness.ctx.redis.get(keys.cooldown)).toBe('1');
  });
});
