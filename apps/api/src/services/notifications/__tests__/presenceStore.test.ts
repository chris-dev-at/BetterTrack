import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { describe, expect, it, vi } from 'vitest';

import {
  PRESENCE_LEAVE_BATCH,
  createPresenceStore,
  presenceKey,
  type PresenceSubject,
} from '../presence';

const USER = 'u-presence';

const subjects = (count: number): PresenceSubject[] =>
  Array.from({ length: count }, (_unused, index) => ({
    surface: 'chat' as const,
    id: `subject-${index}`,
  }));

/**
 * The gateway's per-socket presence cap happens to equal `PRESENCE_LEAVE_BATCH`
 * today, so the chunking that the "bounded round trips" criterion is about is
 * unreachable through the socket. Pin it directly on the store instead — the
 * batching must stay correct if either constant moves.
 */
describe('presence store — leaveMany batching', () => {
  it('clears more claims than one batch in ceil(n / PRESENCE_LEAVE_BATCH) round trips', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = createPresenceStore({ redis });
    const claims = subjects(PRESENCE_LEAVE_BATCH * 2 + 1);
    for (const subject of claims) await store.enter(USER, subject.surface, subject.id);

    const del = vi.spyOn(redis, 'del');
    await store.leaveMany(USER, claims);

    expect(del).toHaveBeenCalledTimes(3);
    expect(del.mock.calls.map((call) => call.length)).toEqual([
      PRESENCE_LEAVE_BATCH,
      PRESENCE_LEAVE_BATCH,
      1,
    ]);
    // Every key in every batch — including the last, single-key one — is gone.
    for (const subject of claims) {
      await expect(store.isPresent(USER, subject.surface, subject.id)).resolves.toBe(false);
    }
  });

  it('still clears the later batches when one batch fails, and reports the failure', async () => {
    const redis = new RedisMock() as unknown as Redis;
    const store = createPresenceStore({ redis });
    const claims = subjects(PRESENCE_LEAVE_BATCH * 2);
    for (const subject of claims) await store.enter(USER, subject.surface, subject.id);

    const realDel = redis.del.bind(redis) as (...keys: string[]) => Promise<number>;
    const del = vi
      .spyOn(redis, 'del')
      .mockImplementationOnce(async () => {
        throw new Error('connection reset');
      })
      .mockImplementation(((...keys: string[]) => realDel(...keys)) as typeof redis.del);

    await expect(store.leaveMany(USER, claims)).rejects.toThrow('connection reset');

    expect(del).toHaveBeenCalledTimes(2);
    // The failed batch's claims lapse on the TTL; the ones behind it must not
    // be abandoned just because the first slice threw.
    await expect(redis.exists(presenceKey(USER, 'chat', claims[0]!.id))).resolves.toBe(1);
    await expect(
      redis.exists(presenceKey(USER, 'chat', claims[PRESENCE_LEAVE_BATCH]!.id)),
    ).resolves.toBe(0);
  });
});
