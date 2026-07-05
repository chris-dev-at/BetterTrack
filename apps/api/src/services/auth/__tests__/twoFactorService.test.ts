import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTwoFactorRepository } from '../../../data/repositories/twoFactorRepository';
import { twoFactorRecoveryCodes, users } from '../../../data/schema';
import type { MailTransport, OutgoingMail } from '../../email/transport';
import {
  createTestApp,
  type CreateTestAppOptions,
  type TestHarness,
} from '../../../testing/createTestApp';
import { hashToken } from '../../crypto/tokens';
import { generateTotpCode, normalizeRecoveryCode } from '../totp';

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
  await h.ctx.redis.quit?.();
});

async function readUserTwoFactor() {
  const [row] = await h.db
    .select({
      secret: users.twoFactorSecret,
      enabled: users.twoFactorEnabled,
      confirmedAt: users.twoFactorConfirmedAt,
      emailEnabled: users.twoFactorEmailEnabled,
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

describe('twoFactorService — authenticator (TOTP) method (§6.1, §13.2 V2-P5)', () => {
  it('enrolls into a provisional, not-yet-enabled state with the secret encrypted at rest', async () => {
    const { secret, otpauthUri } = await h.ctx.twoFactor.enrollTotp(userId);
    expect(otpauthUri).toContain(`secret=${secret}`);

    const row = await readUserTwoFactor();
    // Stored, but NOT the plaintext secret and NOT yet enabled.
    expect(row.secret).toBeTruthy();
    expect(row.secret).not.toBe(secret);
    expect(row.secret).not.toContain(secret);
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

    const { recoveryCodes } = await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));
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

  it('stores recovery codes only as hashes, never plaintext', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const { recoveryCodes } = await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));

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
    const { recoveryCodes } = await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));
    const repo = createTwoFactorRepository(h.db);
    const hash = hashToken(normalizeRecoveryCode(recoveryCodes![0]!));

    expect(await repo.consumeRecoveryCode(userId, hash, new Date())).toBe(true);
    // A second attempt with the same code is a no-op — single use.
    expect(await repo.consumeRecoveryCode(userId, hash, new Date())).toBe(false);
    expect(await repo.countUnusedRecoveryCodes(userId)).toBe(recoveryCodes!.length - 1);
  });

  it('disables only with a valid factor, wiping the secret AND (last-method) all recovery codes', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const { recoveryCodes } = await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));

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

  it('regenerates recovery codes, voiding the previous set', async () => {
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const first = (await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret)))
      .recoveryCodes!;
    const second = (await h.ctx.twoFactor.regenerateRecoveryCodes(userId)).recoveryCodes;

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

    const { recoveryCodes } = await h.ctx.twoFactor.confirmEmail(userId, code);
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

  it('shares one recovery-code set across both methods and drops it only with the last', async () => {
    const transport = recordingTransport();
    await boot({ env: SMTP_ENV, emailTransport: transport });

    // Enable email first — first method ⇒ recovery codes issued.
    await h.ctx.twoFactor.startEmailEnrollment(userId);
    const emailEnable = await h.ctx.twoFactor.confirmEmail(userId, emailedCode(transport));
    expect(emailEnable.recoveryCodes).not.toBeNull();
    const codeCount = await recoveryCodeCount();

    // Enable TOTP second — NOT the first method ⇒ no new recovery codes.
    const { secret } = await h.ctx.twoFactor.enrollTotp(userId);
    const totpEnable = await h.ctx.twoFactor.confirmTotp(userId, generateTotpCode(secret));
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
    const { recoveryCodes } = await h.ctx.twoFactor.confirmEmail(userId, emailedCode(transport));

    // No TOTP secret exists, yet recovery codes remain a valid factor.
    expect(await h.ctx.twoFactor.consumeRecoveryCode(userId, recoveryCodes![0]!)).toBe(true);
    expect(await h.ctx.twoFactor.consumeRecoveryCode(userId, recoveryCodes![0]!)).toBe(false);
  });
});
