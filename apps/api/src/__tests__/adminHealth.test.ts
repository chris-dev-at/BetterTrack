import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { adminHealthResponseSchema } from '@bettertrack/contracts';

import type { QueueRegistry } from '../jobs';
import type { RealtimeGateway } from '../realtime';

import type { Database } from '../data/db';
import {
  createHealthService,
  type HealthServiceDeps,
  WORKER_HEARTBEAT_STARTUP_GRACE_MS,
} from '../services/health/healthService';
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

  /** A dependency command that never settles — a hung read, not a rejecting one. */
  const neverSettles = <T>(): Promise<T> => new Promise<T>(() => {});

  /** Swap the route's health service for one built on stubbed dependencies. */
  const installHealthService = (overrides: Partial<HealthServiceDeps>): void => {
    harness.ctx.health = createHealthService({
      config: harness.ctx.config,
      db: harness.db,
      redis: harness.ctx.redis,
      marketData: harness.ctx.marketData,
      queues: harness.ctx.queues,
      gateway: harness.ctx.realtime,
      ...overrides,
    });
  };

  const gatewayStub = (attached: boolean): RealtimeGateway =>
    ({ isAttached: () => attached, connectionCount: () => 0 }) as unknown as RealtimeGateway;

  const withRealtimeEnabled = (enabled: boolean) => ({
    ...harness.ctx.config,
    realtime: { ...harness.ctx.config.realtime, enabled },
  });

  it('returns the contracts-typed status set for an authenticated admin', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    // The test process never runs `attach()` (no HTTP server of its own), so the
    // gateway signal is pinned attached here — its fault path has its own test.
    vi.spyOn(harness.ctx.realtime, 'isAttached').mockReturnValue(true);

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
    // A genuinely unreachable Redis is reported once: the heartbeat read is
    // short-circuited rather than double-faulting the queue component.
    expect(body.components.queues.heartbeat).toEqual({ status: 'ok', ageSeconds: null });
  });

  it('answers with Redis down when a Redis command hangs instead of rejecting', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    // The shared client is built with `maxRetriesPerRequest: null` (BullMQ
    // compatibility), so ioredis never flushes the command queue with an error:
    // a command issued while Redis is stopped is queued and NEVER settles. That
    // is the shape the rejecting mock above cannot produce, and the probe budget
    // — not the client — is what makes this request answer at all.
    installHealthService({
      redis: {
        ping: () => neverSettles<string>(),
        get: () => neverSettles<string | null>(),
      } as unknown as Redis,
      probeTimeoutMs: 50,
    });

    const startedAt = Date.now();
    const res = await agent.get('/api/v1/admin/health');
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    const body = adminHealthResponseSchema.parse(res.body);
    expect(body.components.redis.status).toBe('down');
    expect(body.components.redis.detail).toBe('TimeoutError');
    expect(body.status).toBe('degraded');
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('bounds the total response latency when every probe hangs', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    installHealthService({
      db: { execute: () => neverSettles<unknown>() } as unknown as Database,
      redis: {
        ping: () => neverSettles<string>(),
        get: () => neverSettles<string | null>(),
      } as unknown as Redis,
      queues: {
        get: () => ({ getJobCounts: () => neverSettles<Record<string, number>>() }),
      } as unknown as QueueRegistry,
      probeTimeoutMs: 100,
    });

    const startedAt = Date.now();
    const res = await agent.get('/api/v1/admin/health');
    const elapsedMs = Date.now() - startedAt;

    expect(res.status).toBe(200);
    const body = adminHealthResponseSchema.parse(res.body);
    expect(body.components.database.status).toBe('down');
    expect(body.components.redis.status).toBe('down');
    expect(body.components.queues.status).toBe('degraded');
    // The database is the system of record, so the overall verdict is hard down.
    expect(body.status).toBe('down');
    // Two probe waves (DB + Redis, then heartbeat + queue depths), not a hang.
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('reports a heartbeat read that throws as a degraded queue component', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    // Redis answers PING during `-LOADING` but refuses reads: reachable, yet
    // nothing proves the worker alive.
    installHealthService({
      redis: {
        ping: async () => 'PONG',
        get: async () => {
          throw new Error('LOADING Redis is loading the dataset in memory');
        },
      } as unknown as Redis,
    });

    const res = await agent.get('/api/v1/admin/health');

    expect(res.status).toBe(200);
    const body = adminHealthResponseSchema.parse(res.body);
    expect(body.components.redis.status).toBe('ok');
    expect(body.components.queues.heartbeat).toEqual({ status: 'degraded', ageSeconds: null });
    expect(body.components.queues.status).toBe('degraded');
    // The Overview's attention row keys off the overall verdict.
    expect(body.status).toBe('degraded');
  });

  it('faults the gateway component when realtime is enabled but never attached', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);

    installHealthService({ config: withRealtimeEnabled(true), gateway: gatewayStub(false) });
    const detached = adminHealthResponseSchema.parse(
      (await agent.get('/api/v1/admin/health')).body,
    );
    // A non-`ok` status is what moves the admin StatusBadge off its green tone.
    expect(detached.components.gateway).toEqual({
      status: 'down',
      enabled: true,
      attached: false,
      connections: 0,
    });
    expect(detached.status).toBe('degraded');

    installHealthService({ config: withRealtimeEnabled(true), gateway: gatewayStub(true) });
    const attached = adminHealthResponseSchema.parse(
      (await agent.get('/api/v1/admin/health')).body,
    );
    expect(attached.components.gateway.status).toBe('ok');
    expect(attached.status).toBe('ok');

    // Flag OFF: an unattached gateway is the expected state, not a fault (§4.5).
    installHealthService({ config: withRealtimeEnabled(false), gateway: gatewayStub(false) });
    const disabled = adminHealthResponseSchema.parse(
      (await agent.get('/api/v1/admin/health')).body,
    );
    expect(disabled.components.gateway).toEqual({
      status: 'ok',
      enabled: false,
      attached: false,
      connections: 0,
    });
    expect(disabled.status).toBe('ok');
  });

  it('reports a heartbeat that was never created after startup grace as degraded', async () => {
    const admin = await harness.seedAdmin();
    const agent = await harness.loginAdmin(admin);
    let now = 1_000_000;
    harness.ctx.health = createHealthService({
      config: harness.ctx.config,
      db: harness.db,
      redis: harness.ctx.redis,
      marketData: harness.ctx.marketData,
      queues: harness.ctx.queues,
      gateway: harness.ctx.realtime,
      now: () => now,
    });
    now += WORKER_HEARTBEAT_STARTUP_GRACE_MS + 1;

    const res = await agent.get('/api/v1/admin/health');

    expect(res.status).toBe(200);
    const body = adminHealthResponseSchema.parse(res.body);
    expect(body.components.queues.heartbeat).toEqual({
      status: 'degraded',
      ageSeconds: null,
    });
    expect(body.components.queues.status).toBe('degraded');
    expect(body.status).toBe('degraded');
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
