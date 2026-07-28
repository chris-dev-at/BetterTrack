import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTwoFactorRepository } from '../twoFactorRepository';
import { createUserRepository } from '../userRepository';
import { twoFactorRecoveryCodes, users } from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

describe('account security generation repositories (#888)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.ctx.redis.quit?.();
  });

  it('starts safely at zero and changes role in the same row update as the increment', async () => {
    const seeded = await harness.seedUser();
    const repo = createUserRepository(harness.db);

    expect((await repo.findById(seeded.id))?.securityGeneration).toBe(0);
    expect(await repo.setRole(seeded.id, 'admin')).toBe(1);

    expect(await repo.findById(seeded.id)).toMatchObject({
      role: 'admin',
      securityGeneration: 1,
    });
    expect(await repo.setRole(seeded.id, 'user')).toBe(2);
    expect(await repo.findById(seeded.id)).toMatchObject({
      role: 'user',
      securityGeneration: 2,
    });
  });

  it('fences password replacement on the generation the caller authenticated', async () => {
    const seeded = await harness.seedUser();
    const repo = createUserRepository(harness.db);

    expect(await repo.updatePassword(seeded.id, 'replacement-hash', false, 0)).toBe(1);
    // A concurrent request admitted at generation zero cannot replace the
    // credential after the first transition committed.
    expect(await repo.updatePassword(seeded.id, 'stale-hash', false, 0)).toBeNull();

    const updated = await repo.findById(seeded.id);
    expect(updated?.passwordHash).toBe('replacement-hash');
    expect(updated?.securityGeneration).toBe(1);
  });

  it('rolls factor enablement and its generation back when recovery-code storage fails', async () => {
    const seeded = await harness.seedUser();
    const repo = createTwoFactorRepository(harness.db);
    expect(await repo.setProvisionalSecret(seeded.id, 'encrypted-fixture', 0)).toBe(true);

    // The code hash is globally unique. Duplicating it makes the child insert
    // fail after the users-row update, proving both writes share one transaction.
    await expect(
      repo.confirmTotp(
        seeded.id,
        'encrypted-fixture',
        new Date(),
        ['duplicate-hash', 'duplicate-hash'],
        0,
      ),
    ).rejects.toThrow();

    const [afterFailure] = await harness.db
      .select({
        enabled: users.twoFactorEnabled,
        generation: users.securityGeneration,
      })
      .from(users)
      .where(eq(users.id, seeded.id));
    expect(afterFailure).toEqual({ enabled: false, generation: 0 });
    expect(
      await harness.db
        .select({ id: twoFactorRecoveryCodes.id })
        .from(twoFactorRecoveryCodes)
        .where(eq(twoFactorRecoveryCodes.userId, seeded.id)),
    ).toHaveLength(0);

    expect(
      await repo.confirmTotp(seeded.id, 'encrypted-fixture', new Date(), ['one', 'two'], 0),
    ).toBe(1);
    expect(await repo.regenerateRecoveryCodes(seeded.id, ['three', 'four'], 1)).toBe(2);
    expect(await repo.disableTotp(seeded.id, true, 2)).toBe(3);
    expect(
      await harness.db
        .select({ id: twoFactorRecoveryCodes.id })
        .from(twoFactorRecoveryCodes)
        .where(eq(twoFactorRecoveryCodes.userId, seeded.id)),
    ).toHaveLength(0);
  });
});
