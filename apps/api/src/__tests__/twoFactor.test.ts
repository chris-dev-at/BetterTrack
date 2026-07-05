import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  twoFactorEnrollResponseSchema,
  twoFactorRecoveryCodesResponseSchema,
  twoFactorStatusResponseSchema,
} from '@bettertrack/contracts';

import { auditLog } from '../data/schema';
import { generateTotpCode } from '../services/auth/totp';
import { createTestApp, type TestHarness } from '../testing/createTestApp';

const XRW = ['X-Requested-With', 'BetterTrack'] as const;

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
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

describe('2FA endpoints (§6.1, §13.2 V2-P5)', () => {
  it('runs enroll → confirm → status → disable, audit-logging each mutation', async () => {
    const user = await harness.seedUser();
    const agent = await loginAgent(user.email, user.password);

    // Enroll: provisional secret + otpauth URI, 2FA not yet on.
    const enroll = await agent.post('/api/v1/auth/2fa/enroll').set(...XRW);
    expect(enroll.status).toBe(200);
    const { secret } = twoFactorEnrollResponseSchema.parse(enroll.body);
    expect(enroll.body.otpauthUri).toContain('otpauth://totp/');

    let status = twoFactorStatusResponseSchema.parse(
      (await agent.get('/api/v1/auth/2fa/status')).body,
    );
    expect(status).toMatchObject({ enabled: false, pending: true });

    // A wrong code does not enable it.
    const badConfirm = await agent
      .post('/api/v1/auth/2fa/confirm')
      .set(...XRW)
      .send({ code: '000000' });
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.body.error.code).toBe('TWO_FACTOR_INVALID_CODE');

    // A valid code enables 2FA and returns the recovery codes.
    const confirm = await agent
      .post('/api/v1/auth/2fa/confirm')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(confirm.status).toBe(200);
    const { recoveryCodes } = twoFactorRecoveryCodesResponseSchema.parse(confirm.body);

    status = twoFactorStatusResponseSchema.parse((await agent.get('/api/v1/auth/2fa/status')).body);
    expect(status).toMatchObject({
      enabled: true,
      pending: false,
      recoveryCodesRemaining: recoveryCodes.length,
    });

    // Disable with a valid TOTP code clears it.
    const disable = await agent
      .post('/api/v1/auth/2fa/disable')
      .set(...XRW)
      .send({ code: generateTotpCode(secret) });
    expect(disable.status).toBe(200);

    status = twoFactorStatusResponseSchema.parse((await agent.get('/api/v1/auth/2fa/status')).body);
    expect(status).toMatchObject({ enabled: false, pending: false, recoveryCodesRemaining: 0 });

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
    const first = twoFactorRecoveryCodesResponseSchema.parse(
      (
        await agent
          .post('/api/v1/auth/2fa/confirm')
          .set(...XRW)
          .send({ code: generateTotpCode(secret) })
      ).body,
    ).recoveryCodes;

    const regen = await agent.post('/api/v1/auth/2fa/recovery-codes').set(...XRW);
    expect(regen.status).toBe(200);
    const second = twoFactorRecoveryCodesResponseSchema.parse(regen.body).recoveryCodes;
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
