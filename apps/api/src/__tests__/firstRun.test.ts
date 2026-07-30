import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { meResponseSchema } from '@bettertrack/contracts';

import type { MailTransport, OutgoingMail } from '../services/email/transport';
import { createTestApp, type SeededAdmin, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

const SMTP_ENV = {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'super-secret-smtp-pass',
  SMTP_FROM: 'BetterTrack <no-reply@test.local>',
} satisfies Partial<NodeJS.ProcessEnv>;

function recordingTransport(): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

function login(app: Application, identifier: string, password: string) {
  return request(app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
}

/**
 * First-run completion (§6.12).
 *
 * The point of the column is that a NEW account reads `firstRunCompletedAt:
 * null` on its first authenticated request no matter how the account came to
 * exist — self-registration, an accepted invite, an approved application, or an
 * admin-created user. `lastLoginAt` cannot carry that signal: every sign-in path
 * stamps it before the response body is built, so it is already non-null the
 * first time a user ever sees `/auth/me`. Each mode below is asserted
 * end-to-end for exactly that reason.
 */
describe('first-run completion', () => {
  let harness: TestHarness;
  let transport: ReturnType<typeof recordingTransport>;
  let admin: SeededAdmin;
  let adminAgent: ReturnType<typeof request.agent>;

  beforeEach(async () => {
    transport = recordingTransport();
    harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    admin = await harness.seedAdmin();
    adminAgent = await harness.loginAdmin(admin);
  });

  async function setMode(mode: 'closed' | 'invite_token' | 'approval' | 'open') {
    const res = await adminAgent
      .patch('/api/v1/admin/settings')
      .set(...XRW)
      .send({ registrationMode: mode });
    expect(res.status).toBe(200);
  }

  // ── The signal itself ──────────────────────────────────────────────────────

  it('a brand-new account reports firstRunCompletedAt: null, even though lastLoginAt is already set', async () => {
    const user = await harness.seedUser();
    const agent = request.agent(harness.app);

    const signIn = await login(harness.app, user.email, user.password);
    expect(signIn.status).toBe(200);
    // The exact trap this column exists to avoid: the very first login already
    // carries a lastLoginAt, so it can never mark a first session.
    expect(signIn.body.lastLoginAt).not.toBeNull();
    expect(signIn.body.firstRunCompletedAt).toBeNull();

    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({
        identifier: user.email,
        password: user.password,
      });
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(meResponseSchema.parse(me.body).firstRunCompletedAt).toBeNull();
  });

  it('completing sets the timestamp and /auth/me reports it from then on', async () => {
    const user = await harness.seedUser();
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({
        identifier: user.email,
        password: user.password,
      });

    const done = await agent
      .post('/api/v1/auth/first-run/complete')
      .set(...XRW)
      .send();
    expect(done.status).toBe(200);
    const body = meResponseSchema.parse(done.body);
    expect(body.firstRunCompletedAt).not.toBeNull();

    const me = await agent.get('/api/v1/auth/me');
    expect(meResponseSchema.parse(me.body).firstRunCompletedAt).toBe(body.firstRunCompletedAt);
  });

  it('is set-once: a replay never moves the recorded timestamp', async () => {
    const user = await harness.seedUser();
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({
        identifier: user.email,
        password: user.password,
      });

    const first = await agent
      .post('/api/v1/auth/first-run/complete')
      .set(...XRW)
      .send();
    const second = await agent
      .post('/api/v1/auth/first-run/complete')
      .set(...XRW)
      .send();

    expect(second.status).toBe(200);
    expect(second.body.firstRunCompletedAt).toBe(first.body.firstRunCompletedAt);
  });

  it('rejects an anonymous caller', async () => {
    const res = await request(harness.app)
      .post('/api/v1/auth/first-run/complete')
      .set(...XRW)
      .send();
    expect(res.status).toBe(401);
  });

  it('only ever affects the caller — one user completing leaves another untouched', async () => {
    const a = await harness.seedUser();
    const b = await harness.seedUser({
      email: 'second@bettertrack.test',
      username: 'seconduser',
    });

    const agentA = request.agent(harness.app);
    await agentA
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({
        identifier: a.email,
        password: a.password,
      });
    await agentA
      .post('/api/v1/auth/first-run/complete')
      .set(...XRW)
      .send();

    const agentB = request.agent(harness.app);
    await agentB
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({
        identifier: b.email,
        password: b.password,
      });
    const meB = await agentB.get('/api/v1/auth/me');
    expect(meB.body.firstRunCompletedAt).toBeNull();
  });

  // ── Every §6.12 way an account can be born ─────────────────────────────────

  it('open-mode self-registration starts un-set-up', async () => {
    await setMode('open');
    const res = await request(harness.app)
      .post('/api/v1/auth/register')
      .set(...XRW)
      .send({ email: 'open@test.dev', username: 'open_user', password: 'open-strong-pass-1' });

    expect(res.status).toBe(201);
    expect(meResponseSchema.parse(res.body).firstRunCompletedAt).toBeNull();
  });

  it('invite-token self-registration starts un-set-up', async () => {
    await setMode('invite_token');
    const created = await adminAgent
      .post('/api/v1/admin/registration-tokens')
      .set(...XRW)
      .send({});
    expect(created.status).toBe(201);
    const token = new URL(created.body.registerUrl as string).searchParams.get('token');

    const res = await request(harness.app)
      .post('/api/v1/auth/register')
      .set(...XRW)
      .send({
        email: 'tok@test.dev',
        username: 'tok_user',
        password: 'tok-strong-pass-1',
        inviteToken: token,
      });

    expect(res.status).toBe(201);
    expect(meResponseSchema.parse(res.body).firstRunCompletedAt).toBeNull();
  });

  it('an accepted admin invite starts un-set-up', async () => {
    const invite = await adminAgent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'invited@test.dev' });
    expect(invite.status).toBe(201);
    const token = new URL(invite.body.inviteUrl as string).pathname.split('/').pop() as string;

    const res = await request(harness.app)
      .post('/api/v1/auth/accept-invite')
      .set(...XRW)
      .send({ token, username: 'invited_user', password: 'invited-strong-pass-1' });

    expect(res.status).toBe(201);
    expect(meResponseSchema.parse(res.body).firstRunCompletedAt).toBeNull();
  });

  /**
   * The regression this whole change is about: an approved applicant never
   * touches a signup screen — the admin creates the row, the applicant just logs
   * in. A trigger bolted onto the register/invite pages could never reach them.
   */
  it('an approved application starts un-set-up on its first login', async () => {
    await setMode('approval');
    const applicant = {
      email: 'approved@test.dev',
      username: 'approved_user',
      password: 'approved-strong-pass-1',
    };
    const applied = await request(harness.app)
      .post('/api/v1/auth/register')
      .set(...XRW)
      .send(applicant);
    expect(applied.status).toBe(202);

    const list = await adminAgent.get('/api/v1/admin/registration-requests');
    const requestId = list.body.requests[0].id as string;
    const approve = await adminAgent
      .post(`/api/v1/admin/registration-requests/${requestId}/approve`)
      .set(...XRW)
      .send();
    expect(approve.status).toBe(200);

    const signIn = await login(harness.app, applicant.email, applicant.password);
    expect(signIn.status).toBe(200);
    expect(meResponseSchema.parse(signIn.body).firstRunCompletedAt).toBeNull();
  });

  /** The other unreachable path: an admin-created account with a temp password. */
  it('an admin-created account starts un-set-up on its first login', async () => {
    const created = await adminAgent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'made@test.dev', username: 'made_user' });
    expect(created.status).toBe(201);
    const tempPassword = created.body.tempPassword as string;

    const signIn = await login(harness.app, 'made@test.dev', tempPassword);
    expect(signIn.status).toBe(200);
    const body = meResponseSchema.parse(signIn.body);
    // Forced password change and first-run setup are independent: the trap runs
    // first (it sits above routing in the SPA), then setup is still pending.
    expect(body.mustChangePassword).toBe(true);
    expect(body.firstRunCompletedAt).toBeNull();
  });
});
