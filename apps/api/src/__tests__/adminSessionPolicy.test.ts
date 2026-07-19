import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  adminSessionPolicyResponseSchema,
  DEFAULT_ADMIN_SESSION_LIFETIME_HOURS,
} from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Admin session policy (§13.5 V5-P13c, settles #430). Admin sessions carry an
 * ABSOLUTE lifetime from login and expire early — independent of the user-app
 * session rules (#418). "Log in with 2FA, then peace": no admin action carries a
 * step-up 2FA re-challenge (#430 rejected); the short session IS the guarantee.
 * The lifetime is admin-configurable at runtime and applies with no redeploy.
 */
const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

/**
 * Backdate a user's live session `createdAt` in Redis to N hours ago — a clock
 * stand-in that drives the absolute-lifetime check off real, deterministic
 * time instead of a global timer fake (which supertest's real-timer round trips
 * don't tolerate). Returns the number of sessions rewritten.
 */
async function backdateSessionCreatedAt(
  redis: TestHarness['ctx']['redis'],
  userId: string,
  hoursAgo: number,
): Promise<number> {
  const keys = await redis.keys('sess:*');
  let rewritten = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const data = JSON.parse(raw) as { userId: string; createdAt: number };
    if (data.userId !== userId) continue;
    data.createdAt = Date.now() - hoursAgo * 60 * 60 * 1000;
    // Re-set with the remaining key TTL preserved where the backend reports one
    // (real Redis); the read-time policy — not the key's own expiry — is what
    // rejects the aged admin session under test.
    const pttl = await redis.pttl(key);
    if (pttl > 0) await redis.set(key, JSON.stringify(data), 'PX', pttl);
    else await redis.set(key, JSON.stringify(data));
    rewritten += 1;
  }
  return rewritten;
}

async function loginUser(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

describe('admin session policy — get/set (§13.5 V5-P13c)', () => {
  it('returns the env-default lifetime (12 h) with the 6–24 h window when unset', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const res = await adminAgent.get('/api/v1/admin/security/session-policy');
    expect(res.status).toBe(200);
    expect(adminSessionPolicyResponseSchema.parse(res.body)).toEqual({
      sessionLifetimeHours: DEFAULT_ADMIN_SESSION_LIFETIME_HOURS,
      minHours: 6,
      maxHours: 24,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('is admin-only — a user session and an anonymous request both 404 (no leak)', async () => {
    const admin = await harness.seedAdmin();
    await harness.loginAdmin(admin);
    const user = await harness.seedUser();
    const userAgent = await loginUser(harness.app, user.email, user.password);

    expect((await userAgent.get('/api/v1/admin/security/session-policy')).status).toBe(404);
    expect((await request(harness.app).get('/api/v1/admin/security/session-policy')).status).toBe(
      404,
    );
  });

  it('persists a valid change and reflects the actor + timestamp on read', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const patch = await adminAgent
      .patch('/api/v1/admin/security/session-policy')
      .set(...XRW)
      .send({ sessionLifetimeHours: 8 });
    expect(patch.status).toBe(200);
    expect(patch.body.sessionLifetimeHours).toBe(8);
    expect(patch.body.updatedBy).toBe(admin.id);
    expect(patch.body.updatedAt).not.toBeNull();

    const read = await adminAgent.get('/api/v1/admin/security/session-policy');
    expect(read.body.sessionLifetimeHours).toBe(8);
  });

  it('rejects values outside the 6–24 h window (400) and never persists them', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    for (const bad of [3, 0, 25, 48, 12.5]) {
      const res = await adminAgent
        .patch('/api/v1/admin/security/session-policy')
        .set(...XRW)
        .send({ sessionLifetimeHours: bad });
      expect(res.status).toBe(400);
    }

    // Still at the untouched default — nothing leaked through.
    const read = await adminAgent.get('/api/v1/admin/security/session-policy');
    expect(read.body.sessionLifetimeHours).toBe(DEFAULT_ADMIN_SESSION_LIFETIME_HOURS);
    expect(read.body.updatedAt).toBeNull();
  });

  it('audit-logs the change (admin_session_policy.updated)', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    await adminAgent
      .patch('/api/v1/admin/security/session-policy')
      .set(...XRW)
      .send({ sessionLifetimeHours: 6 });

    const audit = await adminAgent.get('/api/v1/admin/audit');
    expect(audit.status).toBe(200);
    const actions = (audit.body.entries as Array<{ action: string; actorId: string }>).map(
      (e) => e.action,
    );
    expect(actions).toContain('admin_session_policy.updated');
  });
});

describe('admin session expiry — early, absolute, live-configurable (§13.5 V5-P13c)', () => {
  it('expires the admin session per config while a user session persists; a runtime change applies without redeploy', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const user = await harness.seedUser();
    const userAgent = await loginUser(harness.app, user.email, user.password);

    // Both sessions are live to start.
    expect((await adminAgent.get('/api/v1/admin/stats')).status).toBe(200);
    expect((await userAgent.get('/api/v1/auth/me')).status).toBe(200);

    // Age BOTH sessions to 7 h old. The admin absolute lifetime is measured from
    // login (`createdAt`); the user session (a fixed 30-day window) is unaffected
    // by a 7 h age.
    expect(await backdateSessionCreatedAt(harness.ctx.redis, admin.id, 7)).toBe(1);
    await backdateSessionCreatedAt(harness.ctx.redis, user.id, 7);

    // 7 h < the 12 h default → the admin session is still valid…
    expect((await adminAgent.get('/api/v1/admin/stats')).status).toBe(200);

    // …until the lifetime is tightened to the 6 h floor at runtime (no restart).
    const patch = await adminAgent
      .patch('/api/v1/admin/security/session-policy')
      .set(...XRW)
      .send({ sessionLifetimeHours: 6 });
    expect(patch.status).toBe(200);

    // The same 7-h-old session now exceeds the (new) 6 h lifetime and is rejected
    // + destroyed on read — the change took effect on the very next request.
    expect((await adminAgent.get('/api/v1/admin/stats')).status).toBe(404);

    // The user session is governed by the user-app rules (#418) — still alive.
    expect((await userAgent.get('/api/v1/auth/me')).status).toBe(200);
  });
});

describe('admin actions carry no step-up 2FA re-challenge (#430 rejected)', () => {
  it('destructive admin endpoints succeed post-login with no extra 2FA prompt', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    // A representative spread of mutating/destructive admin actions. None may
    // answer with a 2FA challenge (no 403 ADMIN_2FA_SETUP_REQUIRED, no
    // twoFactorRequired flag) — the admin already cleared login 2FA.
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'victim@test.dev', username: 'victim_user' });
    expect(created.status).toBe(201);
    expect(created.body.twoFactorRequired).toBeUndefined();

    const settings = await adminAgent
      .patch('/api/v1/admin/settings')
      .set(...XRW)
      .send({ betaMode: true });
    expect(settings.status).toBe(200);
    expect(settings.body.twoFactorRequired).toBeUndefined();

    const policy = await adminAgent
      .patch('/api/v1/admin/security/session-policy')
      .set(...XRW)
      .send({ sessionLifetimeHours: 10 });
    expect(policy.status).toBe(200);
    expect(policy.body.twoFactorRequired).toBeUndefined();

    const deleted = await adminAgent
      .delete(`/api/v1/admin/users/${created.body.user.id}`)
      .set(...XRW)
      .send({ confirmUsername: 'victim_user' });
    expect(deleted.status).toBe(200);
    expect(deleted.body.twoFactorRequired).toBeUndefined();
  });
});
