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

    // Re-login is rejected with the generic error.
    const relogin = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'doomed@test.dev', password: tempPassword });
    expect(relogin.status).toBe(401);
    expect(relogin.body.error.code).toBe('INVALID_CREDENTIALS');
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
