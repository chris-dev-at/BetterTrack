import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FEATURE_FLAG_KEYS } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

afterEach(() => {
  // ioredis-mock/PGlite are torn down by the harness lifecycle.
});

type Agent = ReturnType<typeof request.agent>;

async function loginUser(): Promise<Agent> {
  const seeded = await harness.seedUser({ email: 'flags-user@bt.test', username: 'flagsuser' });
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: seeded.email, password: seeded.password });
  expect(res.status).toBe(200);
  return agent;
}

describe('feature-flag advertisement (§13.5 V5-P2 arc (c))', () => {
  it('defaults every flag ON with no stored rows', async () => {
    const res = await request(harness.app).get('/api/v1/feature-flags');
    expect(res.status).toBe(200);
    for (const key of FEATURE_FLAG_KEYS) {
      expect(res.body.flags[key]).toBe(true);
    }
  });

  it('advertises the effective flags — a killed feature reads false', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);

    const res = await request(harness.app).get('/api/v1/feature-flags');
    expect(res.body.flags.chat).toBe(false);
    expect(res.body.flags.alerts).toBe(true);
  });
});

describe('gated routers refuse a killed feature at request time', () => {
  it('chat/alerts/imports are reachable by default', async () => {
    const user = await loginUser();
    expect((await user.get('/api/v1/chat/conversations')).status).toBe(200);
    expect((await user.get('/api/v1/alerts')).status).toBe(200);
    expect((await user.get('/api/v1/imports/brokers')).status).toBe(200);
  });

  it('flipping chat OFF makes the chat routes 404 on the very next request — no redeploy', async () => {
    const user = await loginUser();
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    expect((await user.get('/api/v1/chat/conversations')).status).toBe(200);

    const flip = await adminAgent
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false });
    expect(flip.status).toBe(200);
    expect(flip.body.flags.find((f: { key: string }) => f.key === 'chat').enabled).toBe(false);

    // Immediately — same process, no restart — the guard refuses.
    const refused = await user.get('/api/v1/chat/conversations');
    expect(refused.status).toBe(404);
    expect(refused.body.error?.code).toBe('FEATURE_DISABLED');

    // A non-gated router is untouched.
    expect((await user.get('/api/v1/alerts')).status).toBe(200);
  });

  it('re-enabling a feature restores it on the next request (cache invalidation)', async () => {
    const user = await loginUser();
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    await adminAgent
      .patch('/api/v1/admin/feature-flags/imports')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);
    expect((await user.get('/api/v1/imports/brokers')).status).toBe(404);

    await adminAgent
      .patch('/api/v1/admin/feature-flags/imports')
      .set(...XRW)
      .send({ enabled: true })
      .expect(200);
    expect((await user.get('/api/v1/imports/brokers')).status).toBe(200);
  });
});

describe('admin toggle surface', () => {
  it('lists every flag with metadata (enabled by default)', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const res = await adminAgent.get('/api/v1/admin/feature-flags');
    expect(res.status).toBe(200);
    const keys = res.body.flags.map((f: { key: string }) => f.key);
    expect(keys).toEqual([...FEATURE_FLAG_KEYS]);
    for (const flag of res.body.flags) {
      expect(flag.enabled).toBe(true);
      expect(flag.updatedAt).toBeNull();
    }
  });

  it('a toggle is audit-logged and stamps updatedAt/updatedBy', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    await adminAgent
      .patch('/api/v1/admin/feature-flags/alerts')
      .set(...XRW)
      .send({ enabled: false })
      .expect(200);

    const list = await adminAgent.get('/api/v1/admin/feature-flags');
    const alerts = list.body.flags.find((f: { key: string }) => f.key === 'alerts');
    expect(alerts.enabled).toBe(false);
    expect(alerts.updatedAt).not.toBeNull();
    expect(alerts.updatedBy).toBe(admin.id);

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain('feature_flag.changed');
  });

  it('rejects an unknown flag key', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const res = await adminAgent
      .patch('/api/v1/admin/feature-flags/not-a-flag')
      .set(...XRW)
      .send({ enabled: false });
    expect(res.status).toBe(400);
  });

  it('is fenced to admins — a non-admin 404s (no leak)', async () => {
    const user = await loginUser();
    expect((await user.get('/api/v1/admin/feature-flags')).status).toBe(404);
    const patch = await user
      .patch('/api/v1/admin/feature-flags/chat')
      .set(...XRW)
      .send({ enabled: false });
    expect(patch.status).toBe(404);

    // And an anonymous caller gets the same 404 — requireAdmin discloses nothing.
    expect((await request(harness.app).get('/api/v1/admin/feature-flags')).status).toBe(404);
  });
});
