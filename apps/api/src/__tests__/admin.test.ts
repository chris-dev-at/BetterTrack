import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { adminStatsSchema, createUserResponseSchema } from '@bettertrack/contracts';

import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function failLogin(app: Application, identifier: string, times: number) {
  for (let i = 0; i < times; i += 1) {
    await request(app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier, password: 'definitely-the-wrong-password' });
  }
}

/**
 * Number of failed attempts that arms the per-account progressive cooldown: the
 * allowance (`limit`) worth of failures, plus the one that overflows it (§10).
 */
const failsToLock = (harness: TestHarness) => harness.ctx.config.rateLimits.loginAccount.limit + 1;

describe('admin route guard (PROJECTPLAN.md §6.12)', () => {
  it('returns 404 for normal users and anonymous requests — no route disclosure', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'normal@test.dev', username: 'normal_user' });
    expect(created.status).toBe(201);

    const userAgent = await loginAgent(harness.app, 'normal@test.dev', created.body.tempPassword);
    // Clear the forced-change flag first; otherwise the global guard 403s
    // before requireAdmin's 404 disguise (covered separately below).
    await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: created.body.tempPassword, newPassword: 'normal-strong-pass-7' });

    const asUser = await userAgent.get('/api/v1/admin/users');
    expect(asUser.status).toBe(404);

    const anon = await request(harness.app).get('/api/v1/admin/users');
    expect(anon.status).toBe(404);
  });
});

describe('admin creates user → forced password change (PROJECTPLAN.md §6.1)', () => {
  it('issues a temp password and forces a change before normal use', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'fresh@test.dev', username: 'fresh_user' });
    const body = createUserResponseSchema.parse(created.body);
    expect(body.user.mustChangePassword).toBe(true);

    const userAgent = await loginAgent(harness.app, 'fresh@test.dev', body.tempPassword);

    // Every call except change-password/logout is blocked.
    const blocked = await userAgent.get('/api/v1/auth/me');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: body.tempPassword, newPassword: 'fresh-strong-secret-99' });
    expect(changed.status).toBe(200);
    expect(changed.body.mustChangePassword).toBe(false);

    const me = await userAgent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
  });

  it('rejects a common/weak new password', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'weak@test.dev', username: 'weak_user' });
    const userAgent = await loginAgent(harness.app, 'weak@test.dev', created.body.tempPassword);

    const res = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: created.body.tempPassword, newPassword: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });
});

describe('disable user (PROJECTPLAN.md §6.1, §13)', () => {
  it('kills live sessions instantly and blocks re-login', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'doomed@test.dev', username: 'doomed_user' });
    const userId = created.body.user.id as string;
    const tempPassword = created.body.tempPassword as string;

    const userAgent = await loginAgent(harness.app, 'doomed@test.dev', tempPassword);

    const patched = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    expect(patched.status).toBe(200);

    // Existing session is dead.
    const me = await userAgent.get('/api/v1/auth/me');
    expect(me.status).toBe(401);

    // Re-login with the correct password is rejected with the distinct
    // account-disabled error (revealed only post-verification, §6.1/§16).
    const relogin = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'doomed@test.dev', password: tempPassword });
    expect(relogin.status).toBe(403);
    expect(relogin.body.error.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('invite lifecycle (PROJECTPLAN.md §6.1, §6.12)', () => {
  it('creates, validates, accepts, and one-shot-consumes an invite', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const invite = await adminAgent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'invitee@test.dev' });
    expect(invite.status).toBe(201);
    const token = (invite.body.inviteUrl as string).split('/invite/')[1];

    const validate = await request(harness.app).get(`/api/v1/auth/invite/${token}`);
    expect(validate.status).toBe(200);
    expect(validate.body).toEqual({ valid: true, email: 'invitee@test.dev' });

    const agent = request.agent(harness.app);
    const accept = await agent
      .post('/api/v1/auth/accept-invite')
      .set(...XRW)
      .send({ token, username: 'invitee', password: 'invitee-strong-pass-1' });
    expect(accept.status).toBe(201);
    expect(accept.body.email).toBe('invitee@test.dev');
    expect(accept.body.status).toBe('active');

    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);

    // Token is single-use.
    const reuse = await request(harness.app).get(`/api/v1/auth/invite/${token}`);
    expect(reuse.body.valid).toBe(false);
  });
});

describe('audit log (PROJECTPLAN.md §5.5, §10)', () => {
  it('records login.success, admin.login and user.created', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'audited@test.dev', username: 'audited_user' });

    const audit = await adminAgent.get('/api/v1/admin/audit');
    expect(audit.status).toBe(200);
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('login.success');
    expect(actions).toContain('admin.login');
    expect(actions).toContain('user.created');
  });

  it('exposes overview stats', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    const stats = await adminAgent.get('/api/v1/admin/stats');
    expect(stats.status).toBe(200);
    const parsed = adminStatsSchema.parse(stats.body);
    expect(parsed.userCount).toBeGreaterThanOrEqual(1);
  });
});

describe('forced-password-change guard is global (PROJECTPLAN.md §6.1)', () => {
  it('403s a mustChange user on every protected route, including admin routes', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    // Make the new account an admin so requireAdmin would otherwise let it in —
    // proving the password-change guard fires first.
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'pending@test.dev', username: 'pending_admin', role: 'admin' });
    const { tempPassword } = createUserResponseSchema.parse(created.body);

    const userAgent = await loginAgent(harness.app, 'pending@test.dev', tempPassword);

    for (const path of ['/api/v1/auth/me', '/api/v1/admin/users', '/api/v1/admin/stats']) {
      const res = await userAgent.get(path);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }

    // change-password and logout stay reachable.
    const logout = await userAgent.post('/api/v1/auth/logout').set(...XRW);
    expect(logout.status).toBe(200);
  });
});

describe('admin recovery clears login throttle (PROJECTPLAN.md §6.1, §6.12)', () => {
  it('password reset clears lockout so the new temp password works immediately', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'locked@test.dev', username: 'locked_user' });
    const userId = created.body.user.id as string;

    // Enough consecutive bad passwords → the account is cooling down.
    await failLogin(harness.app, 'locked@test.dev', failsToLock(harness));
    const whileLocked = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'locked@test.dev', password: created.body.tempPassword });
    expect(whileLocked.status).toBe(401);

    const reset = await adminAgent.post(`/api/v1/admin/users/${userId}/reset-password`).set(...XRW);
    expect(reset.status).toBe(200);

    const afterReset = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'locked@test.dev', password: reset.body.tempPassword });
    expect(afterReset.status).toBe(200);
  });

  it('re-enabling a disabled user clears lockout state', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'reenable@test.dev', username: 'reenable_user' });
    const userId = created.body.user.id as string;
    const tempPassword = created.body.tempPassword as string;

    await failLogin(harness.app, 'reenable@test.dev', failsToLock(harness));

    await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    const reenabled = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ status: 'active' });
    expect(reenabled.status).toBe(200);

    // Lockout was cleared by the re-enable, so the temp password works now.
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'reenable@test.dev', password: tempPassword });
    expect(login.status).toBe(200);
  });
});

describe('throttled login failures are audited (PROJECTPLAN.md §10)', () => {
  it('records a login.fail with reason locked once the account cools down', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'throttled@test.dev', username: 'throttled_user' });

    // Enough failures to arm the progressive cooldown, then one more attempt —
    // even with the correct password — is rejected while the account is cooling.
    await failLogin(harness.app, 'throttled@test.dev', failsToLock(harness));
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'throttled@test.dev', password: created.body.tempPassword });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const locked = (
      audit.body.entries as Array<{ action: string; meta: { reason?: string } | null }>
    ).filter((e) => e.action === 'login.fail' && e.meta?.reason === 'locked');
    expect(locked.length).toBeGreaterThanOrEqual(1);
  });
});

describe('admin self-action and last-admin guards (PROJECTPLAN.md §6.12)', () => {
  it('blocks an admin from disabling, demoting, or deleting their own account', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const disableSelf = await adminAgent
      .patch(`/api/v1/admin/users/${admin.id}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    expect(disableSelf.status).toBe(400);
    expect(disableSelf.body.error.code).toBe('SELF_ACTION');

    const demoteSelf = await adminAgent
      .patch(`/api/v1/admin/users/${admin.id}`)
      .set(...XRW)
      .send({ role: 'user' });
    expect(demoteSelf.status).toBe(400);
    expect(demoteSelf.body.error.code).toBe('SELF_ACTION');

    const deleteSelf = await adminAgent
      .delete(`/api/v1/admin/users/${admin.id}`)
      .set(...XRW)
      .send({ confirmUsername: admin.username });
    expect(deleteSelf.status).toBe(400);
    expect(deleteSelf.body.error.code).toBe('SELF_ACTION');
  });

  it('allows demoting a second admin once more than one exists', async () => {
    const admin = await harness.seedAdmin();
    const second = await harness.seedAdmin({
      email: 'second-admin@test.dev',
      username: 'second_admin',
      password: 'second-admin-strong-1',
    });
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const demote = await adminAgent
      .patch(`/api/v1/admin/users/${second.id}`)
      .set(...XRW)
      .send({ role: 'user' });
    expect(demote.status).toBe(200);
    expect(demote.body.role).toBe('user');
  });
});
