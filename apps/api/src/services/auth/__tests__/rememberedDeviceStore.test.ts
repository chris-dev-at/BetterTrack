import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  pinQuickAuthMarkerKey,
  rememberedDeviceKey,
  rememberedDeviceMetadataKey,
  rememberedDevicesForUserKey,
  REMEMBERED_DEVICE_TTL_SECONDS,
} from '../loginThrottle';
import {
  createRememberedDeviceStore,
  rememberedDeviceHandle,
  type RememberedDeviceStore,
} from '../rememberedDeviceStore';

const USER_A = '00000000-0000-4000-8000-000000000001';
const USER_B = '00000000-0000-4000-8000-000000000002';
const DEVICE_A = 'raw-cookie-secret-a';
const DEVICE_B = 'raw-cookie-secret-b';

describe('remembered-device Redis ownership boundary', () => {
  let redis: Redis;
  let now: number;
  let store: RememberedDeviceStore;

  beforeEach(() => {
    redis = new RedisMock() as unknown as Redis;
    now = Date.parse('2026-08-18T10:00:00.000Z');
    store = createRememberedDeviceStore(redis, { now: () => now });
  });

  it('projects only a safe handle and tracks creation, last-seen and live expiry', async () => {
    await store.createForUser(USER_A, DEVICE_A);

    const initial = await store.listForUser(USER_A);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      handle: rememberedDeviceHandle(DEVICE_A),
      createdAt: '2026-08-18T10:00:00.000Z',
      lastSeenAt: null,
    });
    const expiresAt = Date.parse(initial[0]!.expiresAt);
    expect(expiresAt).toBeGreaterThan(now + (REMEMBERED_DEVICE_TTL_SECONDS - 1) * 1000);
    expect(expiresAt).toBeLessThanOrEqual(now + REMEMBERED_DEVICE_TTL_SECONDS * 1000);
    expect(JSON.stringify(initial)).not.toContain(DEVICE_A);

    now += 60_000;
    await store.touchLastSeen(DEVICE_A);
    expect((await store.listForUser(USER_A))[0]?.lastSeenAt).toBe('2026-08-18T10:01:00.000Z');
  });

  it('derives ownership from the caller index and cannot clear a foreign binding', async () => {
    await store.createForUser(USER_A, DEVICE_A);
    await store.createForUser(USER_B, DEVICE_B);
    await redis.set(pinQuickAuthMarkerKey(DEVICE_B), '1');

    // Simulate a corrupt/poisoned reverse index. The controller has no role in
    // this check: the Redis boundary must verify the forward owner itself.
    await redis.sadd(rememberedDevicesForUserKey(USER_A), DEVICE_B);
    const listed = await store.listForUser(USER_A);
    expect(listed.map((row) => row.handle)).toEqual([rememberedDeviceHandle(DEVICE_A)]);
    expect(await redis.smembers(rememberedDevicesForUserKey(USER_A))).not.toContain(DEVICE_B);

    await redis.sadd(rememberedDevicesForUserKey(USER_A), DEVICE_B);
    await expect(store.revokeForUser(USER_A, rememberedDeviceHandle(DEVICE_B))).resolves.toBe(
      false,
    );
    expect(await redis.get(rememberedDeviceKey(DEVICE_B))).toBe(USER_B);
    expect(await redis.get(pinQuickAuthMarkerKey(DEVICE_B))).toBe('1');
    expect(await redis.get(rememberedDeviceMetadataKey(DEVICE_B))).not.toBeNull();

    await expect(store.revokeAllForUser(USER_A)).resolves.toBe(1);
    expect(await redis.get(rememberedDeviceKey(DEVICE_A))).toBeNull();
    expect(await redis.get(rememberedDeviceKey(DEVICE_B))).toBe(USER_B);
  });

  it('prunes an expired binding and treats its handle as an idempotent no-op', async () => {
    await store.createForUser(USER_A, DEVICE_A);
    await redis.set(pinQuickAuthMarkerKey(DEVICE_A), '1');
    await redis.del(rememberedDeviceKey(DEVICE_A));

    await expect(store.listForUser(USER_A)).resolves.toEqual([]);
    expect(await redis.smembers(rememberedDevicesForUserKey(USER_A))).not.toContain(DEVICE_A);
    expect(await redis.get(rememberedDeviceMetadataKey(DEVICE_A))).toBeNull();
    expect(await redis.get(pinQuickAuthMarkerKey(DEVICE_A))).toBeNull();
    await expect(store.revokeForUser(USER_A, rememberedDeviceHandle(DEVICE_A))).resolves.toBe(
      false,
    );
  });

  it('represents unavailable metadata on a pre-sidecar binding as null', async () => {
    await redis.set(rememberedDeviceKey(DEVICE_A), USER_A, 'EX', REMEMBERED_DEVICE_TTL_SECONDS);
    await redis.sadd(rememberedDevicesForUserKey(USER_A), DEVICE_A);

    const [legacy] = await store.listForUser(USER_A);
    expect(legacy).toMatchObject({ createdAt: null, lastSeenAt: null });
  });

  it('sorts a pre-sidecar binding after a fresh metadata-backed binding', async () => {
    await redis.set(rememberedDeviceKey(DEVICE_A), USER_A, 'EX', REMEMBERED_DEVICE_TTL_SECONDS);
    await redis.sadd(rememberedDevicesForUserKey(USER_A), DEVICE_A);
    now += 60_000;
    await store.createForUser(USER_A, DEVICE_B);

    const listed = await store.listForUser(USER_A);
    expect(listed.map((device) => device.handle)).toEqual([
      rememberedDeviceHandle(DEVICE_B),
      rememberedDeviceHandle(DEVICE_A),
    ]);
  });

  it('pipelines list and revoke-all reads regardless of device count', async () => {
    await store.createForUser(USER_A, DEVICE_A);
    await store.createForUser(USER_A, DEVICE_B);
    const pipeline = vi.spyOn(redis, 'pipeline');
    const get = vi.spyOn(redis, 'get');
    const pttl = vi.spyOn(redis, 'pttl');

    await expect(store.listForUser(USER_A)).resolves.toHaveLength(2);
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(pttl).not.toHaveBeenCalled();

    pipeline.mockClear();
    const revokedHandles: string[] = [];
    await expect(
      store.revokeAllForUser(USER_A, (handle) => revokedHandles.push(handle)),
    ).resolves.toBe(2);
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
    expect(revokedHandles.sort()).toEqual(
      [rememberedDeviceHandle(DEVICE_A), rememberedDeviceHandle(DEVICE_B)].sort(),
    );
  });
});
