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
  return setCookie.some((c) => c.startsWith('bt_sid='));
}

function login(app: Application, identifier: string, password: string) {
  return request(app)
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier, password });
}

/** Log an admin in (setup-state, so a session is minted) and return the agent. */
async function loginAdminAgent(harness: TestHarness, admin: SeededAdmin) {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: admin.email, password: admin.password });
  expect(meResponseSchema.safeParse(res.body).success).toBe(true);
  return agent;
}

/** Take a fresh admin all the way through TOTP enrollment, then sign out. */
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
  await agent.post('/api/v1/auth/logout').set(...XRW);
  return { secret, recoveryCodes: recoveryCodes! };
}

async function auditCount(harness: TestHarness, userId: string, action: string): Promise<number> {
  const rows = await harness.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, action)));
  return rows.length;
}

async function sessionRecordFor(harness: TestHarness, userId: string) {
  const keys = await harness.ctx.redis.keys('sess:*');
  for (const key of keys) {
    const raw = await harness.ctx.redis.get(key);
    if (!raw) continue;
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.userId === userId) return { key, data };
  }
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

  it('completing enrollment lifts the gate and shows recovery codes exactly once', async () => {
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
    const { recoveryCodes } = twoFactorMethodEnabledResponseSchema.parse(confirm.body);
    expect(recoveryCodes).toHaveLength(10);

    // The same enrollment session now reaches admin routes — no re-login (AC1).
    expect((await agent.get('/api/v1/admin/users')).status).toBe(200);

    const status = adminTwoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(status.setupRequired).toBe(false);
    expect(status.totpEnabled).toBe(true);
    expect(status.recoveryCodesRemaining).toBe(10);
  });

  it('rebinds only the confirming bootstrap session and rejects its sibling', async () => {
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

    // The explicitly authenticated current device was rebound to generation 1.
    expect((await current.get('/api/v1/admin/users')).status).toBe(200);
    // Its pre-enrollment sibling remains at generation 0 and cannot inherit
    // either admin authority or first-enrollment bootstrap.
    expect((await sibling.get('/api/v1/admin/security/2fa/status')).status).toBe(404);
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
    const status = adminTwoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(status.emailEnabled).toBe(true);
    expect(status.twoFactorEmail).toBe(TWO_FA_EMAIL);

    await agent.post('/api/v1/auth/logout').set(...XRW);
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
});

describe('mandatory admin-login 2FA — 2FA email change needs a fresh proof (§6.12, #400)', () => {
  it('rejects enrollment without proof and changes an enabled address with valid TOTP', async () => {
    const transport = recordingTransport();
    const harness = await createTestApp({ env: SMTP_ENV, emailTransport: transport });
    const admin = await harness.seedAdmin();

    // Enroll TOTP first, so the admin is enrolled and holds a TOTP proof.
    const agent = await loginAdminAgent(harness, admin);
    const { secret } = twoFactorEnrollResponseSchema.parse(
      (await agent.post('/api/v1/admin/security/2fa/totp/enroll').set(...XRW)).body,
    );
    await agent
      .post('/api/v1/admin/security/2fa/totp/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });

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

    const firstStatus = adminTwoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(firstStatus).toMatchObject({
      emailEnabled: true,
      twoFactorEmail: 'first@ops.test',
    });

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

    const changedStatus = adminTwoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/admin/security/2fa/status')).body,
    );
    expect(changedStatus).toMatchObject({
      emailEnabled: true,
      twoFactorEmail: 'changed@ops.test',
    });
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

  it('rejects a password-change session after DB-only break-glass until fresh login', async () => {
    const harness = await createTestApp();
    const admin = await harness.seedAdmin();
    const stale = await loginAdminAgent(harness, admin);
    const newPassword = 'admin-new-strong-password-2';

    const changed = await stale
      .post('/api/v1/auth/change-password')
      .set(...XRW)
      .send({ currentPassword: admin.password, newPassword });
    expect(changed.status).toBe(200);

    expect(await resetAdminTwoFactorEnrollment(harness.db, admin.email)).not.toBeNull();

    // The shell utility has no Redis connection, so this proves the durable
    // generation—not eager deletion—closes the bootstrap route.
    expect((await stale.get('/api/v1/admin/security/2fa/status')).status).toBe(404);

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

  it('parseIdentifier requires an identifier argument', () => {
    expect(() => parseIdentifier(['node', 'script.ts'])).toThrow(/Usage/);
    expect(parseIdentifier(['node', 'script.ts', 'admin@x.test'])).toBe('admin@x.test');
  });
});
