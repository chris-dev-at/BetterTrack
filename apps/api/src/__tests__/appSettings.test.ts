import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { appSettingsResponseSchema } from '@bettertrack/contracts';

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

describe('GET /admin/settings (PROJECTPLAN.md §6.12, §8)', () => {
  it('returns defaults when no row exists', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const res = await adminAgent.get('/api/v1/admin/settings');
    expect(res.status).toBe(200);
    expect(appSettingsResponseSchema.parse(res.body)).toEqual({
      registrationMode: 'closed',
      betaMode: false,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('is admin-only — user session and anonymous requests both 404 (no leak)', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'normal@test.dev', username: 'normal_user' });
    expect(created.status).toBe(201);

    const userAgent = await loginAgent(harness.app, 'normal@test.dev', created.body.tempPassword);
    await userAgent
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: created.body.tempPassword, newPassword: 'normal-strong-pass-7' });

    const asUser = await userAgent.get('/api/v1/admin/settings');
    expect(asUser.status).toBe(404);

    const anon = await request(harness.app).get('/api/v1/admin/settings');
    expect(anon.status).toBe(404);
  });
});

describe('PATCH /admin/settings (PROJECTPLAN.md §6.12, §8)', () => {
  it('persists a change and writes an audit-log entry', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const patched = await adminAgent
      .patch('/api/v1/admin/settings')
      .set(...XRW)
      .send({ betaMode: true });
    expect(patched.status).toBe(200);
    expect(patched.body.betaMode).toBe(true);
    expect(patched.body.registrationMode).toBe('closed');
    expect(patched.body.updatedBy).toBeTruthy();
    expect(patched.body.updatedAt).not.toBeNull();

    // The change survives a fresh read.
    const reread = await adminAgent.get('/api/v1/admin/settings');
    expect(reread.body.betaMode).toBe(true);

    // …and it was audit-logged with the actor.
    const audit = await adminAgent.get('/api/v1/admin/audit');
    expect(audit.status).toBe(200);
    const entry = (audit.body.entries as Array<{ action: string; actorId: string }>).find(
      (e) => e.action === 'settings.updated',
    );
    expect(entry).toBeDefined();
    expect(entry?.actorId).toBeTruthy();
  });

  it('accepts an explicit closed registration mode', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const res = await adminAgent
      .patch('/api/v1/admin/settings')
      .set(...XRW)
      .send({ registrationMode: 'closed' });
    expect(res.status).toBe(200);
    expect(res.body.registrationMode).toBe('closed');
  });

  it('rejects any registration mode other than closed in V1', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    for (const mode of ['open', 'approval', 'invite_token']) {
      const res = await adminAgent
        .patch('/api/v1/admin/settings')
        .set(...XRW)
        .send({ registrationMode: mode });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('REGISTRATION_MODE_LOCKED');
    }

    // The rejected write never touched the stored state.
    const settings = await adminAgent.get('/api/v1/admin/settings');
    expect(settings.body.registrationMode).toBe('closed');
  });

  it('rejects unknown fields (strict) and empty bodies', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    const unknown = await adminAgent
      .patch('/api/v1/admin/settings')
      .set(...XRW)
      .send({ nope: true });
    expect(unknown.status).toBe(400);

    const empty = await adminAgent
      .patch('/api/v1/admin/settings')
      .set(...XRW)
      .send({});
    expect(empty.status).toBe(400);
  });
});

describe('registration-mode enforcement (PROJECTPLAN.md §4, §6.12, §13 P8)', () => {
  it('blocks a hand-crafted POST /auth/register with 403 while closed', async () => {
    const res = await request(harness.app)
      .post('/api/v1/auth/register')
      .set(...XRW)
      .send({
        email: 'walkin@test.dev',
        username: 'walkin',
        password: 'walkin-strong-pass-1',
      });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REGISTRATION_CLOSED');

    // The account was never created.
    const login = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: 'walkin@test.dev', password: 'walkin-strong-pass-1' });
    expect(login.status).toBe(401);
  });

  it('leaves admin-created users and invite acceptance working in closed mode', async () => {
    const admin = await harness.seedAdmin();
    const adminAgent = await loginAgent(harness.app, admin.email, admin.password);

    // Admin-created user still works.
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'made@test.dev', username: 'made_user' });
    expect(created.status).toBe(201);

    // Invite acceptance still works.
    const invite = await adminAgent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'invitee@test.dev' });
    expect(invite.status).toBe(201);
    const token = (invite.body.inviteUrl as string).split('/invite/')[1];

    const agent = request.agent(harness.app);
    const accept = await agent
      .post('/api/v1/auth/accept-invite')
      .set(...XRW)
      .send({ token, username: 'invitee', password: 'invitee-strong-pass-1' });
    expect(accept.status).toBe(201);
    expect(accept.body.email).toBe('invitee@test.dev');
    expect(accept.body.status).toBe('active');
  });
});
