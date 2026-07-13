import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { meResponseSchema, twoFactorEnrollResponseSchema } from '@bettertrack/contracts';

import { generateTotpCode } from '../services/auth/totp';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

/**
 * Regression suite for the #248 password-reset brick chains (PROJECTPLAN.md
 * §6.1, §13.2 V2-P4). Covers: an idempotent re-reset after a lost token, an
 * admin-account reset-and-recover (no user-panel-rejects-admin loop), a forced
 * change that resolves the target from the login credential (no admin-session
 * context leakage), and completing a reset without re-entering the just-set
 * password (item 7). Voluntary changes from Settings still re-verify the
 * current password.
 */

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

function login(app: Application, identifier: string, password: string) {
  return request(app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
}

async function resetPassword(adminAgent: ReturnType<typeof request.agent>, userId: string) {
  const res = await adminAgent.post(`/api/v1/admin/users/${userId}/reset-password`).set(...XRW);
  expect(res.status).toBe(200);
  return res.body.tempPassword as string;
}

describe('password reset — lost-token re-reset never bricks a user (#248 item 6)', () => {
  it('a second reset invalidates the first temp password and issues a fresh usable one', async () => {
    const admin = await harness.seedAdmin();
    const user = await harness.seedUser();
    const adminAgent = await harness.loginAdmin(admin);

    // First reset — the token the owner then "loses".
    const temp1 = await resetPassword(adminAgent, user.id);
    // Second reset (lost the first) — must mint a brand-new credential.
    const temp2 = await resetPassword(adminAgent, user.id);
    expect(temp2).not.toBe(temp1);

    // The stale first token no longer works …
    expect((await login(harness.app, user.email, temp1)).status).toBe(401);
    // … the fresh one logs in and can complete the forced change.
    const userAgent = await loginAgent(harness.app, user.email, temp2);
    const changed = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ newPassword: 'brand-new-strong-secret-1' });
    expect(changed.status).toBe(200);
    expect(changed.body.mustChangePassword).toBe(false);

    // The new password is immediately usable — the account is not bricked.
    expect((await login(harness.app, user.email, 'brand-new-strong-secret-1')).status).toBe(200);
  });
});

describe('password reset — an admin account is recoverable (#248 item 6)', () => {
  it('a reset admin completes the change and reaches admin endpoints — no user-panel loop', async () => {
    const actor = await harness.seedAdmin({ email: 'root@test.dev', username: 'root_admin' });
    const target = await harness.seedAdmin({ email: 'ops@test.dev', username: 'ops_admin' });
    const actorAgent = await harness.loginAdmin(actor);

    const temp = await resetPassword(actorAgent, target.id);

    // The reset admin logs in with the temp password (login stays reachable).
    const targetAgent = await loginAgent(harness.app, target.email, temp);
    // The forced-change guard blocks admin endpoints until the flag clears.
    expect((await targetAgent.get('/api/v1/admin/users')).status).toBe(403);

    // Completing the change in one step — no current password re-entry (item 7).
    const changed = await targetAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ newPassword: 'ops-recovered-strong-9' });
    expect(changed.status).toBe(200);
    const me = meResponseSchema.parse(changed.body);
    expect(me.role).toBe('admin');
    expect(me.mustChangePassword).toBe(false);

    // The password loop is gone — but mandatory admin 2FA (#400) now gates the
    // panel with the setup wizard (not a bounce) until the reset admin enrolls.
    const stillGated = await targetAgent.get('/api/v1/admin/users');
    expect(stillGated.status).toBe(403);
    expect(stillGated.body.error.code).toBe('ADMIN_2FA_SETUP_REQUIRED');

    // Enrolling 2FA on the very same session opens the panel — recovery complete.
    const { secret } = twoFactorEnrollResponseSchema.parse(
      (await targetAgent.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).body,
    );
    await targetAgent
      .post('/api/v1/admin/security/2fa/totp/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect((await targetAgent.get('/api/v1/admin/users')).status).toBe(200);
    // And the new password is accepted at login (now issuing the 2FA challenge).
    expect((await login(harness.app, target.email, 'ops-recovered-strong-9')).status).toBe(200);
  });
});

describe('password reset — outcome is independent of any admin session elsewhere (#248 item 6)', () => {
  it('a forced change resolves the target from the login credential, not ambient admin state', async () => {
    const admin = await harness.seedAdmin();
    const user = await harness.seedUser();

    // One agent holds the admin session, then logs in as the reset user in the
    // same agent — rotating the cookie to the user's session. The forced change
    // must act on the user, never on the admin whose session was there before.
    const agent = await harness.loginAdmin(admin);
    const temp = await resetPassword(agent, user.id);

    const relogin = await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: temp });
    expect(relogin.status).toBe(200);

    const changed = await agent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ newPassword: 'user-only-new-secret-2' });
    expect(changed.status).toBe(200);
    // The account that changed is the user, not the admin.
    expect(changed.body.id).toBe(user.id);

    // The user's new password works; the admin's original password is untouched.
    expect((await login(harness.app, user.email, 'user-only-new-secret-2')).status).toBe(200);
    expect((await login(harness.app, admin.email, admin.password)).status).toBe(200);
  });
});

describe('password reset — no redundant password re-entry (#248 item 7)', () => {
  it('completing a reset with only the new password logs the user straight in', async () => {
    const admin = await harness.seedAdmin();
    const user = await harness.seedUser();
    const adminAgent = await harness.loginAdmin(admin);
    const temp = await resetPassword(adminAgent, user.id);

    const userAgent = await loginAgent(harness.app, user.email, temp);
    // No `currentPassword` — the temp-password login is the proof.
    const changed = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ newPassword: 'set-once-strong-secret-3' });
    expect(changed.status).toBe(200);

    // Same session, no second password prompt: the user is authenticated.
    const me = await userAgent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.mustChangePassword).toBe(false);
  });

  it('enforces the password policy on the forced-change new password (§6.1)', async () => {
    const admin = await harness.seedAdmin();
    const user = await harness.seedUser();
    const adminAgent = await harness.loginAdmin(admin);
    const temp = await resetPassword(adminAgent, user.id);

    const userAgent = await loginAgent(harness.app, user.email, temp);
    const res = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ newPassword: 'password123' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
  });
});

describe('voluntary password change still re-verifies the current password (§6.1)', () => {
  it('rejects an omitted or wrong current password when the account is not in forced change', async () => {
    const user = await harness.seedUser();
    const userAgent = await loginAgent(harness.app, user.email, user.password);

    // Omitting the current password is not allowed outside the forced-change flow.
    const missing = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ newPassword: 'voluntary-strong-secret-4' });
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('INVALID_CREDENTIALS');

    // A wrong current password is likewise rejected.
    const wrong = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: 'not-my-password', newPassword: 'voluntary-strong-secret-4' });
    expect(wrong.status).toBe(401);

    // The correct current password succeeds.
    const ok = await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: user.password, newPassword: 'voluntary-strong-secret-4' });
    expect(ok.status).toBe(200);
    expect(ok.body.mustChangePassword).toBe(false);
  });
});
