import { eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import { publicRegistrationInfoResponseSchema } from '@bettertrack/contracts';

import { registrationTokens } from '../data/schema';
import { hashToken } from '../services/crypto/tokens';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import { createTestApp, type SeededAdmin, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

// SMTP env that flips config.email.enabled on (host + from are the deciders), so
// decision / welcome mails actually route to the recording transport.
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

async function setMode(
  agent: ReturnType<typeof request.agent>,
  mode: 'closed' | 'invite_token' | 'approval' | 'open',
) {
  const res = await agent.patch('/api/v1/admin/settings').set(...XRW).send({ registrationMode: mode });
  expect(res.status).toBe(200);
  expect(res.body.registrationMode).toBe(mode);
}

function register(app: Application, body: Record<string, unknown>) {
  return request(app).post('/api/v1/auth/register').set(...XRW).send(body);
}

function login(app: Application, identifier: string, password: string) {
  return request(app).post('/api/v1/auth/login').set(...XRW).send({ identifier, password });
}

/** Pull the raw registration token out of a create response's register URL. */
function tokenFromUrl(registerUrl: string): string {
  const raw = new URL(registerUrl).searchParams.get('token');
  expect(typeof raw).toBe('string');
  return raw as string;
}

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

describe('registration mode matrix (PROJECTPLAN.md §6.12, §13.4 V4-P4a)', () => {
  const applicant = {
    email: 'walkin@test.dev',
    username: 'walkin_user',
    password: 'walkin-strong-pass-1',
  };

  it('closed → 403 REGISTRATION_CLOSED and no account is created (regression)', async () => {
    // Default is closed; no mode switch needed.
    const res = await register(harness.app, applicant);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('REGISTRATION_CLOSED');

    const attempt = await login(harness.app, applicant.email, applicant.password);
    expect(attempt.status).toBe(401);
  });

  it('open → account created and signed straight in', async () => {
    await setMode(adminAgent, 'open');

    const res = await register(harness.app, applicant);
    expect(res.status).toBe(201);
    expect(res.body.email).toBe(applicant.email);
    expect(res.body.status).toBe('active');
    // A session cookie was set (open mode signs the account straight in).
    expect(res.headers['set-cookie']).toBeDefined();

    // The account is real and can log in.
    const relog = await login(harness.app, applicant.email, applicant.password);
    expect(relog.status).toBe(200);

    // A welcome mail went out.
    expect(transport.sent.some((m) => m.to === applicant.email)).toBe(true);
  });

  it('invite_token → a valid token is required', async () => {
    await setMode(adminAgent, 'invite_token');

    // Missing token.
    const missing = await register(harness.app, applicant);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('REGISTRATION_TOKEN_REQUIRED');

    // Bogus token.
    const bogus = await register(harness.app, { ...applicant, inviteToken: 'not-a-real-token' });
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.code).toBe('INVALID_REGISTRATION_TOKEN');

    // Real token → success.
    const created = await adminAgent
      .post('/api/v1/admin/registration-tokens')
      .set(...XRW)
      .send({});
    expect(created.status).toBe(201);
    const token = tokenFromUrl(created.body.registerUrl);

    const ok = await register(harness.app, { ...applicant, inviteToken: token });
    expect(ok.status).toBe(201);
    expect(ok.body.email).toBe(applicant.email);
  });

  it('approval → account lands pending with no session; cannot log in until approved', async () => {
    await setMode(adminAgent, 'approval');

    const res = await register(harness.app, applicant);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ pending: true });
    // No session cookie is minted for a pending applicant.
    expect(res.headers['set-cookie']).toBeUndefined();

    // The pending applicant cannot log in — there is no account yet.
    const attempt = await login(harness.app, applicant.email, applicant.password);
    expect(attempt.status).toBe(401);
  });
});

describe('invite tokens — single / multi-use / expiry (§13.4 V4-P4a)', () => {
  beforeEach(async () => {
    await setMode(adminAgent, 'invite_token');
  });

  it('a single-use token dies after one registration', async () => {
    const created = await adminAgent
      .post('/api/v1/admin/registration-tokens')
      .set(...XRW)
      .send({ maxUses: 1 });
    expect(created.status).toBe(201);
    const token = tokenFromUrl(created.body.registerUrl);

    const first = await register(harness.app, {
      email: 'one@test.dev',
      username: 'one_user',
      password: 'one-strong-pass-1',
      inviteToken: token,
    });
    expect(first.status).toBe(201);

    const second = await register(harness.app, {
      email: 'two@test.dev',
      username: 'two_user',
      password: 'two-strong-pass-1',
      inviteToken: token,
    });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('INVALID_REGISTRATION_TOKEN');
  });

  it('a multi-use token enforces its use limit', async () => {
    const created = await adminAgent
      .post('/api/v1/admin/registration-tokens')
      .set(...XRW)
      .send({ maxUses: 2 });
    const token = tokenFromUrl(created.body.registerUrl);

    for (const n of [1, 2]) {
      const res = await register(harness.app, {
        email: `m${n}@test.dev`,
        username: `m${n}_user`,
        password: `multi-strong-pass-${n}`,
        inviteToken: token,
      });
      expect(res.status).toBe(201);
    }

    const overflow = await register(harness.app, {
      email: 'm3@test.dev',
      username: 'm3_user',
      password: 'multi-strong-pass-3',
      inviteToken: token,
    });
    expect(overflow.status).toBe(400);
    expect(overflow.body.error.code).toBe('INVALID_REGISTRATION_TOKEN');
  });

  it('an expired token is rejected', async () => {
    const created = await adminAgent
      .post('/api/v1/admin/registration-tokens')
      .set(...XRW)
      .send({ maxUses: 5, expiresInDays: 1 });
    const token = tokenFromUrl(created.body.registerUrl);

    // Force the token into the past.
    await harness.db
      .update(registrationTokens)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(registrationTokens.tokenHash, hashToken(token)));

    const res = await register(harness.app, {
      email: 'late@test.dev',
      username: 'late_user',
      password: 'late-strong-pass-1',
      inviteToken: token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REGISTRATION_TOKEN');
  });

  it('a revoked token is rejected', async () => {
    const created = await adminAgent
      .post('/api/v1/admin/registration-tokens')
      .set(...XRW)
      .send({ maxUses: 5 });
    const token = tokenFromUrl(created.body.registerUrl);
    const id = created.body.token.id as string;

    const revoke = await adminAgent
      .post(`/api/v1/admin/registration-tokens/${id}/revoke`)
      .set(...XRW)
      .send();
    expect(revoke.status).toBe(200);

    const res = await register(harness.app, {
      email: 'rev@test.dev',
      username: 'rev_user',
      password: 'rev-strong-pass-1',
      inviteToken: token,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REGISTRATION_TOKEN');
  });
});

describe('approval queue — approve / reject (§13.4 V4-P4a)', () => {
  const applicant = {
    email: 'queue@test.dev',
    username: 'queue_user',
    password: 'queue-strong-pass-1',
    locale: 'de',
  };

  beforeEach(async () => {
    await setMode(adminAgent, 'approval');
  });

  it('admin approve → decision email sent + login works', async () => {
    const res = await register(harness.app, applicant);
    expect(res.status).toBe(202);

    const list = await adminAgent.get('/api/v1/admin/registration-requests');
    expect(list.status).toBe(200);
    expect(list.body.requests).toHaveLength(1);
    const requestId = list.body.requests[0].id as string;
    expect(list.body.requests[0].email).toBe(applicant.email);

    const before = transport.sent.length;
    const approve = await adminAgent
      .post(`/api/v1/admin/registration-requests/${requestId}/approve`)
      .set(...XRW)
      .send();
    expect(approve.status).toBe(200);
    expect(approve.body.email).toBe(applicant.email);
    expect(approve.body.status).toBe('active');

    // A decision email went to the applicant.
    expect(transport.sent.length).toBeGreaterThan(before);
    expect(transport.sent.some((m) => m.to === applicant.email)).toBe(true);

    // The applicant can now log in.
    const relog = await login(harness.app, applicant.email, applicant.password);
    expect(relog.status).toBe(200);

    // The request is gone from the queue.
    const after = await adminAgent.get('/api/v1/admin/registration-requests');
    expect(after.body.requests).toHaveLength(0);
  });

  it('admin reject → decision email sent + no usable account', async () => {
    const res = await register(harness.app, applicant);
    expect(res.status).toBe(202);

    const list = await adminAgent.get('/api/v1/admin/registration-requests');
    const requestId = list.body.requests[0].id as string;

    const before = transport.sent.length;
    const reject = await adminAgent
      .post(`/api/v1/admin/registration-requests/${requestId}/reject`)
      .set(...XRW)
      .send();
    expect(reject.status).toBe(200);

    // A decision email went to the applicant.
    expect(transport.sent.length).toBeGreaterThan(before);
    expect(transport.sent.some((m) => m.to === applicant.email)).toBe(true);

    // No account was created — login fails and the queue is empty.
    const attempt = await login(harness.app, applicant.email, applicant.password);
    expect(attempt.status).toBe(401);
    const after = await adminAgent.get('/api/v1/admin/registration-requests');
    expect(after.body.requests).toHaveLength(0);
  });

  it('a duplicate pending application for the same email is refused', async () => {
    expect((await register(harness.app, applicant)).status).toBe(202);
    const dup = await register(harness.app, { ...applicant, username: 'other_name' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });
});

describe('admin-only + audit (§13.4 V4-P4a)', () => {
  it('token management + approve/reject are admin-only (404 to others, no leak)', async () => {
    const seededUser = await harness.seedUser();
    const userAgent = request.agent(harness.app);
    await userAgent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: seededUser.email, password: seededUser.password });

    for (const path of ['/api/v1/admin/registration-tokens', '/api/v1/admin/registration-requests']) {
      expect((await request(harness.app).get(path)).status).toBe(404);
      expect((await userAgent.get(path)).status).toBe(404);
    }
  });

  it('token creation and approval are audit-logged', async () => {
    await setMode(adminAgent, 'invite_token');
    await adminAgent.post('/api/v1/admin/registration-tokens').set(...XRW).send({});

    await setMode(adminAgent, 'approval');
    await register(harness.app, {
      email: 'audit@test.dev',
      username: 'audit_user',
      password: 'audit-strong-pass-1',
    });
    const list = await adminAgent.get('/api/v1/admin/registration-requests');
    const requestId = list.body.requests[0].id as string;
    await adminAgent
      .post(`/api/v1/admin/registration-requests/${requestId}/approve`)
      .set(...XRW)
      .send();

    const audit = await adminAgent.get('/api/v1/admin/audit');
    const actions = (audit.body.entries as Array<{ action: string }>).map((e) => e.action);
    expect(actions).toContain('registration_token.created');
    expect(actions).toContain('registration.approved');
  });
});

describe('public registration-info discovery (§13.4 V4-P4a)', () => {
  it('reflects the active mode and leaks nothing beyond it', async () => {
    for (const mode of ['closed', 'open', 'approval', 'invite_token'] as const) {
      await setMode(adminAgent, mode);
      const res = await request(harness.app).get('/api/v1/auth/registration-info');
      expect(res.status).toBe(200);
      // Strict parse: exactly { mode }, nothing else.
      expect(publicRegistrationInfoResponseSchema.parse(res.body)).toEqual({ mode });
      expect(Object.keys(res.body)).toEqual(['mode']);
    }
  });
});
