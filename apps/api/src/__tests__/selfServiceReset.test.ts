import { desc, eq } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import {
  meResponseSchema,
  twoFactorChallengeResponseSchema,
  twoFactorEnrollResponseSchema,
} from '@bettertrack/contracts';

import { emailLog, passwordResetTokens, type EmailLogRow } from '../data/schema';
import { generateTotpCode } from '../services/auth/totp';
import { hashToken } from '../services/crypto/tokens';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import {
  createTestApp,
  type CreateTestAppOptions,
  type SeededUser,
  type TestHarness,
} from '../testing/createTestApp';

/**
 * Self-service password reset via email (PROJECTPLAN.md §6.1, §14, §13.2 V2-P4).
 * A user who forgot their password requests a reset by email, follows the
 * tokenized link, and sets a new one — no admin involvement. Covers the
 * end-to-end flow, single-use/expiry token semantics, no-enumeration, the
 * session kill on completion, the SMTP-less suppressed path, and that only
 * user-kind accounts are eligible (admin recovery stays the #268 admin path).
 */

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

async function enabledHarness(
  extra: Partial<CreateTestAppOptions> = {},
): Promise<{ harness: TestHarness; transport: ReturnType<typeof recordingTransport> }> {
  const transport = recordingTransport();
  const harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport, ...extra });
  return { harness, transport };
}

function requestReset(harness: TestHarness, email: string) {
  return request(harness.app)
    .post('/api/v1/auth/password-reset/request')
    .set(...XRW)
    .send({ email });
}

function completeReset(harness: TestHarness, token: string, newPassword: string) {
  return request(harness.app)
    .post('/api/v1/auth/password-reset/complete')
    .set(...XRW)
    .send({ token, newPassword });
}

function login(harness: TestHarness, identifier: string, password: string) {
  return request(harness.app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
}

/** Pull the raw token out of the emailed reset link (`…/reset/<token>`). */
function tokenFromMail(mail: OutgoingMail): string {
  const token = mail.text.split('/reset/')[1]?.split(/\s/)[0];
  if (!token) throw new Error('reset URL not found in email');
  return token;
}

function logRows(harness: TestHarness): Promise<EmailLogRow[]> {
  return harness.db.select().from(emailLog).orderBy(desc(emailLog.id));
}

/** Log in, enroll + confirm TOTP 2FA for a user, then sign the enroll agent out. */
async function enrollTotp(harness: TestHarness, user: SeededUser): Promise<{ secret: string }> {
  const agent = request.agent(harness.app);
  await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  const { secret } = twoFactorEnrollResponseSchema.parse(
    (await agent.post('/api/v1/auth/2fa/enroll').set(...XRW)).body,
  );
  await agent
    .post('/api/v1/auth/2fa/confirm')
    .set(...XRW)
    .send({ code: generateTotpCode(secret) });
  await agent.post('/api/v1/auth/logout').set(...XRW);
  return { secret };
}

/** Whether the response set a `bt_sid` session cookie. */
function setsSessionCookie(res: request.Response): boolean {
  const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return setCookie.some((c) => c.startsWith('bt_sid='));
}

describe('self-service reset — end-to-end (§6.1, §14)', () => {
  it('request → emailed token → set new password → signed in, and the new password works', async () => {
    const { harness, transport } = await enabledHarness();
    const user = await harness.seedUser();

    const req = await requestReset(harness, user.email);
    expect(req.status).toBe(200);
    expect(req.body).toEqual({ ok: true });
    expect(transport.sent).toHaveLength(1);
    const mail = transport.sent[0]!;
    expect(mail.to).toBe(user.email);
    expect(mail.subject).toMatch(/reset/i);
    const token = tokenFromMail(mail);

    // Completing on a fresh agent so the response cookie is the only session.
    const agent = request.agent(harness.app);
    const done = await agent
      .post('/api/v1/auth/password-reset/complete')
      .set(...XRW)
      .send({ token, newPassword: 'fresh-self-reset-secret-1' });
    expect(done.status).toBe(200);
    const me = meResponseSchema.parse(done.body);
    expect(me.id).toBe(user.id);
    expect(me.mustChangePassword).toBe(false);

    // The completing session is live — no redundant sign-in prompt (#268).
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);
    // The old password is dead; the new one logs in.
    expect((await login(harness, user.email, user.password)).status).toBe(401);
    expect((await login(harness, user.email, 'fresh-self-reset-secret-1')).status).toBe(200);
  });

  it('writes a `sent` email_log row for the reset email (§6.10)', async () => {
    const { harness, transport } = await enabledHarness();
    const user = await harness.seedUser();

    await requestReset(harness, user.email);
    expect(transport.sent).toHaveLength(1);

    const row = (await logRows(harness)).find((r) => r.recipient === user.email);
    expect(row?.template).toBe('password_reset');
    expect(row?.status).toBe('sent');
    expect(row?.userId).toBe(user.id);
    // Never stores a token or SMTP secret.
    expect(JSON.stringify(row)).not.toContain('super-secret-smtp-pass');
  });
});

describe('self-service reset — token is single-use and expires (§6.1, §14)', () => {
  it('rejects a token that was already used', async () => {
    const { harness, transport } = await enabledHarness();
    const user = await harness.seedUser();

    await requestReset(harness, user.email);
    const token = tokenFromMail(transport.sent[0]!);

    expect((await completeReset(harness, token, 'first-use-secret-1')).status).toBe(200);
    // Reusing the same token is rejected — the account was already reset.
    const reuse = await completeReset(harness, token, 'second-use-secret-2');
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_RESET');
  });

  it('rejects an expired token', async () => {
    const { harness } = await enabledHarness();
    const user = await harness.seedUser();

    // Insert a token whose expiry is already in the past.
    const raw = 'expired-token-raw-value';
    await harness.db.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await completeReset(harness, raw, 'too-late-secret-1');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET');
  });

  it('rejects an unknown token', async () => {
    const { harness } = await enabledHarness();
    const res = await completeReset(harness, 'never-issued-token', 'nope-secret-1');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_RESET');
  });
});

describe('self-service reset — no user enumeration (§6.1)', () => {
  it('returns the same generic response for an unknown vs an existing email', async () => {
    const { harness, transport } = await enabledHarness();
    const user = await harness.seedUser();

    const known = await requestReset(harness, user.email);
    const unknown = await requestReset(harness, 'nobody-here@test.dev');

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    expect(known.body).toEqual({ ok: true });

    // Only the real account triggers a send / a token; the unknown one is inert.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe(user.email);
    const rows = await harness.db.select().from(passwordResetTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(user.id);
  });
});

describe('self-service reset — completion kills other sessions and enforces policy (§6.1)', () => {
  it('kills the user’s other live sessions on completion', async () => {
    const { harness, transport } = await enabledHarness();
    const user = await harness.seedUser();

    // An existing signed-in session on another device.
    const other = request.agent(harness.app);
    expect(
      (
        await other
          .post('/api/v1/auth/login')
          .set(...XRW)
          .send({ identifier: user.email, password: user.password })
      ).status,
    ).toBe(200);
    expect((await other.get('/api/v1/auth/me')).status).toBe(200);

    await requestReset(harness, user.email);
    const token = tokenFromMail(transport.sent[0]!);
    expect((await completeReset(harness, token, 'reset-kills-sessions-1')).status).toBe(200);

    // The pre-existing session is now dead.
    expect((await other.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('enforces the §6.1 password policy on the new password', async () => {
    const { harness, transport } = await enabledHarness();
    const user = await harness.seedUser();

    await requestReset(harness, user.email);
    const token = tokenFromMail(transport.sent[0]!);

    const weak = await completeReset(harness, token, 'password123');
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    // The token survives a rejected weak attempt, so a strong retry still works.
    expect((await completeReset(harness, token, 'strong-retry-secret-1')).status).toBe(200);
  });
});

describe('self-service reset — SMTP-less deploys and account kinds', () => {
  it('logs `suppressed` and never crashes when SMTP is unconfigured', async () => {
    // No SMTP env ⇒ channel disabled even though a transport is injected.
    const transport = recordingTransport();
    const harness = await createTestApp({ emailTransport: transport });
    const user = await harness.seedUser();

    const req = await requestReset(harness, user.email);
    expect(req.status).toBe(200);
    expect(req.body).toEqual({ ok: true });
    expect(transport.sent).toHaveLength(0);

    const row = (await logRows(harness)).find((r) => r.recipient === user.email);
    expect(row?.template).toBe('password_reset');
    expect(row?.status).toBe('suppressed');

    // The token was still issued — the reset works even with mail suppressed.
    const [tokenRow] = await harness.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));
    expect(tokenRow).toBeDefined();
  });

  it('a 2FA-enabled account gets a challenge — not a session — after completing the reset', async () => {
    const { harness, transport } = await enabledHarness();
    const user = await harness.seedUser();
    const { secret } = await enrollTotp(harness, user);

    await requestReset(harness, user.email);
    const token = tokenFromMail(transport.sent.at(-1)!);

    // Completing the reset changes the password but withholds the session: a
    // mailbox alone must not defeat the second factor (§6.1).
    const agent = request.agent(harness.app);
    const done = await agent
      .post('/api/v1/auth/password-reset/complete')
      .set(...XRW)
      .send({ token, newPassword: 'reset-with-2fa-secret-1' });
    expect(done.status).toBe(200);
    const challenge = twoFactorChallengeResponseSchema.parse(done.body);
    expect(challenge.twoFactorRequired).toBe(true);
    expect(challenge.channels).toContain('totp');
    expect(setsSessionCookie(done)).toBe(false);
    // No session yet — the completing agent cannot reach a protected route.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);

    // Presenting the second factor promotes the pending challenge to a session.
    const verify = await agent
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
    expect(verify.status).toBe(200);
    expect(setsSessionCookie(verify)).toBe(true);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);

    // The new password is in effect (though login now also requires 2FA).
    const relogin = await login(harness, user.email, 'reset-with-2fa-secret-1');
    expect(relogin.status).toBe(200);
    expect(twoFactorChallengeResponseSchema.safeParse(relogin.body).success).toBe(true);
  });

  it('does not issue a self-service reset for an admin-kind account', async () => {
    const { harness, transport } = await enabledHarness();
    const admin = await harness.seedAdmin();

    const res = await requestReset(harness, admin.email);
    // Same generic response, but no link is issued — admin recovery is the #268
    // admin temp-password path, not this user-facing flow.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(transport.sent).toHaveLength(0);
    const rows = await harness.db
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, admin.id));
    expect(rows).toHaveLength(0);
  });
});
