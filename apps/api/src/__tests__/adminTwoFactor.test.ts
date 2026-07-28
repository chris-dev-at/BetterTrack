import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Application } from 'express';
import { describe, expect, it, vi } from 'vitest';

import {
  adminTwoFactorStatusResponseSchema,
  meResponseSchema,
  twoFactorChallengeResponseSchema,
  twoFactorEnrollResponseSchema,
  twoFactorMethodEnabledResponseSchema,
} from '@bettertrack/contracts';

import { auditLog, users } from '../data/schema';
import { createTwoFactorRepository } from '../data/repositories/twoFactorRepository';
import { createUserRepository } from '../data/repositories/userRepository';
import { generateTotpCode } from '../services/auth/totp';
import {
  parseIdentifier,
  resetAdminTwoFactorEnrollment,
} from '../scripts/adminTwoFactorBreakGlass';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import { createTestApp, type SeededAdmin, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

// SMTP env that flips config.email.enabled on so the email method is available.
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

function lastEmailedCode(transport: { sent: OutgoingMail[] }): string {
  const mail = transport.sent.at(-1)!;
  const match = mail.text.match(/\b(\d{6})\b/);
  expect(match).not.toBeNull();
  return match![1]!;
}

function setsSessionCookie(res: request.Response): boolean {
  const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return setCookie.some(
    (cookie) =>
      cookie.startsWith('bt_sid=') && !/expires=thu, 01 jan 1970 00:00:00 gmt/i.test(cookie),
  );
}

function clearsSessionCookie(res: request.Response): boolean {
  const setCookie = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
  return setCookie.some(
    (cookie) =>
      cookie.startsWith('bt_sid=') && /expires=thu, 01 jan 1970 00:00:00 gmt/i.test(cookie),
  );
}

function login(app: Application, identifier: string, password: string) {
  return request(app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Log an admin in (setup-state, so a session is minted) and return the agent. */
async function loginAdminAgent(harness: TestHarness, admin: SeededAdmin, staySignedIn?: boolean) {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({
      identifier: admin.email,
      password: admin.password,
      ...(staySignedIn === undefined ? {} : { staySignedIn }),
    });
  expect(meResponseSchema.safeParse(res.body).success).toBe(true);
  return agent;
}

/** Perform the fresh password + TOTP login required after an admin transition. */
async function loginAdminWithTotp(harness: TestHarness, admin: SeededAdmin, secret: string) {
  const agent = request.agent(harness.app);
  const challenge = twoFactorChallengeResponseSchema.parse(
    (
      await agent
        .post('/api/v1/auth/login')
        .set(...XRW)
        .send({ identifier: admin.email, password: admin.password })
    ).body,
  );
  const verified = await agent
    .post('/api/v1/auth/2fa/verify')
    .set(...XRW)
    .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
  expect(verified.status).toBe(200);
  return agent;
}

/** Perform the fresh password + emailed-code login for an email-only admin. */
async function loginAdminWithEmail(
  harness: TestHarness,
  admin: SeededAdmin,
  transport: { sent: OutgoingMail[] },
) {
  const agent = request.agent(harness.app);
  const challenge = twoFactorChallengeResponseSchema.parse(
    (
      await agent
        .post('/api/v1/auth/login')
        .set(...XRW)
        .send({ identifier: admin.email, password: admin.password })
    ).body,
  );
  const verified = await agent
    .post('/api/v1/auth/2fa/verify')
    .set(...XRW)
    .send({ pendingToken: challenge.pendingToken, code: lastEmailedCode(transport) });
  expect(verified.status).toBe(200);
  return agent;
}

/** Take a fresh admin through TOTP enrollment; confirmation logs it out. */
async function enrollAdminTotp(harness: TestHarness, admin: SeededAdmin) {
  const agent = await loginAdminAgent(harness, admin);
  const { secret } = twoFactorEnrollResponseSchema.parse(
    (await agent.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).body,
  );
  const confirm = await agent
    .post('/api/v1/admin/security/2fa/totp/confirm')
    .set(...XRW)
    .send({ code: generateTotpCode(secret) });
  const { recoveryCodes } = twoFactorMethodEnabledResponseSchema.parse(confirm.body);
  expect(clearsSessionCookie(confirm)).toBe(true);
  return { secret, recoveryCodes: recoveryCodes! };
}

async function auditCount(harness: TestHarness, userId: string, action: string): Promise<number> {
  const rows = await harness.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, action)));
  return rows.length;
}

async function sessionRecordsFor(harness: TestHarness, userId: string) {
  const records: { key: string; sessionId: string; data: Record<string, unknown> }[] = [];
  const keys = await harness.ctx.redis.keys('sess:*');
  for (const key of keys) {
    const raw = await harness.ctx.redis.get(key);
    if (!raw) continue;
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.userId === userId) {
      records.push({ key, sessionId: key.slice('sess:'.length), data });
    }
  }
  return records;
}

async function sessionRecordFor(harness: TestHarness, userId: string) {
  const [record] = await sessionRecordsFor(harness, userId);
  if (record) return record;
  throw new Error(`No session found for ${userId}`);
}

describe('mandatory admin-login 2FA — setup gate (§6.12, #400)', () => {
  it('a fresh admin logs in with a password but is gated until enrolled', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = await loginAdminAgent(harness, admin);

    // Every admin endpoint except the 2FA set answers 403 ADMIN_2FA_SETUP_REQUIRED.
    const gated = await agent.get('/api/v1/admin/users');
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe('ADMIN_2FA_SETUP_REQUIRED');

    // The 2FA management surface stays reachable so the wizard can run.
    const status = adminTwoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(status).toMatchObject({
      setupRequired: true,
      totpEnabled: false,
      emailEnabled: false,
      twoFactorEmail: null,
      recoveryCodesRemaining: 0,
    });
  });

  it('completing enrollment logs out the acting device and a fresh login lifts the gate', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = await loginAdminAgent(harness, admin);

    const { secret } = twoFactorEnrollResponseSchema.parse(
      (await agent.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).body,
    );
    const confirm = await agent
      .post('/api/v1/admin/security/2fa/totp/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(confirm.status).toBe(200);
    expect(clearsSessionCookie(confirm)).toBe(true);
    expect(setsSessionCookie(confirm)).toBe(false);
    const { recoveryCodes } = twoFactorMethodEnabledResponseSchema.parse(confirm.body);
    expect(recoveryCodes).toHaveLength(10);

    // No session survives the factor transition, including the acting device.
    expect((await agent.get('/api/v1/admin/users')).status).toBe(404);

    const fresh = await loginAdminWithTotp(harness, admin, secret);
    expect((await fresh.get('/api/v1/admin/users')).status).toBe(200);
    const status = adminTwoFactorStatusResponseSchema.parse(
      (await fresh.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(status.setupRequired).toBe(false);
    expect(status.totpEnabled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(10);
  });

  it('invalidates the confirming bootstrap session and every sibling', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const current = await loginAdminAgent(harness, admin);
    const sibling = await loginAdminAgent(harness, admin);

    const { secret } = twoFactorEnrollResponseSchema.parse(
      (await current.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).body,
    );
    const cleanup = vi
      .spyOn(harness.ctx.redis, 'smembers')
      .mockRejectedValueOnce(new Error('simulated sibling cleanup failure'));
    const confirm = await current
      .post('/api/v1/admin/security/2fa/totp/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    cleanup.mockRestore();
    expect(confirm.status).toBe(200);
    expect(clearsSessionCookie(confirm)).toBe(true);
    expect(setsSessionCookie(confirm)).toBe(false);

    // Eager cleanup failed, but both G0 cookies are rejected by the durable G1
    // boundary and no G1 replacement was minted.
    expect((await current.get('/api/v1/admin/users')).status).toBe(404);
    expect((await sibling.get('/api/v1/admin/security/2fa/status')).status).toBe(404);
    const fresh = await loginAdminWithTotp(harness, admin, secret);
    expect((await fresh.get('/api/v1/admin/users')).status).toBe(200);
  });

  it('rechecks the captured generation at the final bootstrap gate', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const current = await loginAdminAgent(harness, admin);
    const { secret } = twoFactorEnrollResponseSchema.parse(
      (await current.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).body,
    );

    const gateEntered = deferred();
    const releaseGate = deferred();
    const readAuthorization = harness.ctx.twoFactor.getAuthorizationState.bind(
      harness.ctx.twoFactor,
    );
    let pauseOnce = true;
    const authorizationSpy = vi
      .spyOn(harness.ctx.twoFactor, 'getAuthorizationState')
      .mockImplementation(async (userId) => {
        if (pauseOnce) {
          pauseOnce = false;
          gateEntered.resolve();
          await releaseGate.promise;
        }
        return readAuthorization(userId);
      });
    const protectedHandler = vi.spyOn(harness.ctx.admin, 'listUsers');

    // Request B on the same browser resolves its generation-0 session, then
    // stops at the last gate.
    const staleRequest = current.get('/api/v1/admin/users').then((response) => response);
    await gateEntered.promise;

    // Request A commits first-factor enrollment at generation 1 and logs out
    // every cookie before B is allowed to finish.
    const confirm = await current
      .post('/api/v1/admin/security/2fa/totp/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(confirm.status).toBe(200);
    expect(clearsSessionCookie(confirm)).toBe(true);

    // B must compare its captured G0 with the factor-state read at G1 instead of
    // inheriting the newly enabled administrator assurance.
    releaseGate.resolve();
    const denied = await staleRequest;
    authorizationSpy.mockRestore();
    expect(denied.status).toBe(401);
    expect(setsSessionCookie(denied)).toBe(false);
    expect(protectedHandler).not.toHaveBeenCalled();
    protectedHandler.mockRestore();

    // B finishes last and cannot restore the old cookie. Only a fresh explicit
    // password + factor login establishes a new session.
    expect((await current.get('/api/v1/admin/users')).status).toBe(404);
    const fresh = await loginAdminWithTotp(harness, admin, secret);
    expect((await fresh.get('/api/v1/admin/users')).status).toBe(200);
  });

  it('rejects bootstrap status when break-glass advances the captured generation', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = await loginAdminAgent(harness, admin);
    const statusEntered = deferred();
    const releaseStatus = deferred();
    const status = harness.ctx.adminTwoFactor.status.bind(harness.ctx.adminTwoFactor);
    const statusSpy = vi
      .spyOn(harness.ctx.adminTwoFactor, 'status')
      .mockImplementation(async (...args) => {
        statusEntered.resolve();
        await releaseStatus.promise;
        return status(...args);
      });

    // The route has already captured G0 before the service read is paused.
    const staleStatus = agent.get('/api/v1/admin/security/2fa/status').then((response) => response);
    await statusEntered.promise;
    expect(await resetAdminTwoFactorEnrollment(harness.db, admin.email)).not.toBeNull();
    releaseStatus.resolve();

    const denied = await staleStatus;
    statusSpy.mockRestore();
    expect(denied.status).toBe(401);
    expect(setsSessionCookie(denied)).toBe(false);
  });

  it('does not send or persist email setup after break-glass wins following factor proof', async () => {
    const transport = recordingTransport();
    const harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    const admin = await harness.seedAdmin();
    const { secret } = await enrollAdminTotp(harness, admin);
    const agent = await loginAdminWithTotp(harness, admin, secret);
    const proofChecked = deferred();
    const releaseProof = deferred();
    const verifyTotp = harness.ctx.twoFactor.verifyTotpCode.bind(harness.ctx.twoFactor);
    const verifySpy = vi
      .spyOn(harness.ctx.twoFactor, 'verifyTotpCode')
      .mockImplementation(async (...args) => {
        const valid = await verifyTotp(...args);
        proofChecked.resolve();
        await releaseProof.promise;
        return valid;
      });

    const staleStart = agent
      .post('/api/v1/admin/security/2fa/email/start')
      .set(...XRW)
      .send({ email: 'stale@ops.test', proof: generateTotpCode(secret) })
      .then((response) => response);
    await proofChecked.promise;
    expect(await resetAdminTwoFactorEnrollment(harness.db, admin.email)).not.toBeNull();
    releaseProof.resolve();

    const denied = await staleStart;
    verifySpy.mockRestore();
    expect(denied.status).toBe(401);
    expect(transport.sent).toHaveLength(0);
    expect(await harness.ctx.redis.get(`admin_2fa_email_setup:${admin.id}`)).toBeNull();
  });

  it('fails legacy, malformed, and mismatched bootstrap sessions closed', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();

    for (const corrupt of [
      (data: Record<string, unknown>) => {
        delete data.securityGeneration;
      },
      (data: Record<string, unknown>) => {
        data.securityGeneration = '0';
      },
      (data: Record<string, unknown>) => {
        data.securityGeneration = 99;
      },
    ]) {
      const agent = await loginAdminAgent(harness, admin);
      const { key, data } = await sessionRecordFor(harness, admin.id);
      corrupt(data);
      await harness.ctx.redis.set(key, JSON.stringify(data), 'EX', 3600);

      const denied = await agent.get('/api/v1/admin/security/2fa/status');
      expect(denied.status).toBe(404);
      expect(await harness.ctx.redis.get(key)).toBeNull();
    }
  });
});

describe('mandatory admin-login 2FA — login challenge (§6.12, #400)', () => {
  it('an enrolled admin gets a challenge; a valid TOTP promotes it to a session', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const { secret } = await enrollAdminTotp(harness, admin);

    const challengeRes = await login(harness.app, admin.email, admin.password);
    const challenge = twoFactorChallengeResponseSchema.parse(challengeRes.body);
    expect(challenge.channels).toContain('totp');
    expect(setsSessionCookie(challengeRes)).toBe(false);

    // The pending token opens no admin route (AC6: enrolled-but-unchallenged).
    const withPending = await request(harness.app)
      .get('/api/v1/admin/users')
      .set('Cookie', `bt_sid=${challenge.pendingToken}`);
    expect(withPending.status).toBe(404);

    const agent = request.agent(harness.app);
    const verify = await agent
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: generateTotpCode(secret) });
    expect(verify.status).toBe(200);
    // The freshly minted session reaches admin routes normally.
    expect((await agent.get('/api/v1/admin/users')).status).toBe(200);
  });

  it('a wrong code is rejected and no session is minted', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    await enrollAdminTotp(harness, admin);

    const challenge = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, admin.email, admin.password)).body,
    );
    const verify = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: '000000' });
    expect(verify.status).toBe(401);
    expect(verify.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
    expect(setsSessionCookie(verify)).toBe(false);
  });

  it('a recovery code completes the challenge and is single-use', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const { recoveryCodes } = await enrollAdminTotp(harness, admin);

    const first = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, admin.email, admin.password)).body,
    );
    const ok = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: first.pendingToken, recoveryCode: recoveryCodes[0] });
    expect(ok.status).toBe(200);

    const second = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, admin.email, admin.password)).body,
    );
    const reuse = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: second.pendingToken, recoveryCode: recoveryCodes[0] });
    expect(reuse.status).toBe(401);
  });
});

describe('mandatory admin-login 2FA — email OTP to the 2FA email (§6.12, #400)', () => {
  const TWO_FA_EMAIL = '2fa-inbox@ops.test';

  it('enrolls the email method to a separate address; login codes go there, never the account email', async () => {
    const transport = recordingTransport();
    const harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    const admin = await harness.seedAdmin();
    expect(admin.email).not.toBe(TWO_FA_EMAIL);

    const agent = await loginAdminAgent(harness, admin);
    const start = await agent
      .post('/api/v1/admin/security/2fa/email/start')
      .set(...XRW)
      .send({ email: TWO_FA_EMAIL });
    expect(start.status).toBe(204);
    // The setup code went to the chosen 2FA email, not the account email.
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe(TWO_FA_EMAIL);

    const confirm = await agent
      .post('/api/v1/admin/security/2fa/email/confirm')
      .set(...XRW)
      .send({ code: lastEmailedCode(transport) });
    expect(confirm.status).toBe(200);
    expect(clearsSessionCookie(confirm)).toBe(true);
    const authenticated = await loginAdminWithEmail(harness, admin, transport);
    const status = adminTwoFactorStatusResponseSchema.parse(
      (await authenticated.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(status.emailEnabled).toBe(true);
    expect(status.twoFactorEmail).toBe(TWO_FA_EMAIL);

    await authenticated.post('/api/v1/auth/logout').set(...XRW);
    transport.sent.length = 0;

    // Login now issues a challenge and auto-sends the code to the 2FA email.
    const challenge = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, admin.email, admin.password)).body,
    );
    expect(challenge.channels).toContain('email');
    expect(challenge.channels).not.toContain('totp');
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.to).toBe(TWO_FA_EMAIL);
    expect(transport.sent[0]!.to).not.toBe(admin.email);

    const verify = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: challenge.pendingToken, code: lastEmailedCode(transport) });
    expect(verify.status).toBe(200);
  });

  it('rejects and deletes an admin email setup code after a generation transition', async () => {
    const transport = recordingTransport();
    const harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    const admin = await harness.seedAdmin();
    const stale = await loginAdminAgent(harness, admin);

    const started = await stale
      .post('/api/v1/admin/security/2fa/email/start')
      .set(...XRW)
      .send({ email: TWO_FA_EMAIL });
    expect(started.status).toBe(204);
    const staleCode = lastEmailedCode(transport);
    expect(
      JSON.parse((await harness.ctx.redis.get(`admin_2fa_email_setup:${admin.id}`))!),
    ).toMatchObject({ securityGeneration: 0 });

    expect(await resetAdminTwoFactorEnrollment(harness.db, admin.email)).not.toBeNull();
    const fresh = await loginAdminAgent(harness, admin);
    const rejected = await fresh
      .post('/api/v1/admin/security/2fa/email/confirm')
      .set(...XRW)
      .send({ code: staleCode });

    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
    expect(await harness.ctx.redis.get(`admin_2fa_email_setup:${admin.id}`)).toBeNull();
    expect((await harness.ctx.twoFactor.getMethods(admin.id)).email).toBe(false);
  });
});

describe('mandatory admin-login 2FA — 2FA email change needs a fresh proof (§6.12, #400)', () => {
  it('rejects enrollment without proof and changes an enabled address with valid TOTP', async () => {
    const transport = recordingTransport();
    const harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    const admin = await harness.seedAdmin();

    // Enroll TOTP first, so the admin is enrolled and holds a TOTP proof.
    const bootstrap = await loginAdminAgent(harness, admin);
    const { secret } = twoFactorEnrollResponseSchema.parse(
      (await bootstrap.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).body,
    );
    const totpConfirm = await bootstrap
      .post('/api/v1/admin/security/2fa/totp/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(clearsSessionCookie(totpConfirm)).toBe(true);
    let agent = await loginAdminWithTotp(harness, admin, secret);

    // Setting the 2FA email while already enrolled requires a fresh proof.
    const noProof = await agent
      .post('/api/v1/admin/security/2fa/email/start')
      .set(...XRW)
      .send({ email: 'first@ops.test' });
    expect(noProof.status).toBe(401);
    expect(noProof.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');
    expect(transport.sent).toHaveLength(0);

    const withProof = await agent
      .post('/api/v1/admin/security/2fa/email/start')
      .set(...XRW)
      .send({ email: 'first@ops.test', proof: generateTotpCode(secret) });
    expect(withProof.status).toBe(204);
    expect(transport.sent.at(-1)!.to).toBe('first@ops.test');
    const confirm = await agent
      .post('/api/v1/admin/security/2fa/email/confirm')
      .set(...XRW)
      .send({ code: lastEmailedCode(transport) });
    expect(confirm.status).toBe(200);
    expect(clearsSessionCookie(confirm)).toBe(true);

    agent = await loginAdminWithTotp(harness, admin, secret);
    const firstStatus = adminTwoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(firstStatus).toMatchObject({
      emailEnabled: true,
      twoFactorEmail: 'first@ops.test',
    });

    // Issue a separate login challenge and send its code to the old address.
    // The address-change commit below must invalidate both pieces of authority.
    const staleChallenge = twoFactorChallengeResponseSchema.parse(
      (await login(harness.app, admin.email, admin.password)).body,
    );
    const staleCodeRequest = await request(harness.app)
      .post('/api/v1/auth/2fa/email-code')
      .set(...XRW)
      .send({ pendingToken: staleChallenge.pendingToken });
    expect(staleCodeRequest.status).toBe(200);
    expect(transport.sent.at(-1)!.to).toBe('first@ops.test');
    const staleLoginCode = lastEmailedCode(transport);

    // Confirming another freshly-proved address is an update of the already
    // enabled method, not a second enrollment.
    const change = await agent
      .post('/api/v1/admin/security/2fa/email/start')
      .set(...XRW)
      .send({ email: 'changed@ops.test', proof: generateTotpCode(secret) });
    expect(change.status).toBe(204);
    expect(transport.sent.at(-1)!.to).toBe('changed@ops.test');

    const changeConfirm = await agent
      .post('/api/v1/admin/security/2fa/email/confirm')
      .set(...XRW)
      .send({ code: lastEmailedCode(transport) });
    expect(changeConfirm.status).toBe(200);
    expect(clearsSessionCookie(changeConfirm)).toBe(true);

    agent = await loginAdminWithTotp(harness, admin, secret);
    const changedStatus = adminTwoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(changedStatus).toMatchObject({
      emailEnabled: true,
      twoFactorEmail: 'changed@ops.test',
    });

    // A code already sent to the old 2FA address cannot cross the durable
    // generation transition and mint a current administrator session.
    const staleVerify = await request(harness.app)
      .post('/api/v1/auth/2fa/verify')
      .set(...XRW)
      .send({ pendingToken: staleChallenge.pendingToken, code: staleLoginCode });
    expect(staleVerify.status).toBe(401);
    expect(staleVerify.body.error.code).toBe('TWO_FACTOR_PENDING_INVALID');
    expect(setsSessionCookie(staleVerify)).toBe(false);
    expect(await harness.ctx.redis.get(`pending2fa:${staleChallenge.pendingToken}`)).toBeNull();
    expect(await harness.ctx.redis.get(`2fa_email_code:${staleChallenge.pendingToken}`)).toBeNull();
  });
});

describe('mandatory admin-login 2FA — isolation from user surface (§6.12, #400)', () => {
  it('a non-admin cannot reach the admin 2FA endpoints (404)', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    const agent = request.agent(harness.app);
    await agent
      .post('/api/v1/auth/login')
      .set(...XRW)
      .send({ identifier: user.email, password: user.password });

    expect((await agent.get('/api/v1/admin/security/2fa/status')).status).toBe(404);
    expect((await agent.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).status).toBe(
      404,
    );
  });

  it('an admin cannot reach the user 2FA endpoints (disjoint account kinds)', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const agent = await loginAdminAgent(harness, admin);

    // The user 2FA management endpoints are fenced to user-kind accounts.
    const res = await agent.get('/api/v1/auth/2fa/status');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ADMIN_ACCOUNT_KIND');
  });
});

describe('mandatory admin-login 2FA — break-glass reset (§6.12, #400)', () => {
  it('resets a named admin back into the setup state and writes an audit row', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    await enrollAdminTotp(harness, admin);
    expect(await harness.ctx.twoFactor.isEnabled(admin.id)).toBe(true);

    const result = await resetAdminTwoFactorEnrollment(harness.db, admin.email);
    expect(result).toMatchObject({ id: admin.id, email: admin.email });
    expect(await harness.ctx.twoFactor.isEnabled(admin.id)).toBe(false);
    expect(await auditCount(harness, admin.id, 'admin.two_factor_reset')).toBe(1);
    const [reset] = await harness.db
      .select({ securityGeneration: users.securityGeneration })
      .from(users)
      .where(eq(users.id, admin.id));
    expect(reset?.securityGeneration).toBe(2);

    // Post-reset: password login succeeds (no challenge) but is gated to setup.
    const agent = await loginAdminAgent(harness, admin);
    const gated = await agent.get('/api/v1/admin/users');
    expect(gated.status).toBe(403);
    expect(gated.body.error.code).toBe('ADMIN_2FA_SETUP_REQUIRED');
  });

  it('rejects a session captured before DB-only break-glass until fresh login', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const stale = await loginAdminAgent(harness, admin);
    const newPassword = 'admin-new-strong-password-2';

    const changed = await stale
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: admin.password, newPassword });
    expect(changed.status).toBe(200);
    expect(clearsSessionCookie(changed)).toBe(true);

    const beforeReset = await loginAdminAgent(harness, { ...admin, password: newPassword });
    expect(await resetAdminTwoFactorEnrollment(harness.db, admin.email)).not.toBeNull();

    // The shell utility has no Redis connection, so this proves the durable
    // generation—not eager deletion—closes the bootstrap route.
    expect((await beforeReset.get('/api/v1/admin/security/2fa/status')).status).toBe(404);

    const fresh = await loginAdminAgent(harness, { ...admin, password: newPassword });
    const status = await fresh.get('/api/v1/admin/security/2fa/status');
    expect(status.status).toBe(200);
    expect(adminTwoFactorStatusResponseSchema.parse(status.body).setupRequired).toBe(true);
  });

  it('refuses to touch a non-admin account', async () => {
    const harness = await createTestApp();
    const user = await harness.seedUser();
    expect(await resetAdminTwoFactorEnrollment(harness.db, user.email)).toBeNull();
  });

  it('leaves factors intact when demotion wins after the admin lookup', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    await enrollAdminTotp(harness, admin);

    const usersRepo = createUserRepository(harness.db);
    const factorsRepo = createTwoFactorRepository(harness.db);

    // Model the shell command's stale pre-transaction observation, then let a
    // concurrent demotion linearize before the factor-reset update.
    const observed = await usersRepo.findByIdentifier(admin.email);
    expect(observed?.role).toBe('admin');
    expect(await usersRepo.setRole(admin.id, 'user')).toBe(2);

    // The reset statement rechecks admin-kind under the transaction. It cannot
    // clear factors or advance the generation on the now-user account.
    expect(await factorsRepo.resetAllFactorsForAdmin(observed!.id)).toBeNull();
    expect(await resetAdminTwoFactorEnrollment(harness.db, admin.email)).toBeNull();
    expect(await factorsRepo.getState(admin.id)).toMatchObject({
      enabled: true,
      securityGeneration: 2,
    });
    expect(await factorsRepo.countUnusedRecoveryCodes(admin.id)).toBe(10);
    expect(await auditCount(harness, admin.id, 'admin.two_factor_reset')).toBe(0);
  });

  it('parseIdentifier requires an identifier argument', () => {
    expect(() => parseIdentifier(['node', 'script.ts'])).toThrow(/Usage/);
    expect(parseIdentifier(['node', 'script.ts', 'admin@x.test'])).toBe('admin@x.test');
  });
});
