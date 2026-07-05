import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTwoFactorRepository } from '../../../data/repositories/twoFactorRepository';
import { twoFactorRecoveryCodes, users } from '../../../data/schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';
import { hashToken } from '../../crypto/tokens';
import { generateTotpCode, normalizeRecoveryCode } from '../totp';

let h: TestHarness;
let userId: string;

beforeEach(async () => {
  h = await createTestApp();
  const user = await h.seedUser();
  userId = user.id;
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
    })
    .from(users)
    .where(eq(users.id, userId));
  return row!;
}

describe('twoFactorService (§6.1, §13.2 V2-P5)', () => {
  it('enrolls into a provisional, not-yet-enabled state with the secret encrypted at rest', async () => {
    const { secret, otpauthUri } = await h.ctx.twoFactor.enroll(userId);
    expect(otpauthUri).toContain(`secret=${secret}`);

    const row = await readUserTwoFactor();
    // Stored, but NOT the plaintext secret and NOT yet enabled.
    expect(row.secret).toBeTruthy();
    expect(row.secret).not.toBe(secret);
    expect(row.secret).not.toContain(secret);
    expect(row.enabled).toBe(false);

    const status = await h.ctx.twoFactor.status(userId);
    expect(status).toEqual({ enabled: false, pending: true, recoveryCodesRemaining: 0 });
  });

  it('confirms only with a valid code, then flips enabled on and issues recovery codes', async () => {
    const { secret } = await h.ctx.twoFactor.enroll(userId);

    await expect(h.ctx.twoFactor.confirm(userId, '000000')).rejects.toMatchObject({
      code: 'TWO_FACTOR_INVALID_CODE',
    });
    expect((await readUserTwoFactor()).enabled).toBe(false);

    const { recoveryCodes } = await h.ctx.twoFactor.confirm(userId, generateTotpCode(secret));
    expect(recoveryCodes.length).toBeGreaterThanOrEqual(8);

    const row = await readUserTwoFactor();
    expect(row.enabled).toBe(true);
    expect(row.confirmedAt).toBeInstanceOf(Date);

    const status = await h.ctx.twoFactor.status(userId);
    expect(status.enabled).toBe(true);
    expect(status.pending).toBe(false);
    expect(status.recoveryCodesRemaining).toBe(recoveryCodes.length);
  });

  it('stores recovery codes only as hashes, never plaintext', async () => {
    const { secret } = await h.ctx.twoFactor.enroll(userId);
    const { recoveryCodes } = await h.ctx.twoFactor.confirm(userId, generateTotpCode(secret));

    const rows = await h.db
      .select({ codeHash: twoFactorRecoveryCodes.codeHash })
      .from(twoFactorRecoveryCodes)
      .where(eq(twoFactorRecoveryCodes.userId, userId));
    const stored = rows.map((r) => r.codeHash);

    for (const code of recoveryCodes) {
      expect(stored).not.toContain(code);
      expect(stored).toContain(hashToken(normalizeRecoveryCode(code)));
    }
  });

  it('consumes a recovery code exactly once', async () => {
    const { secret } = await h.ctx.twoFactor.enroll(userId);
    const { recoveryCodes } = await h.ctx.twoFactor.confirm(userId, generateTotpCode(secret));
    const repo = createTwoFactorRepository(h.db);
    const hash = hashToken(normalizeRecoveryCode(recoveryCodes[0]!));

    expect(await repo.consumeRecoveryCode(userId, hash, new Date())).toBe(true);
    // A second attempt with the same code is a no-op — single use.
    expect(await repo.consumeRecoveryCode(userId, hash, new Date())).toBe(false);
    expect(await repo.countUnusedRecoveryCodes(userId)).toBe(recoveryCodes.length - 1);
  });

  it('disables only with a valid factor, wiping the secret AND all recovery codes', async () => {
    const { secret } = await h.ctx.twoFactor.enroll(userId);
    const { recoveryCodes } = await h.ctx.twoFactor.confirm(userId, generateTotpCode(secret));

    await expect(h.ctx.twoFactor.disable(userId, '000000')).rejects.toMatchObject({
      code: 'TWO_FACTOR_INVALID_CODE',
    });
    expect((await readUserTwoFactor()).enabled).toBe(true);

    // A valid recovery code authorizes the disable.
    await h.ctx.twoFactor.disable(userId, recoveryCodes[0]!);

    const row = await readUserTwoFactor();
    expect(row.enabled).toBe(false);
    expect(row.secret).toBeNull();
    expect(row.confirmedAt).toBeNull();

    const remaining = await h.db
      .select({ id: twoFactorRecoveryCodes.id })
      .from(twoFactorRecoveryCodes)
      .where(eq(twoFactorRecoveryCodes.userId, userId));
    expect(remaining).toHaveLength(0);
  });

  it('regenerates recovery codes, voiding the previous set', async () => {
    const { secret } = await h.ctx.twoFactor.enroll(userId);
    const first = (await h.ctx.twoFactor.confirm(userId, generateTotpCode(secret))).recoveryCodes;
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
    const { secret } = await h.ctx.twoFactor.enroll(userId);
    await expect(h.ctx.twoFactor.disable(userId, '123456')).rejects.toMatchObject({
      code: 'TWO_FACTOR_NOT_ENABLED',
    });
    await h.ctx.twoFactor.confirm(userId, generateTotpCode(secret));
    await expect(h.ctx.twoFactor.enroll(userId)).rejects.toMatchObject({
      code: 'TWO_FACTOR_ALREADY_ENABLED',
    });
  });
});
