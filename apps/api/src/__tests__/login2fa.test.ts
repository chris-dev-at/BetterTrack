import { and, desc, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  meResponseSchema,
  twoFactorChallengeResponseSchema,
  twoFactorEnrollResponseSchema,
  twoFactorRecoveryCodesResponseSchema,
} from '@bettertrack/contracts';

import { auditLog, emailLog, type EmailLogRow } from '../data/schema';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import { generateTotpCode } from '../services/auth/totp';
import {
  createTestApp,
  type CreateTestAppOptions,
  type SeededUser,
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

function recordingTransport(): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

async function login(app: Application, identifier: string, password: string) {
  return request(app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
}

/** Seed a user and take them all the way through TOTP enrollment. */
async function enrollTotp(
  harness: TestHarness,
  user: SeededUser,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const agent = request.agent(harness.app);
  const first = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  expect(meResponseSchema.safeParse(first.body).success).toBe(true);

  const { secret } = twoFactorEnrollResponseSchema.parse(
    (await agent.post('/api/v1/auth/2fa/enroll').set(...XRW)).body,
  );
  const { recoveryCodes } = twoFactorRecoveryCodesResponseSchema.parse(
    (
      await agent
        .post('/api/v1/auth/2fa/confirm')
        .set(...XRW)
        .send({ code: generateTotpCode(secret) })
    ).body,
  );
  // Sign the enrollment agent out so it can't interfere with the login tests.
  await agent.post('/api/v1/auth/logout').set(...XRW);
  return { secret, recoveryCodes };
}

async function auditCount(harness: TestHarness, userId: string, action: string): Promise<number> {
  const rows = await harness.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, action)));
  return rows.length;
}

async function logRows(harness: TestHarness): Promise<EmailLogRow[]> {
  return harness.db.select().from(emailLog).orderBy(desc(emailLog.id));
}

/** Whether the response set a `bt_sid` session cookie. */
function setsSessionCookie(res: request.Response): boolean {
  const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return setCookie.some((c) => c.startsWith('bt_sid='));
}

let harness: TestHarness;

async function setup(options: CreateTestAppOptions = {}) {
  harness = await createTestApp(options);
  const user = await harness.seedUser();
  const { secret, recoveryCodes } = await enrollTotp(harness, user);
  return { user, secret, recoveryCodes };
}

describe('login 2FA challenge (§6.1, §13.2 V2-P5)', () => {
  beforeEach(async () => {
    harness = await createTestApp();
  });

  it('returns a challenge — not a session — for a correct password when 2FA is on', async () => {
    const { user } = await setup();

    const res = await login(harness.app, user.email, user.password);
    expect(res.status).toBe(200);
    const challenge = twoFactorChallengeResponseSchema.parse(res.body);
    expect(challenge.twoFactorRequired).toBe(true);
    expect(challenge.channels).toContain('totp');

    // No session cookie was set, so the pending state opens no protected route.
    expect(setsSessionCookie(res)).toBe(false);
    const me = await request(harness.app)
      .get('/api/v1/auth/me')
      .set('Cookie', `bt_sid=${challenge.pendingToken}`);
    expect(me.status).toBe(401);
  });

  it('promotes the challenge to a full session with a valid TOTP code', async () => {
    const { user, secret } = await setup();

    const challenge = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );

    const agent = request.agent(harness.app);
    const verify = await agent
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
    expect(verify.status).toBe(200);
    expect(meResponseSchema.parse(verify.body).email).toBe(user.email);
    // The rotated-in session id reaches protected routes.
    expect((await agent.get('/api/v1/auth/me')).status).toBe(200);

    // The pending token is single-use: a replay no longer resolves.
    const replay = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('TWO_FACTOR_PENDING_INVALID');

    expect(await auditCount(harness, user.id, 'login.success')).toBeGreaterThanOrEqual(1);
  });

  it('unlocks with a recovery code and consumes it single-use', async () => {
    const { user, recoveryCodes } = await setup();
    const code = recoveryCodes[0]!;

    const first = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );
    const verify = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: first.pendingToken, recoveryCode: code });
    expect(verify.status).toBe(200);

    // The same recovery code cannot be reused on a fresh challenge.
    const second = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );
    const reuse = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: second.pendingToken, recoveryCode: code });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
  });

  it('rejects a wrong code without minting a session', async () => {
    const { user } = await setup();
    const challenge = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );
    const verify = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: '000000' });
    expect(verify.status).toBe(401);
    expect(verify.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
    expect(setsSessionCookie(verify)).toBe(false);
  });

  it('escalates to a rate-limit lock after repeated wrong codes (§10)', async () => {
    const { user, secret } = await setup();
    const challenge = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );

    // The per-account throttle uses the loginAccount schedule (limit 10). The
    // first 10 wrong codes are plain 401s; the 11th trips the cooldown.
    let locked = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await request(harness.app)
        .post('/api/v1/auth/2fa/verify')
        .set(...XRW)
        .send({ pendingToken: challenge.pendingToken, code: '000000' });
      if (res.status === 429) {
        locked = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(locked).toBe(true);

    // While cooling down, even a correct TOTP code is rejected with 429.
    const blocked = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
    expect(blocked.status).toBe(429);
  });

  it('keeps the per-account 2FA lock across a fresh password re-login (§10)', async () => {
    const { user, secret } = await setup();
    const first = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );

    // Trip the per-account 2FA cooldown on the first challenge.
    let locked = false;
    for (let i = 0; i < 12; i += 1) {
      const res = await request(harness.app)
        .post('/api/v1/auth/2fa/verify')
        .set(...XRW)
        .send({ pendingToken: first.pendingToken, code: '000000' });
      if (res.status === 429) {
        locked = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(locked).toBe(true);

    // Re-submit the correct password. This must NOT reset the 2FA throttle —
    // the correct password is exactly what a code brute-forcer holds, so a
    // fresh pending token cannot be a way to shed the escalation lock.
    const second = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );
    expect(second.pendingToken).not.toBe(first.pendingToken);

    // The account is still cooling down, so even a correct TOTP code on the
    // brand-new pending token is rejected with 429.
    const blocked = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: second.pendingToken, code: generateTotpCode(secret) });
    expect(blocked.status).toBe(429);
    expect(setsSessionCookie(blocked)).toBe(false);
  });

  it('bounces with PENDING_INVALID when 2FA is disabled mid-challenge', async () => {
    const { user, secret } = await setup();
    const agent = request.agent(harness.app);

    // Full login (verify the challenge) so we hold a session that can disable 2FA.
    const challenge = twoFactorChallengeResponseSchema.parse(
      (
        await agent
          .post('/api/v1/auth/login')
          .set(...XRW)
          .send({
            identifier: user.email,
            password: user.password,
          })
      ).body,
    );
    const verified = await agent
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
    expect(verified.status).toBe(200);

    // Open a second pending challenge, then disable 2FA on the live session.
    const stale = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );
    const disabled = await agent
      .post('/api/v1/auth/2fa/disable')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(disabled.status).toBe(200);

    // Verifying the now-orphaned challenge bounces cleanly instead of stranding
    // the caller on wrong-code errors.
    const res = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: stale.pendingToken, code: '000000' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TWO_FACTOR_PENDING_INVALID');
  });

  it('never issues a challenge for an account without 2FA', async () => {
    const plain = await harness.seedUser({
      email: 'no2fa@test.dev',
      username: 'no2fa',
      password: 'plain-strong-password-1',
    });
    const res = await login(harness.app, plain.email, plain.password);
    expect(res.status).toBe(200);
    expect(meResponseSchema.parse(res.body).email).toBe(plain.email);
    expect(setsSessionCookie(res)).toBe(true);
  });
});

/** Latest 6-digit code delivered to the recording transport. */
function lastEmailedCode(transport: { sent: OutgoingMail[] }): string {
  const mail = transport.sent.at(-1)!;
  const match = mail.text.match(/\b(\d{6})\b/);
  expect(match).not.toBeNull();
  return match![1]!;
}

/**
 * Enable the standalone email-code method for `user` (#298). Runs on a single
 * authenticated agent — enabling a factor doesn't drop the current session — so a
 * second method can be added even after the first is on.
 */
async function enrollEmailMethod(user: SeededUser, transport: { sent: OutgoingMail[] }) {
  const agent = request.agent(harness.app);
  const first = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: user.email, password: user.password });
  // The initial login may itself be a 2FA challenge if TOTP is already on.
  if (twoFactorChallengeResponseSchema.safeParse(first.body).success) {
    throw new Error('enrollEmailMethod expects a fresh (no-2FA) session; enroll email first');
  }
  const enroll = await agent.post('/api/v1/auth/2fa/email/enroll').set(...XRW);
  expect(enroll.status).toBe(200);
  await agent
    .post('/api/v1/auth/2fa/email/confirm')
    .set(...XRW)
    .send({ code: lastEmailedCode(transport) });
  return agent;
}

describe('login 2FA email-code method (§6.1, §6.10, §13.2 V2-P5, #298)', () => {
  it('email-only account: login auto-sends a code, which unlocks the session', async () => {
    const transport = recordingTransport();
    harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    const user = await harness.seedUser();

    // Turn on ONLY the email method — TOTP is never enrolled.
    await enrollEmailMethod(user, transport);
    transport.sent.length = 0;

    const loginRes = await login(harness.app, user.email, user.password);
    const challenge = twoFactorChallengeResponseSchema.parse(loginRes.body);
    // The challenge offers email + recovery, but not TOTP.
    expect(challenge.channels).toContain('email');
    expect(challenge.channels).not.toContain('totp');
    // The session is still withheld — the challenge is not a login.
    expect(setsSessionCookie(loginRes)).toBe(false);

    // The code was sent automatically at login — no extra request needed.
    expect(transport.sent).toHaveLength(1);
    const emailedCode = lastEmailedCode(transport);

    const row = (await logRows(harness)).find((r) => r.template === 'two_factor_code');
    expect(row?.status).toBe('sent');
    // The stored log row never carries the code itself.
    expect(JSON.stringify(row)).not.toContain(emailedCode);

    const verify = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: emailedCode });
    expect(verify.status).toBe(200);
    expect(meResponseSchema.parse(verify.body).email).toBe(user.email);
  });

  it('both methods: TOTP by default, email only on request, and the emailed code unlocks', async () => {
    const transport = recordingTransport();
    harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    const user = await harness.seedUser();

    // Enroll TOTP, then add the email method on the same authenticated agent.
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
    const emailEnroll = await agent.post('/api/v1/auth/2fa/email/enroll').set(...XRW);
    expect(emailEnroll.status).toBe(200);
    await agent
      .post('/api/v1/auth/2fa/email/confirm')
      .set(...XRW)
      .send({ code: lastEmailedCode(transport) });
    await agent.post('/api/v1/auth/logout').set(...XRW);
    transport.sent.length = 0;

    const challenge = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );
    expect(challenge.channels).toEqual(expect.arrayContaining(['totp', 'email', 'recovery']));
    // TOTP is the default: nothing is emailed until the user asks.
    expect(transport.sent).toHaveLength(0);

    const requested = await request(harness.app)
      .post('/api/v1/auth/2fa/email-code')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken });
    expect(requested.status).toBe(200);
    expect(transport.sent).toHaveLength(1);

    const verify = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: lastEmailedCode(transport) });
    expect(verify.status).toBe(200);
  });

  it('TOTP-only account never offers or sends an email code', async () => {
    const { user } = await setup();

    const challenge = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, user.email, user.password)).body,
    );
    // Email is its own opt-in method now: a TOTP-only account doesn't get it.
    expect(challenge.channels).not.toContain('email');

    // Even a direct request is a no-op — no code minted, no email_log row.
    const requested = await request(harness.app)
      .post('/api/v1/auth/2fa/email-code')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken });
    expect(requested.status).toBe(200);
    const row = (await logRows(harness)).find((r) => r.template === 'two_factor_code');
    expect(row).toBeUndefined();
  });

  it('rejects an email-code request for an unknown pending token', async () => {
    await setup();
    const res = await request(harness.app)
      .post('/api/v1/auth/2fa/email-code')
      .set(...XRW)
      .send({ pendingToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TWO_FACTOR_PENDING_INVALID');
  });
});
