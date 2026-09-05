import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProfileRepository } from '../profileRepository';
import type { Database } from '../../db';
import { users } from '../../schema';
import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * #1798: the paranoid Account row writes the profile icon alone, with no
 * `isPublic` in the body. That request must not write `profile_public` at all —
 * not even by round-tripping the value it just read. The §15 account-transition
 * lock is only taken when the request carries the opt-in, so a read-modify-write
 * here could republish a profile that a concurrent paranoid-enable had just
 * taken private. These tests pin the SET list itself, not just the value that
 * happens to survive.
 */
describe('profileRepository.updateProfileSettings — the SET list (#1798)', () => {
  function captureRepo() {
    const sets: Array<Record<string, unknown>> = [];
    const db = {
      update: () => ({
        set: (payload: Record<string, unknown>) => {
          sets.push(payload);
          return { where: () => Promise.resolve(undefined) };
        },
      }),
    } as unknown as Database;
    return { repo: createProfileRepository(db), sets };
  }

  it('omits profile_public entirely when the caller did not send the opt-in', async () => {
    const { repo, sets } = captureRepo();
    await repo.updateProfileSettings('u1', { bio: 'hello' });
    expect(sets).toHaveLength(1);
    expect(sets[0]).not.toHaveProperty('profilePublic');
    expect(sets[0]).toMatchObject({ profileBio: 'hello' });
  });

  it('issues no statement at all when neither field was sent (the icon-only write)', async () => {
    const { repo, sets } = captureRepo();
    await repo.updateProfileSettings('u1', {});
    expect(sets).toEqual([]);
  });

  it('omits profile_bio when only the opt-in was sent, and writes the opt-in as given', async () => {
    const { repo, sets } = captureRepo();
    await repo.updateProfileSettings('u1', { isPublic: true });
    expect(sets).toHaveLength(1);
    expect(sets[0]).not.toHaveProperty('profileBio');
    expect(sets[0]).toMatchObject({ profilePublic: true });
  });
});

describe('profileRepository.updateProfileSettings — persisted effect (#1798)', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestApp();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('leaves a stored opt-in alone across bio-only and empty patches, in both directions', async () => {
    const seeded = await harness.seedUser();
    const repo = createProfileRepository(harness.db);

    await repo.updateProfileSettings(seeded.id, { isPublic: true, bio: 'first' });
    expect(await repo.getProfileSettings(seeded.id)).toMatchObject({
      isPublic: true,
      bio: 'first',
    });

    await repo.updateProfileSettings(seeded.id, { bio: 'second' });
    await repo.updateProfileSettings(seeded.id, {});
    expect(await repo.getProfileSettings(seeded.id)).toMatchObject({
      isPublic: true,
      bio: 'second',
    });

    await repo.updateProfileSettings(seeded.id, { isPublic: false });
    // A profile turned private stays private through a later bio-only write —
    // the write carries no opt-in, so it cannot resurrect the old value.
    await repo.updateProfileSettings(seeded.id, { bio: 'third' });
    expect(await repo.getProfileSettings(seeded.id)).toMatchObject({
      isPublic: false,
      bio: 'third',
    });
    const [row] = await harness.db
      .select({ profilePublic: users.profilePublic })
      .from(users)
      .where(eq(users.id, seeded.id));
    expect(row?.profilePublic).toBe(false);
  });
});
