import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { adminStatsSchema, createUserResponseSchema } from '@bettertrack/contracts';

import { createUserRepository } from '../data/repositories/userRepository';
import * as schema from '../data/schema';
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

async function sessionKeyFor(harness: TestHarness, userId: string): Promise<string> {
  for (const key of await harness.ctx.redis.keys('sess:*')) {
    const raw = await harness.ctx.redis.get(key);
    if (raw && (JSON.parse(raw) as { userId?: string }).userId === userId) return key;
  }
  throw new Error(`No session found for ${userId}`);
}

/**
 * Number of failed attempts that arms the per-account progressive cooldown: the
 * allowance (`limit`) worth of failures, plus the one that overflows it (§10).
 */
const failsToLock = (harness: TestHarness) => harness.ctx.config.rateLimits.loginAccount.limit + 1;

describe('admin route guard (PROJECTPLAN.md §6.12)', () => {
  it('returns 404 for normal users and anonymous requests — no route disclosure', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

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

    const authenticatedUser = await loginAgent(
      harness.app,
      'normal@test.dev',
      'normal-strong-pass-7',
    );
    const asUser = await authenticatedUser.get('/api/v1/admin/users');
    expect(asUser.status).toBe(404);

    const anon = await request(harness.app).get('/api/v1/admin/users');
    expect(anon.status).toBe(404);
  });
});

describe('administrator role-transition generation (#888)', () => {
  it('rejects a pre-promotion session even when eager Redis cleanup fails', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const target = await harness.seedUser({
      email: 'promoted@test.dev',
      username: 'promoted_user',
    });
    const stale = await loginAgent(harness.app, target.email, target.password);

    const cleanup = vi
      .spyOn(harness.ctx.redis, 'smembers')
      .mockRejectedValueOnce(new Error('simulated Redis cleanup failure'));
    const promoted = await adminAgent
      .patch(`/api/v1/admin/users/${target.id}`)
      .set(...XRW)
      .send({ role: 'admin' });
    cleanup.mockRestore();

    expect(promoted.status).toBe(200);
    const [row] = await harness.db
      .select({ role: schema.users.role, generation: schema.users.securityGeneration })
      .from(schema.users)
      .where(eq(schema.users.id, target.id));
    expect(row).toEqual({ role: 'admin', generation: 1 });

    // The cookie still exists because cleanup failed, but it cannot inherit the
    // newly committed administrator role.
    expect((await stale.get('/api/v1/admin/security/2fa/status')).status).toBe(404);
  });

  it('fails closed when promotion commits after the session read but before the user read', async () => {
    const target = await harness.seedUser({
      email: 'interleaved@test.dev',
      username: 'interleaved_user',
    });
    await loginAgent(harness.app, target.email, target.password);
    const sessionKey = await sessionKeyFor(harness, target.id);
    const sessionId = sessionKey.slice('sess:'.length);
    const repo = createUserRepository(harness.db);
    const redisGet = harness.ctx.redis.get.bind(harness.ctx.redis);
    let transitioned = false;

    const get = vi.spyOn(harness.ctx.redis, 'get').mockImplementation(async (...args) => {
      const raw = await redisGet(...args);
      if (!transitioned && args[0] === sessionKey) {
        transitioned = true;
        await repo.setRole(target.id, 'admin');
      }
      return raw;
    });

    expect(await harness.ctx.auth.resolveSession(sessionId)).toBeNull();
    get.mockRestore();
    expect(transitioned).toBe(true);
  });
});

describe('admin creates user → forced password change (PROJECTPLAN.md §6.1)', () => {
  it('issues a temp password and forces a change before normal use', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

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

    expect((await userAgent.get('/api/v1/auth/me')).status).toBe(401);
    const fresh = await loginAgent(harness.app, 'fresh@test.dev', 'fresh-strong-secret-99');
    const me = await fresh.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
  });

  it('rejects a common/weak new password', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
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
    const adminAgent = await harness.loginAdmin(admin);

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

  it('fails closed when credential cleanup fails, then invalidates before re-enable', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const user = await harness.seedUser({
      email: 'suspend-failure@test.dev',
      username: 'suspend_failure',
    });
    const userAgent = await loginAgent(harness.app, user.email, user.password);
    const createdKey = await userAgent
      .post('/api/v1/settings/api-keys')
      .set(...XRW)
      .send({ name: 'suspend test key', scopes: ['portfolio:read'] });
    expect(createdKey.status).toBe(201);
    const token = createdKey.body.token as string;
    const keyId = createdKey.body.key.id as string;

    const revoke = vi
      .spyOn(harness.ctx.apiKeys, 'revokeAllForUser')
      .mockRejectedValueOnce(new Error('simulated revocation failure'));
    const failed = await adminAgent
      .patch(`/api/v1/admin/users/${user.id}`)
      .set(...XRW)
      .send({ status: 'disabled' });
    expect(failed.status).toBe(500);

    const [suspended] = await harness.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, user.id));
    expect(suspended!.status).toBe('disabled');
    expect(
      (await request(harness.app).get('/api/v1/portfolios').set('Authorization', `Bearer ${token}`))
        .status,
    ).toBe(401);

    revoke.mockRestore();
    const enabled = await adminAgent
      .patch(`/api/v1/admin/users/${user.id}`)
      .set(...XRW)
      .send({ status: 'active' });
    expect(enabled.status).toBe(200);

    const [revokedKey] = await harness.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, keyId));
    expect(revokedKey!.revokedAt).not.toBeNull();
    expect(
      (await request(harness.app).get('/api/v1/portfolios').set('Authorization', `Bearer ${token}`))
        .status,
    ).toBe(401);
  });
});

describe('invite lifecycle (PROJECTPLAN.md §6.1, §6.12)', () => {
  it('creates, validates, accepts, and one-shot-consumes an invite', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

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
    const adminAgent = await harness.loginAdmin(admin);
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
    const adminAgent = await harness.loginAdmin(admin);
    const stats = await adminAgent.get('/api/v1/admin/stats');
    expect(stats.status).toBe(200);
    const parsed = adminStatsSchema.parse(stats.body);
    expect(parsed.userCount).toBeGreaterThanOrEqual(1);
  });
});

describe('forced-password-change guard is global (PROJECTPLAN.md §6.1)', () => {
  it('403s a mustChange user on every protected route, including admin routes', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
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
    const adminAgent = await harness.loginAdmin(admin);
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
    const adminAgent = await harness.loginAdmin(admin);
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
    const adminAgent = await harness.loginAdmin(admin);
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
    const adminAgent = await harness.loginAdmin(admin);

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
    const adminAgent = await harness.loginAdmin(admin);

    const demote = await adminAgent
      .patch(`/api/v1/admin/users/${second.id}`)
      .set(...XRW)
      .send({ role: 'user' });
    expect(demote.status).toBe(200);
    expect(demote.body.role).toBe('user');
  });
});

describe('edit username/email (PROJECTPLAN.md §6.12, §13.2)', () => {
  async function seedUser(
    adminAgent: ReturnType<typeof request.agent>,
    email: string,
    username: string,
  ) {
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email, username });
    return created.body.user.id as string;
  }

  it('persists a username change and writes an audit entry', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const userId = await seedUser(adminAgent, 'rename@test.dev', 'rename_me');

    const patched = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ username: 'renamed_user' });
    expect(patched.status).toBe(200);
    expect(patched.body.username).toBe('renamed_user');

    const audit = await adminAgent.get(`/api/v1/admin/users/${userId}/audit`);
    expect(audit.status).toBe(200);
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('user.username_changed');
  });

  it('persists an email change (normalised) and writes an audit entry', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const userId = await seedUser(adminAgent, 'oldmail@test.dev', 'mail_user');

    const patched = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ email: 'NewMail@Test.dev' });
    expect(patched.status).toBe(200);
    expect(patched.body.email).toBe('newmail@test.dev');

    const audit = await adminAgent.get(`/api/v1/admin/users/${userId}/audit`);
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('user.email_changed');
  });

  it('rejects a duplicate username or email cleanly (409)', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    await seedUser(adminAgent, 'first@test.dev', 'first_user');
    const secondId = await seedUser(adminAgent, 'second@test.dev', 'second_user');

    const dupUsername = await adminAgent
      .patch(`/api/v1/admin/users/${secondId}`)
      .set(...XRW)
      .send({ username: 'first_user' });
    expect(dupUsername.status).toBe(409);
    expect(dupUsername.body.error.code).toBe('USERNAME_TAKEN');

    const dupEmail = await adminAgent
      .patch(`/api/v1/admin/users/${secondId}`)
      .set(...XRW)
      .send({ email: 'first@test.dev' });
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.error.code).toBe('EMAIL_TAKEN');
  });
});

describe('bulk user actions (PROJECTPLAN.md §6.12, §13.2)', () => {
  it('bulk-disables a set of users and kills their sessions', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const a = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'bulk-a@test.dev', username: 'bulk_a' });
    const b = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'bulk-b@test.dev', username: 'bulk_b' });
    const idA = a.body.user.id as string;
    const idB = b.body.user.id as string;

    const bulk = await adminAgent
      .post('/api/v1/admin/users/bulk')
      .set(...XRW)
      .send({ action: 'disable', userIds: [idA, idB] });
    expect(bulk.status).toBe(200);
    expect(bulk.body).toEqual({ action: 'disable', disabled: 2, skipped: 0 });

    const users = await adminAgent.get('/api/v1/admin/users');
    const byId = new Map(
      (users.body.users as Array<{ id: string; status: string }>).map((u) => [u.id, u.status]),
    );
    expect(byId.get(idA)).toBe('disabled');
    expect(byId.get(idB)).toBe('disabled');
  });

  it('skips the actor and already-disabled users instead of failing the batch', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'skip@test.dev', username: 'skip_user' });
    const userId = created.body.user.id as string;

    const bulk = await adminAgent
      .post('/api/v1/admin/users/bulk')
      .set(...XRW)
      .send({ action: 'disable', userIds: [userId, admin.id, userId] });
    expect(bulk.status).toBe(200);
    // The user disabled once; the actor and the duplicate id skipped.
    expect(bulk.body.disabled).toBe(1);
    expect(bulk.body.skipped).toBe(1);
  });
});

describe('per-user chat ban (PROJECTPLAN.md §13.4 V4-P0d)', () => {
  it('bans and unbans a user and audits both, without touching sessions', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'chatty@test.dev', username: 'chatty_user' });
    const userId = created.body.user.id as string;
    expect(created.body.user.chatBanned).toBe(false);

    const banned = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ chatBanned: true });
    expect(banned.status).toBe(200);
    expect(banned.body.chatBanned).toBe(true);

    const unbanned = await adminAgent
      .patch(`/api/v1/admin/users/${userId}`)
      .set(...XRW)
      .send({ chatBanned: false });
    expect(unbanned.status).toBe(200);
    expect(unbanned.body.chatBanned).toBe(false);

    const audit = await adminAgent.get(`/api/v1/admin/users/${userId}/audit`);
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('user.chat_banned');
    expect(actions).toContain('user.chat_unbanned');
  });
});

describe('account defaults panel (PROJECTPLAN.md §13.4 V4-P0d)', () => {
  it('returns the lean defaults, persists a change, and audits it', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await harness.loginAdmin(admin);

    const initial = await adminAgent.get('/api/v1/admin/account-defaults');
    expect(initial.status).toBe(200);
    expect(initial.body.chatEnabled).toBe(true);
    expect(initial.body.defaultPortfolioVisibility).toBe('private');
    expect(initial.body.developerStatus).toBe(false);
    // Pre-seeded with the V4-P0c lean email default: email off for a non-account type…
    expect(initial.body.notificationMatrix['friend.request'].email).toBe(false);
    // …and on for the account/security category.
    expect(initial.body.notificationMatrix['account.temp_password'].email).toBe(true);

    const patched = await adminAgent
      .patch('/api/v1/admin/account-defaults')
      .set(...XRW)
      .send({ chatEnabled: false, developerStatus: true, defaultPortfolioVisibility: 'friends' });
    expect(patched.status).toBe(200);
    expect(patched.body.chatEnabled).toBe(false);
    expect(patched.body.developerStatus).toBe(true);
    expect(patched.body.defaultPortfolioVisibility).toBe('friends');

    // Persisted across reads.
    const reread = await adminAgent.get('/api/v1/admin/account-defaults');
    expect(reread.body.chatEnabled).toBe(false);
    expect(reread.body.developerStatus).toBe(true);

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('account_defaults.updated');
  });
});
