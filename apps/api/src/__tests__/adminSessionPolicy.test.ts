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

/**
 * Rewrite a live session's `createdAt` to an arbitrary JSON value — including a
 * missing or non-numeric one, which is what a legacy or corrupted record looks
 * like. Returns the number of sessions rewritten.
 */
async function rewriteSessionCreatedAt(
  redis: TestHarness['ctx']['redis'],
  userId: string,
  createdAt: unknown,
): Promise<number> {
  const keys = await redis.keys('sess:*');
  let rewritten = 0;
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const data = JSON.parse(raw) as { userId: string; createdAt?: unknown };
    if (data.userId !== userId) continue;
    if (createdAt === undefined) delete data.createdAt;
    else data.createdAt = createdAt;
    const pttl = await redis.pttl(key);
    if (pttl > 0) await redis.set(key, JSON.stringify(data), 'PX', pttl);
    else await redis.set(key, JSON.stringify(data));
    rewritten += 1;
  }
  return rewritten;
}

/** The single live session key a user holds; fails the test when there is not exactly one. */
async function soleSessionKey(redis: TestHarness['ctx']['redis'], userId: string): Promise<string> {
  const keys = await sessionKeysFor(redis, userId);
  expect(keys).toHaveLength(1);
  return keys[0] as string;
}

/** The live session keys a user currently holds. */
async function sessionKeysFor(
  redis: TestHarness['ctx']['redis'],
  userId: string,
): Promise<string[]> {
  const keys = await redis.keys('sess:*');
  const owned: string[] = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    if ((JSON.parse(raw) as { userId: string }).userId === userId) owned.push(key);
  }
  return owned;
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

  /**
   * The lifetime check is evaluated as `Date.now() - createdAt >= lifetimeMs`.
   * A missing or non-numeric `createdAt` makes that NaN, and `NaN >= lifetimeMs`
   * is false — so the malformed record was ADMITTED, permanently exempt from the
   * one clause §6.12 makes the whole admin security guarantee. It now fails
   * closed, exactly as the security-generation check beside it already did.
   */
  it.each([
    // The three NaN-producing shapes — the ones that used to be admitted.
    ['missing', undefined],
    ['a non-numeric string', 'yesterday'],
    ['an object', { at: 1 }],
    // Coerces to 0, so it already read as an ancient session; pinned so the
    // added validation cannot quietly change that outcome either.
    ['null', null],
  ])('destroys an admin session whose createdAt is %s', async (_label, createdAt) => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    // Valid to start — the untouched record is admitted.
    expect((await adminAgent.get('/api/v1/admin/stats')).status).toBe(200);

    expect(await rewriteSessionCreatedAt(harness.ctx.redis, admin.id, createdAt)).toBe(1);

    // Refused (404, the admin no-leak refusal) AND destroyed, not just rejected.
    expect((await adminAgent.get('/api/v1/admin/stats')).status).toBe(404);
    expect(await sessionKeysFor(harness.ctx.redis, admin.id)).toHaveLength(0);
  });

  it('leaves a USER session with the same malformed createdAt alone (admin-only clause)', async () => {
    const user = await harness.seedUser();
    const userAgent = await loginUser(harness.app, user.email, user.password);
    expect((await userAgent.get('/api/v1/auth/me')).status).toBe(200);

    expect(await rewriteSessionCreatedAt(harness.ctx.redis, user.id, undefined)).toBe(1);

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

/**
 * The admin clock has to reach the session's STORAGE, its cookie and the one
 * number the app reports as "when this lapses" — not just the resolve-time
 * refusal (#1833). Before this, an admin session was minted, cookied and listed
 * on the 30-day user window: the `sess:` record of a ≤24 h session survived 30
 * days of a closed browser, `GET /auth/sessions` showed a policy-dead admin
 * session as an active device, and `GET /auth/session` overstated the lifetime
 * by ~60×. The user-session paths are shared code, so each claim is pinned with
 * its unchanged user counterpart beside it.
 */
describe('an admin session is stored, cookied and reported on the admin clock (#1833)', () => {
  const HOUR_MS = 60 * 60 * 1000;
  const DEFAULT_LIFETIME_SECONDS = DEFAULT_ADMIN_SESSION_LIFETIME_HOURS * 60 * 60;
  /** The §6.1 user window the admin session must no longer borrow. */
  const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

  /** `Max-Age` (seconds) of the session cookie on a login response. */
  function sessionCookieMaxAge(res: request.Response): number {
    const raw = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const cookie = raw.find((value) => value.startsWith('bt_sid='));
    expect(cookie).toBeDefined();
    const maxAge = /Max-Age=(\d+)/i.exec(cookie!)?.[1];
    expect(maxAge).toBeDefined();
    return Number(maxAge);
  }

  it('bounds the Redis TTL and the cookie Max-Age by the admin lifetime, not the 30-day window', async () => {
    const admin = await harness.seedAdmin();
    // A raw password login (the seeded admin has no 2FA yet) so the mint's own
    // Set-Cookie is observable — `loginAdmin` hands back only the agent.
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(200);

    const ttl = await harness.ctx.redis.ttl(await soleSessionKey(harness.ctx.redis, admin.id));
    expect(ttl).toBeGreaterThan(DEFAULT_LIFETIME_SECONDS - 60);
    expect(ttl).toBeLessThanOrEqual(DEFAULT_LIFETIME_SECONDS);

    // Whole seconds, derived at cookie-write time — a hair under the window at
    // most, and nowhere near the 30 days it used to claim.
    const maxAge = sessionCookieMaxAge(res);
    expect(maxAge).toBeGreaterThan(DEFAULT_LIFETIME_SECONDS - 60);
    expect(maxAge).toBeLessThanOrEqual(DEFAULT_LIFETIME_SECONDS);
  });

  it('leaves a USER session on the 30-day window — TTL and cookie Max-Age unchanged', async () => {
    const user = await harness.seedUser();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });
    expect(res.status).toBe(200);

    const ttl = await harness.ctx.redis.ttl(await soleSessionKey(harness.ctx.redis, user.id));
    expect(ttl).toBe(THIRTY_DAYS_SECONDS);
    expect(sessionCookieMaxAge(res)).toBe(THIRTY_DAYS_SECONDS);
  });

  it('re-stamps the stored cap when the lifetime changes at runtime, so the TTL follows the policy', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const patch = await adminAgent
      .patch('/api/v1/admin/security/session-policy')
      .set(...XRW)
      .send({ sessionLifetimeHours: 6 });
    expect(patch.status).toBe(200);

    // The next admin request re-reads the policy; the record it resolves is
    // re-stamped, so the key's own TTL comes down to the new window too.
    expect((await adminAgent.get('/api/v1/admin/stats')).status).toBe(200);
    const ttl = await harness.ctx.redis.ttl(await soleSessionKey(harness.ctx.redis, admin.id));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(6 * 60 * 60);
  });

  it('does not list a policy-dead admin session as an active device', async () => {
    const admin = await harness.seedAdmin();
    // Two plain password consoles for the same admin (a freshly seeded admin has
    // no 2FA yet, so this is the shortest live admin session there is).
    const stale = await loginUser(harness.app, admin.email, admin.password);
    // Age the first console past the 12 h window — its key is still lying around
    // (the backdate preserves the TTL), which is exactly what used to list it —
    // then open the second, which is NOT backdated and stays current.
    expect(await backdateSessionCreatedAt(harness.ctx.redis, admin.id, 13)).toBe(1);
    const live = await loginUser(harness.app, admin.email, admin.password);

    const listed = await live.get('/api/v1/auth/sessions');
    expect(listed.status).toBe(200);
    const sessions = listed.body.sessions as Array<{ current: boolean }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);
    // Reaped, not merely hidden — and the dead console is refused on its next use.
    expect(await sessionKeysFor(harness.ctx.redis, admin.id)).toHaveLength(1);
    expect((await stale.get('/api/v1/auth/me')).status).toBe(401);
    expect((await live.get('/api/v1/auth/me')).status).toBe(200);
  });

  it('lists both of a USER’s equally-aged sessions — the clause is admin-only', async () => {
    const user = await harness.seedUser();
    const first = await loginUser(harness.app, user.email, user.password);
    await loginUser(harness.app, user.email, user.password);
    expect(await backdateSessionCreatedAt(harness.ctx.redis, user.id, 13)).toBe(2);

    const listed = await first.get('/api/v1/auth/sessions');
    expect(listed.status).toBe(200);
    expect(listed.body.sessions).toHaveLength(2);
  });

  it('reports an expiresAt within the admin lifetime, while a user session keeps its 30 days', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const user = await harness.seedUser();
    const userAgent = await loginUser(harness.app, user.email, user.password);

    // The same number the realtime gateway takes as a socket's absolute deadline
    // (`context.ts` hands it `getSessionInfo().expiresAt`), so an admin socket is
    // scheduled on the admin clock too.
    const adminSession = await adminAgent.get('/api/v1/auth/session');
    expect(adminSession.status).toBe(200);
    const adminSpanMs =
      Date.parse(adminSession.body.expiresAt) - Date.parse(adminSession.body.signedInAt);
    expect(adminSpanMs).toBeLessThanOrEqual(24 * HOUR_MS);
    expect(adminSpanMs).toBe(DEFAULT_ADMIN_SESSION_LIFETIME_HOURS * HOUR_MS);

    const userSession = await userAgent.get('/api/v1/auth/session');
    expect(userSession.status).toBe(200);
    expect(Date.parse(userSession.body.expiresAt) - Date.parse(userSession.body.renewedAt)).toBe(
      30 * 24 * HOUR_MS,
    );
  });
});
