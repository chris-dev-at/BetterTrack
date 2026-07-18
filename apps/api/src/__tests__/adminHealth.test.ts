import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminHealthResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Admin health page + queue inspector (PROJECTPLAN.md §13.4 V4-P5a).
 *
 * Covers the operator diagnostics surface `GET /api/v1/admin/health` (the richer,
 * admin-only companion to the public `/health` probe) and the admin-only
 * bull-board mount's no-leak 404 for non-admins.
 */
describe('admin health + queue inspector', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the contracts-typed status set for an authenticated admin', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    const res = await agent.get('/api/v1/admin/health');
    expect(res.status).toBe(200);

    // Round-trips the shared contract schema (the route parses before responding).
    const body = adminHealthResponseSchema.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.version).toBeTruthy();
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(body.components.database.status).toBe('ok');
    expect(body.components.redis.status).toBe('ok');
    // The stub market data registers no upstream breakers under test.
    expect(body.components.providers.status).toBe('ok');
    // No secondary configured under the stub ⇒ empty failover attribution (§13.5 V5-P1c).
    expect(body.components.providers.chains).toEqual([]);
    expect(body.components.providers.switches).toEqual([]);
    expect(body.components.providers.attribution).toEqual([]);
    // The test process holds no BullMQ registry (ioredis-mock).
    expect(body.components.queues.available).toBe(false);
    expect(body.components.gateway.status).toBe('ok');
  });

  it('reflects a stopped Redis as degraded (redis component down, overall degraded)', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    // Simulate Redis being unreachable: the health probe pings it live, so the
    // next request reflects the outage immediately (well within the 30 s bar).
    vi.spyOn(harness.ctx.redis, 'ping').mockRejectedValue(new Error('connection refused'));

    const res = await agent.get('/api/v1/admin/health');
    expect(res.status).toBe(200);
    const body = adminHealthResponseSchema.parse(res.body);
    expect(body.components.redis.status).toBe('down');
    expect(body.status).toBe('degraded');
    // The database is still up, so it is not a hard `down`.
    expect(body.components.database.status).toBe('ok');
  });

  it('404s the queue inspector for anonymous and user-kind callers (no leak), not for admins', async () => {
    // Anonymous → 404 (requireAdmin, §6.12 no information leak).
    const anon = await request(harness.app).get('/api/v1/admin/queues');
    expect(anon.status).toBe(404);

    // User-kind session → 404 too.
    const user = await harness.seedUser({ email: 'plain@test.dev', username: 'plain_user' });
    const userAgent = request.agent(harness.app);
    const userLogin = await userAgent
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'BetterTrack')
      .send({ identifier: user.email, password: user.password });
    expect(userLogin.status).toBe(200);
    const userRes = await userAgent.get('/api/v1/admin/queues');
    expect(userRes.status).toBe(404);

    // Admin session → reaches the mount (503 here because the test process holds
    // no live queue registry); crucially NOT a 404, proving the guard admits it.
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const adminRes = await adminAgent.get('/api/v1/admin/queues');
    expect(adminRes.status).not.toBe(404);
    expect(adminRes.status).toBe(503);
  });
});
