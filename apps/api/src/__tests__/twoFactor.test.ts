import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  twoFactorEnrollResponseSchema,
  twoFactorMethodEnabledResponseSchema,
  twoFactorStatusResponseSchema,
} from '@bettertrack/contracts';

import { auditLog } from '../data/schema';
import type { MailTransport, OutgoingMail } from '../services/email/transport';
import { generateTotpCode } from '../services/auth/totp';
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

function recordingTransport(): MailTransport & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

let harness: TestHarness;

async function boot(options: CreateTestAppOptions = {}) {
  harness = await createTestApp(options);
}

beforeEach(async () => {
  await boot();
});

async function loginAgent(email: string, password: string) {
  const agent = request.agent(harness.app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set(...XRW)
    .send({ identifier: email, password });
  expect(res.status).toBe(200);
  return agent;
}

async function auditCount(userId: string, action: string): Promise<number> {
  const rows = await harness.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.targetId, userId), eq(auditLog.action, action)));
  return rows.length;
}

describe('2FA endpoints — authenticator method (§6.1, §13.2 V2-P5)', () => {
  it('runs enroll → confirm → status → disable, audit-logging each mutation', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);

    // Enroll: provisional secret + otpauth URI, TOTP not yet on.
    const enroll = await agent.post('/api/v1/auth/2fa/enroll').set(...XRW);
    expect(enroll.status).toBe(200);
    const { secret } = twoFactorEnrollResponseSchema.parse(enroll.body);
    expect(enroll.body.otpauthUri).toContain('otpauth://totp/');

    let status = twoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/auth/2fa/status')).body,
    );
    expect(status).toMatchObject({ totpEnabled: false, totpPending: true, emailEnabled: false });

    // A wrong code does not enable it.
    const badConfirm = await agent
      .post('/api/v1/auth/2fa/confirm')
      .set(...XRW)
      .send({ code: '000000' });
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');

    // A valid code enables the method and returns the (first-method) recovery codes.
    const confirm = await agent
      .post('/api/v1/auth/2fa/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(confirm.status).toBe(200);
    const { recoveryCodes } = twoFactorMethodEnabledResponseSchema.parse(confirm.body);
    expect(recoveryCodes).not.toBeNull();

    status = twoFactorStatusResponseSchema.parse((await agent.get('/api/v1/auth/2fa/status')).body);
    expect(status).toMatchObject({
      totpEnabled: true,
      totpPending: false,
      recoveryCodesRemaining: recoveryCodes!.length,
    });

    // Disable with a valid TOTP code clears it.
    const disable = await agent
      .post('/api/v1/auth/2fa/disable')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(disable.status).toBe(200);

    status = twoFactorStatusResponseSchema.parse((await agent.get('/api/v1/auth/2fa/status')).body);
    expect(status).toMatchObject({
      totpEnabled: false,
      totpPending: false,
      emailEnabled: false,
      recoveryCodesRemaining: 0,
    });

    // Each mutation left an audit trail.
    expect(await auditCount(user.id, 'two_factor.enrolled')).toBe(1);
    expect(await auditCount(user.id, 'two_factor.confirmed')).toBe(1);
    expect(await auditCount(user.id, 'two_factor.disabled')).toBe(1);
  });

  it('regenerates recovery codes and audit-logs it', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);

    const { secret } = twoFactorEnrollResponseSchema.parse(
      (await agent.post('/api/v1/auth/2fa/enroll').set(...XRW)).body,
    );
    const first = twoFactorMethodEnabledResponseSchema.parse(
      (
        await agent
          .post('/api/v1/auth/2fa/confirm')
          .set(...XRW)
          .send({ code: generateTotpCode(secret) })
      ).body,
    ).recoveryCodes;

    const regen = await agent.post('/api/v1/auth/2fa/recovery-codes').set(...XRW);
    expect(regen.status).toBe(200);
    const second = twoFactorMethodEnabledResponseSchema.parse(regen.body).recoveryCodes;
    expect(second).not.toBeNull();
    expect(second).not.toEqual(first);
    expect(await auditCount(user.id, 'two_factor.recovery_regenerated')).toBe(1);
  });

  it('rejects unauthenticated calls with 401', async () => {
    const anon = request(harness.app);
    expect((await anon.get('/api/v1/auth/2fa/status')).status).toBe(401);
    expect((await anon.post('/api/v1/auth/2fa/enroll').set(...XRW)).status).toBe(401);
  });

  it('rejects admin-kind sessions with 403 ADMIN_ACCOUNT_KIND', async () => {
    const admin = await harness.seedAdmin();
    const agent = await loginAgent(admin.email, admin.password);

    const status = await agent.get('/api/v1/auth/2fa/status');
    expect(status.status).toBe(403);
    expect(status.body.error.code).toBe('ADMIN_ACCOUNT_KIND');

    const enroll = await agent.post('/api/v1/auth/2fa/enroll').set(...XRW);
    expect(enroll.status).toBe(403);
    expect(enroll.body.error.code).toBe('ADMIN_ACCOUNT_KIND');
  });
});

describe('2FA endpoints — email-code method (§6.1, #298)', () => {
  it('enrolls email 2FA (TOTP never set) via an emailed code and reports it in status', async () => {
    const transport = recordingTransport();
    await boot({ env: SMTP_ENV, emailTransport: transport });
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);

    const enroll = await agent.post('/api/v1/auth/2fa/email/enroll').set(...XRW);
    expect(enroll.status).toBe(200);
    expect(enroll.body).toEqual({ ok: true });

    // The setup code is delivered (and logged to email_log — see login2fa test).
    expect(transport.sent).toHaveLength(1);
    const code = transport.sent[0]!.text.match(/\b(\d{6})\b/)![1]!;

    const confirm = await agent
      .post('/api/v1/auth/2fa/email/confirm')
      .set(...XRW)
      .send({ code });
    expect(confirm.status).toBe(200);
    const { recoveryCodes } = twoFactorMethodEnabledResponseSchema.parse(confirm.body);
    expect(recoveryCodes).not.toBeNull();

    const status = twoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/auth/2fa/status')).body,
    );
    expect(status).toMatchObject({ totpEnabled: false, emailEnabled: true });

    // Disable turns just the email method off.
    const disable = await agent.post('/api/v1/auth/2fa/email/disable').set(...XRW);
    expect(disable.status).toBe(200);
    const after = twoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/auth/2fa/status')).body,
    );
    expect(after).toMatchObject({ emailEnabled: false, recoveryCodesRemaining: 0 });

    expect(await auditCount(user.id, 'two_factor.email_enabled')).toBe(1);
    expect(await auditCount(user.id, 'two_factor.email_disabled')).toBe(1);
  });

  it('rejects enabling email 2FA as the only method when SMTP is unconfigured', async () => {
    // Default harness: no SMTP configured.
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);

    const enroll = await agent.post('/api/v1/auth/2fa/email/enroll').set(...XRW);
    expect(enroll.status).toBe(400);
    expect(enroll.body.error.code).toBe('TWO_FACTOR_EMAIL_UNAVAILABLE');

    const status = twoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/auth/2fa/status')).body,
    );
    expect(status.emailEnabled).toBe(false);
  });
});
