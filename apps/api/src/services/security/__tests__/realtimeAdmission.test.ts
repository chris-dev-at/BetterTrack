import type { Redis } from 'ioredis';
import RedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  REALTIME_SOCKET_COMMAND_BURST,
  REALTIME_SOCKET_COMMANDS_PER_SECOND,
  REALTIME_USER_COMMAND_BURST,
} from '@bettertrack/contracts';

import {
  createRealtimeAdmission,
  createRealtimeTokenBucket,
  DEFAULT_REALTIME_ADMISSION_LIMITS,
  realtimeAdmissionKeys,
  type RealtimeAdmissionLimits,
} from '../realtimeAdmission';

let redis: Redis;
let now: number;

const LIMITS: RealtimeAdmissionLimits = {
  connectionsPerUser: 2,
  connectionsPerBearer: 2,
  userCommandsPerSecond: 2,
  userCommandBurst: 4,
  watchedAssetsPerUser: 2,
  globalLiveAssets: 2,
  concurrentWatchStarts: 2,
};

beforeEach(async () => {
  redis = new RedisMock() as unknown as Redis;
  await redis.flushall();
  now = 1_000_000;
});

const build = () =>
  createRealtimeAdmission(redis, {
    limits: LIMITS,
    leaseTtlMs: 1_000,
    now: () => now,
  });

const connection = (
  leaseId: string,
  userId = 'user-a',
  bearerCredentialId: string | null = null,
) => ({
  leaseId,
  userId,
  bearerCredentialId,
});

const watch = (leaseId: string, userId: string, assetId: string) => ({
  leaseId,
  userId,
  assetId,
});

describe('realtime admission — connection leases', () => {
  it('allows each user and bearer threshold, then returns deterministic typed errors', async () => {
    const admission = build();
    await expect(admission.acquireConnection(connection('u1'))).resolves.toEqual({ ok: true });
    await expect(admission.acquireConnection(connection('u2'))).resolves.toEqual({ ok: true });
    await expect(admission.acquireConnection(connection('u3'))).resolves.toEqual({
      ok: false,
      error: 'USER_CONNECTION_LIMIT',
    });

    await expect(
      admission.acquireConnection(connection('b1', 'other-1', 'credential-a')),
    ).resolves.toEqual({ ok: true });
    await expect(
      admission.acquireConnection(connection('b2', 'other-2', 'credential-a')),
    ).resolves.toEqual({ ok: true });
    await expect(
      admission.acquireConnection(connection('b3', 'other-3', 'credential-a')),
    ).resolves.toEqual({
      ok: false,
      error: 'BEARER_CONNECTION_LIMIT',
    });
  });

  it('linearizes synchronized admissions from separate service instances', async () => {
    const firstProcess = build();
    const secondProcess = build();
    const decisions = await Promise.all([
      firstProcess.acquireConnection(connection('one')),
      secondProcess.acquireConnection(connection('two')),
      firstProcess.acquireConnection(connection('three')),
    ]);

    expect(decisions.filter((decision) => decision.ok)).toHaveLength(LIMITS.connectionsPerUser);
    expect(decisions.filter((decision) => !decision.ok)).toEqual([
      { ok: false, error: 'USER_CONNECTION_LIMIT' },
    ]);
  });

  it('releases idempotently and reclaims a crashed lease after its deadline', async () => {
    const admission = build();
    const held = connection('held');
    await admission.acquireConnection(held);
    await admission.releaseConnection(held);
    await admission.releaseConnection(held);
    expect(await redis.zcard(realtimeAdmissionKeys.connectionUser(held.userId))).toBe(0);

    const expiredAlone = connection('expired-alone');
    await admission.acquireConnection(expiredAlone);
    now += 1_001;
    expect(await admission.renewConnection(expiredAlone)).toBe(false);

    await admission.acquireConnection(connection('crashed-1'));
    await admission.acquireConnection(connection('crashed-2'));
    now += 1_001;
    await expect(admission.acquireConnection(connection('recovered'))).resolves.toEqual({
      ok: true,
    });
    expect(await admission.renewConnection(connection('crashed-1'))).toBe(false);
  });

  it('fails renewal closed and cleans the surviving side of a split bearer lease', async () => {
    const admission = build();
    const held = connection('split', 'user-a', 'credential-a');
    await admission.acquireConnection(held);
    await redis.zrem(realtimeAdmissionKeys.connectionBearer('credential-a'), held.leaseId);

    expect(await admission.renewConnection(held)).toBe(false);
    expect(await redis.zcard(realtimeAdmissionKeys.connectionUser(held.userId))).toBe(0);
  });
});

describe('realtime admission — command buckets', () => {
  it('locks the default 20/40 socket and 50/100 user token buckets', async () => {
    const socketBucket = createRealtimeTokenBucket(
      REALTIME_SOCKET_COMMANDS_PER_SECOND,
      REALTIME_SOCKET_COMMAND_BURST,
      () => now,
    );
    expect(
      Array.from({ length: REALTIME_SOCKET_COMMAND_BURST }, () => socketBucket.consume()).every(
        Boolean,
      ),
    ).toBe(true);
    expect(socketBucket.consume()).toBe(false);
    now += 50;
    expect(socketBucket.consume()).toBe(true);

    const admission = createRealtimeAdmission(redis, { now: () => now });
    const userBurst = await Promise.all(
      Array.from({ length: REALTIME_USER_COMMAND_BURST + 1 }, () =>
        admission.consumeUserCommand('default-user'),
      ),
    );
    expect(userBurst.filter(Boolean)).toHaveLength(REALTIME_USER_COMMAND_BURST);
    expect(userBurst.at(-1)).toBe(false);
    now += 20;
    await expect(admission.consumeUserCommand('default-user')).resolves.toBe(true);
    await expect(admission.consumeUserCommand('default-user')).resolves.toBe(false);
  });

  it('enforces the socket burst and sustained refill without touching server frames', () => {
    let clock = 10_000;
    const bucket = createRealtimeTokenBucket(2, 4, () => clock);
    expect(Array.from({ length: 4 }, () => bucket.consume())).toEqual([true, true, true, true]);
    expect(bucket.consume()).toBe(false);
    clock += 500;
    expect(bucket.consume()).toBe(true);
    expect(bucket.consume()).toBe(false);
  });

  it('atomically shares one user burst across service instances', async () => {
    const firstProcess = build();
    const secondProcess = build();
    const decisions = await Promise.all(
      Array.from({ length: LIMITS.userCommandBurst + 2 }, (_, index) =>
        (index % 2 === 0 ? firstProcess : secondProcess).consumeUserCommand('user-a'),
      ),
    );
    expect(decisions.filter(Boolean)).toHaveLength(LIMITS.userCommandBurst);
    expect(decisions.filter((allowed) => !allowed)).toHaveLength(2);

    now += 500;
    await expect(firstProcess.consumeUserCommand('user-a')).resolves.toBe(true);
    await expect(secondProcess.consumeUserCommand('user-a')).resolves.toBe(false);
  });
});

describe('realtime admission — distinct watched assets', () => {
  it('counts repeated watches once, then enforces the per-user distinct boundary', async () => {
    const admission = build();
    await expect(admission.acquireWatch(watch('a-1', 'user-a', 'asset-a'))).resolves.toEqual({
      ok: true,
      sharedGlobalAsset: false,
    });
    await expect(admission.acquireWatch(watch('a-2', 'user-a', 'asset-a'))).resolves.toEqual({
      ok: true,
      sharedGlobalAsset: true,
    });
    await expect(admission.acquireWatch(watch('b-1', 'user-a', 'asset-b'))).resolves.toEqual({
      ok: true,
      sharedGlobalAsset: false,
    });
    await expect(admission.acquireWatch(watch('c-1', 'user-a', 'asset-c'))).resolves.toEqual({
      ok: false,
      error: 'USER_WATCH_LIMIT',
    });
  });

  it('keeps one shared global slot until the final viewer releases it', async () => {
    const admission = build();
    const first = watch('a-1', 'user-a', 'asset-a');
    const second = watch('a-2', 'user-b', 'asset-a');
    await admission.acquireWatch(first);
    await admission.acquireWatch(second);
    expect(await redis.zcard(realtimeAdmissionKeys.globalWatches)).toBe(1);

    await admission.releaseWatch(first);
    expect(await redis.zcard(realtimeAdmissionKeys.globalWatches)).toBe(1);
    await admission.releaseWatch(second);
    expect(await redis.zcard(realtimeAdmissionKeys.globalWatches)).toBe(0);
  });

  it('shares a global asset slot across users and rejects the next distinct loop atomically', async () => {
    const firstProcess = build();
    const secondProcess = build();
    await firstProcess.acquireWatch(watch('a-1', 'user-a', 'asset-a'));
    await expect(secondProcess.acquireWatch(watch('a-2', 'user-b', 'asset-a'))).resolves.toEqual({
      ok: true,
      sharedGlobalAsset: true,
    });
    await secondProcess.acquireWatch(watch('b-1', 'user-b', 'asset-b'));

    const attempts = await Promise.all([
      firstProcess.acquireWatch(watch('c-1', 'user-c', 'asset-c')),
      secondProcess.acquireWatch(watch('d-1', 'user-d', 'asset-d')),
    ]);
    expect(attempts).toEqual([
      { ok: false, error: 'GLOBAL_LIVE_LIMIT' },
      { ok: false, error: 'GLOBAL_LIVE_LIMIT' },
    ]);
  });

  it('admits the default 250 distinct live assets and rejects asset 251', async () => {
    const admission = createRealtimeAdmission(redis, {
      leaseTtlMs: 1_000,
      now: () => now,
    });
    for (let index = 0; index < DEFAULT_REALTIME_ADMISSION_LIMITS.globalLiveAssets; index += 1) {
      await expect(
        admission.acquireWatch(
          watch(`lease-${index}`, `user-${Math.floor(index / 16)}`, `asset-${index}`),
        ),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      admission.acquireWatch(watch('lease-250', 'user-15', 'asset-250')),
    ).resolves.toEqual({
      ok: false,
      error: 'GLOBAL_LIVE_LIMIT',
    });
  });

  it('admits the default 16 distinct assets per user and rejects asset 17', async () => {
    const admission = createRealtimeAdmission(redis, {
      leaseTtlMs: 1_000,
      now: () => now,
    });
    for (
      let index = 0;
      index < DEFAULT_REALTIME_ADMISSION_LIMITS.watchedAssetsPerUser;
      index += 1
    ) {
      await expect(
        admission.acquireWatch(watch(`lease-${index}`, 'one-user', `asset-${index}`)),
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      admission.acquireWatch(watch('lease-16', 'one-user', 'asset-16')),
    ).resolves.toEqual({
      ok: false,
      error: 'USER_WATCH_LIMIT',
    });
  });

  it('never leaks or goes negative on duplicate release, and recovers expired watch leases', async () => {
    const admission = build();
    const held = watch('held', 'user-a', 'asset-a');
    await admission.acquireWatch(held);
    await admission.releaseWatch(held);
    await admission.releaseWatch(held);
    expect(await redis.zcard(realtimeAdmissionKeys.userWatches(held.userId))).toBe(0);
    expect(await redis.zcard(realtimeAdmissionKeys.globalWatches)).toBe(0);

    const expiredAlone = watch('expired-alone', 'user-a', 'asset-a');
    await admission.acquireWatch(expiredAlone);
    now += 1_001;
    expect(
      await admission.renewWatch({
        leaseId: expiredAlone.leaseId,
        userId: expiredAlone.userId,
        assetId: expiredAlone.assetId,
      }),
    ).toBe(false);

    await admission.acquireWatch(watch('crashed-a', 'user-a', 'asset-a'));
    await admission.acquireWatch(watch('crashed-b', 'user-a', 'asset-b'));
    now += 1_001;
    await expect(admission.acquireWatch(watch('recovered', 'user-a', 'asset-c'))).resolves.toEqual({
      ok: true,
      sharedGlobalAsset: false,
    });
    expect(
      await admission.renewWatch({
        leaseId: 'crashed-a',
        userId: 'user-a',
        assetId: 'asset-a',
      }),
    ).toBe(false);
  });

  it('fails renewal closed and cleans the surviving side of a split watch lease', async () => {
    const admission = build();
    const held = watch('split', 'user-a', 'asset-a');
    await admission.acquireWatch(held);
    await redis.zrem(realtimeAdmissionKeys.globalAssetWatches(held.assetId), held.leaseId);

    expect(
      await admission.renewWatch({
        leaseId: held.leaseId,
        userId: held.userId,
        assetId: held.assetId,
      }),
    ).toBe(false);
    expect(await redis.zcard(realtimeAdmissionKeys.userWatches(held.userId))).toBe(0);
    expect(await redis.hlen(realtimeAdmissionKeys.userWatchAssets(held.userId))).toBe(0);
  });
});

describe('realtime admission — watch-start backpressure', () => {
  it('rejects threshold + 1 promptly, releases exactly once, and reclaims crashes', async () => {
    const admission = build();
    expect(await admission.acquireWatchStart('one')).toBe(true);
    expect(await admission.acquireWatchStart('two')).toBe(true);
    expect(await admission.acquireWatchStart('three')).toBe(false);

    await admission.releaseWatchStart('one');
    await admission.releaseWatchStart('one');
    expect(await admission.acquireWatchStart('three')).toBe(true);

    now += 1_001;
    expect(await admission.renewWatchStart('two')).toBe(false);
    expect(await admission.acquireWatchStart('after-crash')).toBe(true);
  });
});
