import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../errors';
import type { FriendGroupRepository } from '../../../data/repositories/friendGroupRepository';
import type { FriendshipRepository } from '../../../data/repositories/friendshipRepository';
import type { Database } from '../../../data/db';
import { createSocialService, type SocialServiceDeps } from '../socialService';

/**
 * `removeFriend` hands its group-roster cleanup to the unfriend TRANSACTION
 * rather than running it as a second, independent statement (#1710). What the
 * service owes on top of the repository's atomicity is the shape of that hand-off
 * and the error the endpoint answers when the transaction rolls back: a typed,
 * retryable refusal, because "nothing changed" is a different answer for the
 * caller than an opaque 500 beside a friend row whose state is now unknown.
 */

const ALICE = 'alice-1';
const BOB = 'bob-1';

/**
 * A stand-in for the real transactional `deleteFriendship`: it runs the caller's
 * cleanup and, exactly like a rollback, reports nothing removed when it throws.
 */
function makeService(overrides: {
  removeMutualMemberships?: FriendGroupRepository['removeMutualMemberships'];
  friendshipExists?: boolean;
}) {
  const removeMutualMemberships =
    overrides.removeMutualMemberships ?? vi.fn<FriendGroupRepository['removeMutualMemberships']>();
  const deleteFriendship = vi.fn(
    async (_a: string, _b: string, cleanup?: (tx: Database) => Promise<void>) => {
      if (overrides.friendshipExists === false) return false;
      await cleanup?.({} as Database);
      return true;
    },
  );
  const service = createSocialService({
    repo: { deleteFriendship } as unknown as FriendshipRepository,
    groups: { removeMutualMemberships } as unknown as FriendGroupRepository,
    notify: { emit: vi.fn() },
    logger: { error: vi.fn() },
  } as unknown as SocialServiceDeps);
  return { service, deleteFriendship, removeMutualMemberships };
}

describe('removeFriend', () => {
  it('runs the roster cleanup inside the unfriend transaction', async () => {
    const { service, deleteFriendship, removeMutualMemberships } = makeService({});
    await service.removeFriend(ALICE, BOB);
    expect(deleteFriendship).toHaveBeenCalledWith(ALICE, BOB, expect.any(Function));
    // Exactly once, and only from inside the transaction — never as a second
    // statement the friendship delete has already outrun.
    expect(removeMutualMemberships).toHaveBeenCalledTimes(1);
    expect(removeMutualMemberships).toHaveBeenCalledWith(ALICE, BOB, expect.anything());
  });

  it('answers a typed, retryable refusal when the cleanup fails', async () => {
    const { service } = makeService({
      removeMutualMemberships: vi.fn(async () => {
        throw new Error('roster cleanup exploded');
      }),
    });
    const error = await service.removeFriend(ALICE, BOB).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 503, code: 'FRIENDSHIP_REMOVE_FAILED' });
  });

  it('still 404s a pair that were not friends', async () => {
    const { service, removeMutualMemberships } = makeService({ friendshipExists: false });
    const error = await service.removeFriend(ALICE, BOB).catch((e: unknown) => e);
    expect(error).toMatchObject({ statusCode: 404, code: 'FRIENDSHIP_NOT_FOUND' });
    expect(removeMutualMemberships).not.toHaveBeenCalled();
  });
});
