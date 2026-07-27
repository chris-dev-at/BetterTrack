import type { Redis } from 'ioredis';

const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/**
 * Atomically release a Redis lock only when it is still owned by `token`.
 *
 * The ownership check and deletion run in one Redis command so an expired
 * owner cannot delete a successor lock acquired between separate GET and DEL
 * commands.
 */
export async function releaseCacheLock(
  redis: Pick<Redis, 'eval'>,
  key: string,
  token: string,
): Promise<boolean> {
  return (await redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token)) === 1;
}
