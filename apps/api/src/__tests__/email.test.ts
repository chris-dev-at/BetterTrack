import { desc } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { emailLog, type EmailLogRow } from '../data/schema';
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

async function adminHarness(options: CreateTestAppOptions) {
  const harness = await createTestApp(options);
  const admin = await harness.seedAdmin();
  const agent = await harness.loginAdmin(admin);
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
    const agent = await harness.loginAdmin(admin);

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

describe('admin test-email diagnostic (PROJECTPLAN.md §6.12)', () => {
  it('GET /admin/email/status reflects whether SMTP is configured', async () => {
    const off = await adminHarness({});
    const offRes = await off.agent.get('/api/v1/admin/email/status');
    expect(offRes.status).toBe(200);
    expect(offRes.body).toEqual({ enabled: false });

    const on = await adminHarness({ env: SMTP_ENV, emailTransport: recordingTransport() });
    const onRes = await on.agent.get('/api/v1/admin/email/status');
    expect(onRes.body).toEqual({ enabled: true });
  });

  it('sends a test email to the admin by default when the channel is enabled', async () => {
    const transport = recordingTransport();
    const { agent, admin } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const res = await agent
      .post('/api/v1/admin/test-email')
      .set(...XRW)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
    expect(res.body.to).toBe(admin.email);

    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe(admin.email);
    expect(transport.sent[0]!.subject).toMatch(/test/i);
  });

  it('sends a test email to an explicit recipient', async () => {
    const transport = recordingTransport();
    const { agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const res = await agent
      .post('/api/v1/admin/test-email')
      .set(...XRW)
      .send({ to: 'pickme@test.dev' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
    expect(res.body.to).toBe('pickme@test.dev');
    expect(transport.sent[0]!.to).toBe('pickme@test.dev');
  });

  it('reports skipped and sends nothing when the channel is disabled', async () => {
    const transport = recordingTransport();
    const { agent } = await adminHarness({ emailTransport: transport });

    const res = await agent
      .post('/api/v1/admin/test-email')
      .set(...XRW)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('skipped');
    expect(transport.sent).toHaveLength(0);
  });

  it('reports failed without leaking SMTP credentials, and audits the attempt', async () => {
    const transport = recordingTransport({ fail: true });
    const { agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const res = await agent
      .post('/api/v1/admin/test-email')
      .set(...XRW)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.code).toBe('ECONNECTION');
    // The response carries a coarse code only — never the SMTP password.
    expect(JSON.stringify(res.body)).not.toContain('super-secret-smtp-pass');

    const audit = await agent.get('/api/v1/admin/audit');
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('email.test_sent');
  });
});

describe('email_log — one row per send attempt (PROJECTPLAN.md §6.10)', () => {
  async function logRows(harness: TestHarness): Promise<EmailLogRow[]> {
    return harness.db.select().from(emailLog).orderBy(desc(emailLog.id));
  }

  it('logs `sent` (no error code, no secret) when the channel delivers', async () => {
    const transport = recordingTransport();
    const { harness, agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const created = await agent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'logged@test.dev', username: 'logged' });
    expect(created.status).toBe(201);

    const rows = await logRows(harness);
    const row = rows.find((r) => r.recipient === 'logged@test.dev');
    expect(row).toBeDefined();
    expect(row?.status).toBe('sent');
    expect(row?.template).toBe('temp_password');
    expect(row?.errorCode).toBeNull();
    expect(row?.userId).toBe(created.body.user.id);
    // No body or secret is ever stored.
    expect(JSON.stringify(row)).not.toContain(created.body.tempPassword);
    expect(JSON.stringify(row)).not.toContain('super-secret-smtp-pass');
  });

  it('logs `suppressed` when SMTP is unconfigured', async () => {
    const transport = recordingTransport();
    const { harness, agent } = await adminHarness({ emailTransport: transport });

    const created = await agent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'suppressed@test.dev', username: 'suppressed' });
    expect(created.status).toBe(201);

    const rows = await logRows(harness);
    const row = rows.find((r) => r.recipient === 'suppressed@test.dev');
    expect(row?.status).toBe('suppressed');
    expect(row?.errorCode).toBeNull();
    expect(transport.sent).toHaveLength(0);
  });

  it('logs `failed` with a coarse error code on a transport error', async () => {
    const transport = recordingTransport({ fail: true });
    const { harness, agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    const created = await agent
      .post('/api/v1/admin/users')
      .set(...XRW)
      .send({ email: 'failed@test.dev', username: 'failed' });
    expect(created.status).toBe(201);

    const rows = await logRows(harness);
    const row = rows.find((r) => r.recipient === 'failed@test.dev');
    expect(row?.status).toBe('failed');
    expect(row?.errorCode).toBe('ECONNECTION');
    expect(JSON.stringify(row)).not.toContain('super-secret-smtp-pass');
  });

  it('logs an invite send with a null user_id (no account yet)', async () => {
    const transport = recordingTransport();
    const { harness, agent } = await adminHarness({ env: SMTP_ENV, emailTransport: transport });

    await agent
      .post('/api/v1/admin/invites')
      .set(...XRW)
      .send({ email: 'invitee@test.dev' });

    const rows = await logRows(harness);
    const row = rows.find((r) => r.recipient === 'invitee@test.dev');
    expect(row?.template).toBe('invite');
    expect(row?.status).toBe('sent');
    expect(row?.userId).toBeNull();
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
