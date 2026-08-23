import { createHash } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../../config/env';
import { createTwoFactorRepository } from '../../../data/repositories/twoFactorRepository';
import { twoFactorRecoveryCodes, users } from '../../../data/schema';
import type { MailTransport, OutgoingMail } from '../../email/transport';
import {
  createTestApp,
  type CreateTestAppOptions,
  type TestHarness,
} from '../../../testing/createTestApp';
import { createSessionService } from '../../sessions/sessionService';
import { encryptSecret } from '../../crypto/secretBox';
import { hashToken } from '../../crypto/tokens';
import { createProgressiveLimiter } from '../../security/progressiveLimiter';
import {
  TWO_FACTOR_ACCOUNT_NAMESPACE,
  TWO_FACTOR_DISABLE_ACCOUNT_NAMESPACE,
} from '../loginThrottle';
import { generateTotpCode, normalizeRecoveryCode, TOTP_STEP_SECONDS } from '../totp';

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

let h: TestHarness;
let userId: string;

async function boot(options: CreateTestAppOptions = {}) {
  h = await createTestApp(options);
  const user = await h.seedUser();
  userId = user.id;
}

beforeEach(async () => {
  await boot();
});

afterEach(async () => {
  await h.dispose();
});

async function readUserTwoFactor() {
  const [row] = await h.db
    .select({
      secret: users.twoFactorSecret,
      enabled: users.twoFactorEnabled,
      confirmedAt: users.twoFactorConfirmedAt,
      emailEnabled: users.twoFactorEmailEnabled,
      securityGeneration: users.securityGeneration,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row!;
}

async function recoveryCodeCount(): Promise<number> {
  const rows = await h.db
    .select({ id: twoFactorRecoveryCodes.id })
    .from(twoFactorRecoveryCodes)
    .where(eq(twoFactorRecoveryCodes.userId, userId));
  return rows.length;
}

/** Pull the 6-digit code out of the most recent recorded email. */
function emailedCode(transport: { sent: OutgoingMail[] }): string {
  const mail = transport.sent.at(-1)!;
  const match = mail.text.match(/\b(\d{6})\b/);
  expect(match).not.toBeNull();
  return match![1]!;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('twoFactorService — authenticator (TOTP) method (§6.1, §13.2 V2-P5)', () => {
  it('enrolls into a provisional, not-yet-enabled state with the secret encrypted at rest', async () => {
    const { secret, otpauthUri } = await h.ctx.twoFactor.enrollTotp(userId);
    expect(otpauthUri).toContain(`secret=${secret}`);

    const row = await readUserTwoFactor();
    // Stored, but NOT the plaintext secret and NOT yet enabled.
    expect(row.secret).toBeTruthy();
    expect(row.secret).not.toBe(secret);
    expect(row.secret).not.toContain(secret);
    expect(row.secret).toMatch(/^v2\.development-v1\./);
    expect(row.enabled).toBe(false);

    const status = await h.ctx.twoFactor.status(userId);
    expect(status).toEqual({
      totpEnabled: false,
      totpPending: true,
      emailEnabled: false,
      recoveryCodesRemaining: 0,
    });
  });

  it('confirms only with a valid code, then flips enabled on and issues recovery codes', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);

    await expect(h.ctx.twoFactor.confirmTotp(userId, '000000')).rejects.toMatchObject({
      code: 'TWO_FACTOR_INVALID_CODE',
    });
    expect((await readUserTwoFactor()).enabled).toBe(false);

    const { recoveryCodes } = (await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret)))
      .response;
    expect(recoveryCodes).not.toBeNull();
    expect(recoveryCodes!.length).toBeGreaterThanOrEqual(8);

    const row = await readUserTwoFactor();
    expect(row.enabled).toBe(true);
    expect(row.confirmedAt).toBeInstanceOf(Date);

    const status = await h.ctx.twoFactor.status(userId);
    expect(status.totpEnabled).toBe(true);
    expect(status.totpPending).toBe(false);
    expect(status.recoveryCodesRemaining).toBe(recoveryCodes!.length);
  });

  it('cannot enable a replacement provisional secret after verifying the previous one', async () => {
    const first = await h.ctx.twoFactor.enrollTotp(userId);
    const firstEncryptedSecret = (await readUserTwoFactor()).secret;
    const transactionEntered = deferred();
    const releaseTransaction = deferred();
    const transaction = h.db.transaction.bind(h.db);
    const transactionSpy = vi
      .spyOn(h.db, 'transaction')
      .mockImplementationOnce(async (callback, config) => {
        transactionEntered.resolve();
        await releaseTransaction.promise;
        return transaction(callback, config);
      });

    const confirmation = h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(first.secret));
    await transactionEntered.promise;

    const replacement = await h.ctx.twoFactor.enrollTotp(userId);
    const replacementEncryptedSecret = (await readUserTwoFactor()).secret;
    expect(replacementEncryptedSecret).not.toBe(firstEncryptedSecret);

    releaseTransaction.resolve();
    await expect(confirmation).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    transactionSpy.mockRestore();

    expect(await readUserTwoFactor()).toMatchObject({
      secret: replacementEncryptedSecret,
      enabled: false,
      confirmedAt: null,
      securityGeneration: 0,
    });
    expect(await recoveryCodeCount()).toBe(0);
    await expect(
      h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(replacement.secret)),
    ).resolves.toMatchObject({
      response: { recoveryCodes: expect.any(Array) },
    });
  });

  it('invalidates the acting session and every sibling without minting a replacement', async () => {
    const sessions = createSessionService(h.ctx.redis, 3600);
    const current = await sessions.create(userId, 0, false);
    const sibling = await sessions.create(userId, 0, true);
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);

    const result = await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret), null, {
      sessionId: current,
      securityGeneration: 0,
    });

    expect(result.response.recoveryCodes).not.toBeNull();
    expect(await sessions.get(current)).toBeNull();
    expect(await sessions.get(sibling)).toBeNull();
    expect(await sessions.listForUser(userId, null)).toEqual([]);
  });

  it('stores recovery codes only as hashes, never plaintext', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const { recoveryCodes } = (await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret)))
      .response;

    const rows = await h.db
      .select({ codeHash: twoFactorRecoveryCodes.codeHash })
      .from(twoFactorRecoveryCodes)
      .where(eq(twoFactorRecoveryCodes.userId, userId));
    const stored = rows.map((r) => r.codeHash);

    for (const code of recoveryCodes!) {
      expect(stored).not.toContain(code);
      expect(stored).toContain(hashToken(normalizeRecoveryCode(code)));
    }
  });

  it('consumes a recovery code exactly once', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const { recoveryCodes } = (await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret)))
      .response;
    const repo = createTwoFactorRepository(h.db);
    const hash = hashToken(normalizeRecoveryCode(recoveryCodes![0]!));

    expect(await repo.consumeRecoveryCode(userId, hash, new Date())).toBe(true);
    // A second attempt with the same code is a no-op — single use.
    expect(await repo.consumeRecoveryCode(userId, hash, new Date())).toBe(false);
    expect(await repo.countUnusedRecoveryCodes(userId)).toBe(recoveryCodes!.length - 1);
  });

  it('disables only with a valid factor, wiping the secret AND (last-method) all recovery codes', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const { recoveryCodes } = (await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret)))
      .response;

    await expect(h.ctx.twoFactor.disableTotp(userId, '000000')).rejects.toMatchObject({
      code: 'TWO_FACTOR_INVALID_CODE',
    });
    expect((await readUserTwoFactor()).enabled).toBe(true);

    // A valid recovery code authorizes the disable.
    await h.ctx.twoFactor.disableTotp(userId, recoveryCodes![0]!);

    const row = await readUserTwoFactor();
    expect(row.enabled).toBe(false);
    expect(row.secret).toBeNull();
    expect(row.confirmedAt).toBeNull();
    // TOTP was the only method, so the shared recovery codes are gone too.
    expect(await recoveryCodeCount()).toBe(0);
  });

  it('locks TOTP disable before repeated wrong codes can be brute-forced', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));
    const validCode = generateTotpCode(secret);
    const wrongCode = validCode === '000000' ? '111111' : '000000';

    // The shared account schedule permits 10 mistakes; the 11th arms the
    // cooldown, and peek-before-verify then blocks even a correct code.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(h.ctx.twoFactor.disableTotp(userId, wrongCode)).rejects.toMatchObject({
        code: 'TWO_FACTOR_INVALID_CODE',
      });
    }
    await expect(h.ctx.twoFactor.disableTotp(userId, wrongCode)).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
    await expect(h.ctx.twoFactor.disableTotp(userId, validCode)).rejects.toMatchObject({
      statusCode: 429,
      code: 'RATE_LIMITED',
    });
    expect((await readUserTwoFactor()).enabled).toBe(true);
  });

  it('keeps TOTP-disable and login-2FA failure budgets isolated in both directions', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));
    const validCode = generateTotpCode(secret);
    const wrongCode = validCode === '000000' ? '111111' : '000000';
    const loginThrottle = createProgressiveLimiter(
      h.ctx.redis,
      TWO_FACTOR_ACCOUNT_NAMESPACE,
      h.ctx.config.rateLimits.loginAccount,
    );
    const disableThrottle = createProgressiveLimiter(
      h.ctx.redis,
      TWO_FACTOR_DISABLE_ACCOUNT_NAMESPACE,
      h.ctx.config.rateLimits.loginAccount,
    );

    // Spend the full non-cooling disable allowance. A first login failure must
    // still be admitted; the old shared namespace turned this into the 11th
    // event and armed a login cooldown.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(h.ctx.twoFactor.disableTotp(userId, wrongCode)).rejects.toMatchObject({
        code: 'TWO_FACTOR_INVALID_CODE',
      });
    }
    await expect(loginThrottle.consume(userId)).resolves.toMatchObject({ allowed: true });

    await Promise.all([loginThrottle.reset(userId), disableThrottle.reset(userId)]);

    // Reverse the pressure: ten pending-login failures must not make the first
    // authenticated disable failure return 429.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(loginThrottle.consume(userId)).resolves.toMatchObject({ allowed: true });
    }
    await expect(h.ctx.twoFactor.disableTotp(userId, wrongCode)).rejects.toMatchObject({
      statusCode: 401,
      code: 'TWO_FACTOR_INVALID_CODE',
    });
    expect((await readUserTwoFactor()).enabled).toBe(true);
  });

  it('regenerates recovery codes, voiding the previous set', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const first = (await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret))).response
      .recoveryCodes!;
    const second = (await h.ctx.twoFactor.regenerateRecoveryCodes(userId)).response.recoveryCodes;

    expect(second).not.toEqual(first);

    const repo = createTwoFactorRepository(h.db);
    // An old code no longer resolves; a new one does.
    expect(
      await repo.consumeRecoveryCode(
        userId,
        hashToken(normalizeRecoveryCode(first[0]!)),
        new Date(),
      ),
    ).toBe(false);
    expect(
      await repo.consumeRecoveryCode(
        userId,
        hashToken(normalizeRecoveryCode(second[0]!)),
        new Date(),
      ),
    ).toBe(true);
  });

  it('rejects enrolling while already enabled and confirming/disabling out of state', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    await expect(h.ctx.twoFactor.disableTotp(userId, '123456')).rejects.toMatchObject({
      code: 'TWO_FACTOR_NOT_ENABLED',
    });
    await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));
    await expect(h.ctx.twoFactor.enrollTotp(userId)).rejects.toMatchObject({
      code: 'TWO_FACTOR_ALREADY_ENABLED',
    });
  });

  it('verifies a legacy TOTP fixture after SESSION_SECRET rotates to new,old', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const oldCookieSecret = 'old-cookie-secret-value';
    const legacyKey = createHash('sha256').update(`bt-2fa:${oldCookieSecret}`).digest();
    const repo = createTwoFactorRepository(h.db);
    const encryptedSecret = encryptSecret(secret, legacyKey);
    await repo.setProvisionalSecret(userId, encryptedSecret);
    await repo.confirmTotp(userId, encryptedSecret, new Date(), null);

    h.ctx.config.recordEncryption = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      REDIS_URL: 'redis://test',
      SESSION_SECRET: `new-cookie-secret-value,${oldCookieSecret}`,
    }).recordEncryption;

    expect(await h.ctx.twoFactor.verifyTotpCode(userId, generateTotpCode(secret))).toBe(true);
  });

  it('verifies a legacy TOTP fixture after SESSION_SECRET rotates to newer,new,old', async () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const historicalSessionSecret = 'new-cookie-secret-value,old-cookie-secret-value';
    const legacyKey = createHash('sha256').update(`bt-2fa:${historicalSessionSecret}`).digest();
    const repo = createTwoFactorRepository(h.db);
    const encryptedSecret = encryptSecret(secret, legacyKey);
    await repo.setProvisionalSecret(userId, encryptedSecret);
    await repo.confirmTotp(userId, encryptedSecret, new Date(), null);

    h.ctx.config.recordEncryption = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      REDIS_URL: 'redis://test',
      SESSION_SECRET: `newest-cookie-secret-value,${historicalSessionSecret}`,
    }).recordEncryption;

    expect(await h.ctx.twoFactor.verifyTotpCode(userId, generateTotpCode(secret))).toBe(true);
  });

  it('reads the previous data key during rotation and writes only with the new active id', async () => {
    const oldMaterial = 'old-record-encryption-material-at-least-32-characters';
    await boot({
      env: {
        BT_DATA_ENCRYPTION_KEY_ID: 'old_2025',
        BT_DATA_ENCRYPTION_KEY: oldMaterial,
      },
    });
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));
    expect((await readUserTwoFactor()).secret).toMatch(/^v2\.old_2025\./);

    h.ctx.config.recordEncryption = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://test',
      REDIS_URL: 'redis://test',
      SESSION_SECRET: 'completely-independent-cookie-secret',
      BT_DATA_ENCRYPTION_KEY_ID: 'new_2026',
      BT_DATA_ENCRYPTION_KEY: 'new-record-encryption-material-at-least-32-characters',
      BT_DATA_ENCRYPTION_DECRYPT_KEYS: `old_2025=${oldMaterial}`,
    }).recordEncryption;

    expect(await h.ctx.twoFactor.verifyTotpCode(userId, generateTotpCode(secret))).toBe(true);
    await h.ctx.twoFactor.disableTotp(
      userId,
      generateTotpCode(secret, Date.now() + TOTP_STEP_SECONDS * 1000),
    );

    await h.ctx.twoFactor.enrollTotp(userId);
    expect((await readUserTwoFactor()).secret).toMatch(/^v2\.new_2026\./);
  });
});

describe('twoFactorService — email-code method (§6.1, #298)', () => {
  it('blocks enabling email 2FA when SMTP is unconfigured — no lockout', async () => {
    // Default harness has no SMTP, so email codes could never be delivered.
    await expect(h.ctx.twoFactor.startEmailEnrollment(userId)).rejects.toMatchObject({
      code: 'TWO_FACTOR_EMAIL_UNAVAILABLE',
    });
    expect((await readUserTwoFactor()).emailEnabled).toBe(false);
  });

  it('enables email 2FA (TOTP never enrolled) after confirming an emailed code, issuing recovery codes', async () => {
    const transport = recordingTransport();
    await boot({ env: SMTP_ENV, emailTransport: transport });

    await h.ctx.twoFactor.startEmailEnrollment(userId);
    expect(transport.sent).toHaveLength(1);
    const code = emailedCode(transport);

    // A wrong code does not enable the method.
    await expect(h.ctx.twoFactor.confirmEmail(userId, '000000')).rejects.toMatchObject({
      code: 'TWO_FACTOR_INVALID_CODE',
    });
    expect((await readUserTwoFactor()).emailEnabled).toBe(false);

    const { recoveryCodes } = (await h.ctx.twoFactor.confirmEmail(userId, code)).response;
    expect(recoveryCodes).not.toBeNull();
    expect(recoveryCodes!.length).toBeGreaterThanOrEqual(8);

    const status = await h.ctx.twoFactor.status(userId);
    expect(status).toMatchObject({
      totpEnabled: false,
      emailEnabled: true,
      recoveryCodesRemaining: recoveryCodes!.length,
    });
    expect(await h.ctx.twoFactor.isEnabled(userId)).toBe(true);
  });

  it('rejects and deletes an email setup code issued at an older security generation', async () => {
    const transport = recordingTransport();
    await boot({ env: SMTP_ENV, emailTransport: transport });

    await h.ctx.twoFactor.startEmailEnrollment(userId, null, { securityGeneration: 0 });
    const staleCode = emailedCode(transport);
    expect(JSON.parse((await h.ctx.redis.get(`2fa_email_setup:${userId}`))!)).toMatchObject({
      securityGeneration: 0,
    });

    // Enabling another factor advances the durable generation. A fresh caller at
    // G1 must not be able to reuse mailbox proof issued before that transition.
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));
    await expect(
      h.ctx.twoFactor.confirmEmail(userId, staleCode, null, { securityGeneration: 1 }),
    ).rejects.toMatchObject({ code: 'TWO_FACTOR_INVALID_CODE' });

    expect(await h.ctx.redis.get(`2fa_email_setup:${userId}`)).toBeNull();
    expect(await readUserTwoFactor()).toMatchObject({
      emailEnabled: false,
      securityGeneration: 1,
    });
  });

  it('shares one recovery-code set across both methods and drops it only with the last', async () => {
    const transport = recordingTransport();
    await boot({ env: SMTP_ENV, emailTransport: transport });

    // Enable email first — first method ⇒ recovery codes issued.
    await h.ctx.twoFactor.startEmailEnrollment(userId);
    const emailEnable = (await h.ctx.twoFactor.confirmEmail(userId, emailedCode(transport)))
      .response;
    expect(emailEnable.recoveryCodes).not.toBeNull();
    const codeCount = await recoveryCodeCount();

    // Enable TOTP second — NOT the first method ⇒ no new recovery codes.
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const totpEnable = (await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret)))
      .response;
    expect(totpEnable.recoveryCodes).toBeNull();
    expect(await recoveryCodeCount()).toBe(codeCount);

    // Disable email — TOTP remains ⇒ recovery codes stay.
    await h.ctx.twoFactor.disableEmail(userId);
    expect((await readUserTwoFactor()).emailEnabled).toBe(false);
    expect(await recoveryCodeCount()).toBe(codeCount);
    expect(await h.ctx.twoFactor.isEnabled(userId)).toBe(true);

    // Disable TOTP — last method ⇒ recovery codes wiped, challenge fully off.
    await h.ctx.twoFactor.disableTotp(userId, generateTotpCode(secret));
    expect(await recoveryCodeCount()).toBe(0);
    expect(await h.ctx.twoFactor.isEnabled(userId)).toBe(false);
  });

  it('disables email as the only method, turning 2FA fully off', async () => {
    const transport = recordingTransport();
    await boot({ env: SMTP_ENV, emailTransport: transport });

    await h.ctx.twoFactor.startEmailEnrollment(userId);
    await h.ctx.twoFactor.confirmEmail(userId, emailedCode(transport));
    expect(await h.ctx.twoFactor.isEnabled(userId)).toBe(true);

    await h.ctx.twoFactor.disableEmail(userId);
    const status = await h.ctx.twoFactor.status(userId);
    expect(status).toEqual({
      totpEnabled: false,
      totpPending: false,
      emailEnabled: false,
      recoveryCodesRemaining: 0,
    });
    expect(await h.ctx.twoFactor.isEnabled(userId)).toBe(false);
    // Disabling again is rejected — nothing to turn off.
    await expect(h.ctx.twoFactor.disableEmail(userId)).rejects.toMatchObject({
      code: 'TWO_FACTOR_NOT_ENABLED',
    });
  });

  it('a recovery code still works for an email-only account', async () => {
    const transport = recordingTransport();
    await boot({ env: SMTP_ENV, emailTransport: transport });

    await h.ctx.twoFactor.startEmailEnrollment(userId);
    const { recoveryCodes } = (await h.ctx.twoFactor.confirmEmail(userId, emailedCode(transport)))
      .response;

    // No TOTP secret exists, yet recovery codes remain a valid factor.
    expect(await h.ctx.twoFactor.consumeRecoveryCode(userId, recoveryCodes![0]!)).toBe(true);
    expect(await h.ctx.twoFactor.consumeRecoveryCode(userId, recoveryCodes![0]!)).toBe(false);
  });
});
