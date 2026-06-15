import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MailTransport, OutgoingMail } from '../services/email/transport';
import {
  createTestApp,
  type CreateTestAppOptions,
  type TestHarness,
} from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

// SMTP env that flips config.email.enabled on (host + from are the deciders).
const SMTP_ENV = {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'super-secret-smtp-pass',
  SMTP_FROM: 'BetterTrack <no-reply@test.local>',
} satisfies Partial<NodeJS.ProcessEnv>;

/** Records every send; optionally fails to exercise the degraded path. */
function recordingTransport(
  opts: { fail?: boolean } = {},
): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
      if (opts.fail) throw Object.assign(new Error('connection refused'), { code: 'ECONNECTION' });
    },
  };
}

async function loginAgent(app: Application, identifier: string, password: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
  expect(res.status).toBe(200);
  return agent;
}

async function adminHarness(options: CreateTestAppOptions) {
  const harness = await createTestApp(options);
  const admin = await harness.seedAdmin();
  const agent = await loginAgent(harness.app, admin.email, admin.password);
  return { harness, admin, agent };
}

describe('email channel disabled (PROJECTPLAN.md §6.11, §11)', () => {
  let transport: ReturnType<typeof recordingTransport>;
  let harness: TestHarness;

  beforeEach(async () => {
    transport = recordingTransport();
    // No SMTP env ⇒ channel disabled even though a transport is injected.
    ({ harness } = await adminHarness({ emailTransport: transport }));
  });

  it('runs account flows and never sends mail when SMTP is unset', async () => {
    const admin = await harness.seedAdmin({
      email: 'a2@test.dev',
      username: 'a2',
      password: 'second-admin-strong-1',
    });
    const agent = await loginAgent(harness.app, admin.email, admin.password);

    const created = await agent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'created@test.dev', username: 'created_user' });
    expect(created.status).toBe(201);
    // Admin still gets a copyable temp password from the response.
    expect(typeof created.body.tempPassword).toBe('string');
    expect(created.body.tempPassword.length).toBeGreaterThanOrEqual(16);

    const invite = await agent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'invitee@test.dev' });
    expect(invite.status).toBe(201);
    expect(invite.body.inviteUrl).toContain('/invite/');

    expect(transport.sent).toHaveLength(0);
  });
});

describe('email channel enabled (PROJECTPLAN.md §6.11)', () => {
  it('sends a temp-password email on user creation, with HTML + text', async () => {
    const transport = recordingTransport();
    const { agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const created = await agent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'newbie@test.dev', username: 'newbie' });
    expect(created.status).toBe(201);

    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    expect(mail.to).toBe('newbie@test.dev');
    expect(mail.subject).toMatch(/account is ready/i);
    expect(mail.html).toContain('<html');
    expect(mail.html).toContain(created.body.tempPassword);
    expect(mail.text).toContain(created.body.tempPassword);
    expect(mail.text).toContain('newbie');
  });

  it('sends a temp-password email on admin password reset', async () => {
    const transport = recordingTransport();
    const { agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const created = await agent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'resettee@test.dev', username: 'resettee' });
    const userId = created.body.user.id as string;
    transport.sent.length = 0; // ignore the creation mail

    const reset = await agent.post(`/api/v1/admin/users/${userId}/reset-password`).set(...XRW);
    expect(reset.status).toBe(200);

    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    expect(mail.to).toBe('resettee@test.dev');
    expect(mail.subject).toMatch(/reset/i);
    expect(mail.text).toContain(reset.body.tempPassword);
  });

  it('sends an invite email containing the tokenized URL', async () => {
    const transport = recordingTransport();
    const { agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const invite = await agent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'guest@test.dev' });
    expect(invite.status).toBe(201);

    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    expect(mail.to).toBe('guest@test.dev');
    expect(mail.subject).toMatch(/invited/i);
    expect(mail.html).toContain(invite.body.inviteUrl);
    expect(mail.text).toContain(invite.body.inviteUrl);
  });

  it('sends a welcome email when an invite is accepted', async () => {
    const transport = recordingTransport();
    const { harness, agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const invite = await agent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'welcomed@test.dev' });
    const token = (invite.body.inviteUrl as string).split('/invite/')[1];
    transport.sent.length = 0; // ignore the invite mail

    const accept = await request(harness.app)
      .post('/api/v1/auth/accept-invite')
      .set(...XRW)
      .send({ token, username: 'welcomed', password: 'welcomed-strong-pass-1' });
    expect(accept.status).toBe(201);

    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    expect(mail.to).toBe('welcomed@test.dev');
    expect(mail.subject).toMatch(/welcome/i);
    expect(mail.html).toContain('welcomed');
  });
});

describe('email send failure is non-fatal and audited (PROJECTPLAN.md §6.11, §10)', () => {
  it('still creates the user, then logs an email.send_failed audit entry', async () => {
    const transport = recordingTransport({ fail: true });
    const { agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const created = await agent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'unreachable@test.dev', username: 'unreachable' });
    // The account is created despite the mail blowing up.
    expect(created.status).toBe(201);
    expect(created.body.user.email).toBe('unreachable@test.dev');

    const audit = await agent.get('/api/v1/admin/audit');
    const entries = audit.body.entries as Array<{ action: string; meta: { code?: string } | null }>;
    const failure = entries.find((e) => e.action === 'email.send_failed');
    expect(failure).toBeDefined();
    expect(failure?.meta?.code).toBe('ECONNECTION');

    // The audit row carries no secret material — only a coarse code.
    expect(JSON.stringify(entries)).not.toContain('super-secret-smtp-pass');
  });
});
