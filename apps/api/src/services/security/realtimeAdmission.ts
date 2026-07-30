import {
  REALTIME_MAX_CONCURRENT_WATCH_STARTS,
  REALTIME_MAX_CONNECTIONS_PER_BEARER,
  REALTIME_MAX_CONNECTIONS_PER_USER,
  REALTIME_MAX_GLOBAL_LIVE_ASSETS,
  REALTIME_MAX_WATCHED_ASSETS_PER_USER,
  REALTIME_SOCKET_COMMAND_BURST,
  REALTIME_SOCKET_COMMANDS_PER_SECOND,
  REALTIME_USER_COMMAND_BURST,
  REALTIME_USER_COMMANDS_PER_SECOND,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

/** A lease survives one missed heartbeat and then becomes reclaimable. */
export const REALTIME_ADMISSION_LEASE_TTL_MS = 60_000;
/** All socket-held leases are refreshed at this cadence. */
export const REALTIME_ADMISSION_RENEW_INTERVAL_MS = 20_000;

export interface RealtimeAdmissionLimits {
  connectionsPerUser: number;
  connectionsPerBearer: number;
  userCommandsPerSecond: number;
  userCommandBurst: number;
  watchedAssetsPerUser: number;
  globalLiveAssets: number;
  concurrentWatchStarts: number;
}

export const DEFAULT_REALTIME_ADMISSION_LIMITS: Readonly<RealtimeAdmissionLimits> = {
  connectionsPerUser: REALTIME_MAX_CONNECTIONS_PER_USER,
  connectionsPerBearer: REALTIME_MAX_CONNECTIONS_PER_BEARER,
  userCommandsPerSecond: REALTIME_USER_COMMANDS_PER_SECOND,
  userCommandBurst: REALTIME_USER_COMMAND_BURST,
  watchedAssetsPerUser: REALTIME_MAX_WATCHED_ASSETS_PER_USER,
  globalLiveAssets: REALTIME_MAX_GLOBAL_LIVE_ASSETS,
  concurrentWatchStarts: REALTIME_MAX_CONCURRENT_WATCH_STARTS,
};

export type ConnectionAdmission =
  | { ok: true }
  | { ok: false; error: 'USER_CONNECTION_LIMIT' | 'BEARER_CONNECTION_LIMIT' };

export type WatchAdmission =
  | { ok: true; sharedGlobalAsset: boolean }
  | { ok: false; error: 'USER_WATCH_LIMIT' | 'GLOBAL_LIVE_LIMIT' };

export interface RealtimeAdmission {
  acquireConnection(input: {
    leaseId: string;
    userId: string;
    bearerCredentialId: string | null;
  }): Promise<ConnectionAdmission>;
  /** False means the lease expired or was already released; it is never recreated. */
  renewConnection(input: {
    leaseId: string;
    userId: string;
    bearerCredentialId: string | null;
  }): Promise<boolean>;
  releaseConnection(input: {
    leaseId: string;
    userId: string;
    bearerCredentialId: string | null;
  }): Promise<void>;
  /** One atomic Redis-backed token bucket shared by every process for this user. */
  consumeUserCommand(userId: string): Promise<boolean>;
  acquireWatch(input: {
    leaseId: string;
    userId: string;
    assetId: string;
  }): Promise<WatchAdmission>;
  /** False means either side of the cross-process watch lease was lost. */
  renewWatch(input: { leaseId: string; userId: string; assetId: string }): Promise<boolean>;
  releaseWatch(input: { leaseId: string; userId: string; assetId: string }): Promise<void>;
  /** Global rejecting semaphore around resolve/start/history work. */
  acquireWatchStart(leaseId: string): Promise<boolean>;
  renewWatchStart(leaseId: string): Promise<boolean>;
  releaseWatchStart(leaseId: string): Promise<void>;
}

export interface RealtimeAdmissionOptions {
  limits?: Partial<RealtimeAdmissionLimits>;
  leaseTtlMs?: number;
  now?: () => number;
}

const keyPart = (value: string): string => encodeURIComponent(value);

export const realtimeAdmissionKeys = {
  connectionUser: (userId: string): string => `bt:rt:connection:user:${keyPart(userId)}`,
  connectionBearer: (credentialId: string): string =>
    `bt:rt:connection:bearer:${keyPart(credentialId)}`,
  userCommand: (userId: string): string => `bt:rt:command:user:${keyPart(userId)}`,
  userWatches: (userId: string): string => `bt:rt:watch:user:${keyPart(userId)}`,
  userWatchAssets: (userId: string): string => `bt:rt:watch:user-assets:${keyPart(userId)}`,
  /** Distinct asset ids scored by their latest active viewer expiry. */
  globalWatches: 'bt:rt:watch:global',
  globalAssetWatches: (assetId: string): string => `bt:rt:watch:asset:${keyPart(assetId)}`,
  watchStarts: 'bt:rt:watch-starts',
};

const ACQUIRE_CONNECTION_SCRIPT = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local leaseId = ARGV[3]
local userLimit = tonumber(ARGV[4])
local bearerLimit = tonumber(ARGV[5])
local keyTtl = tonumber(ARGV[6])

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if bearerLimit > 0 then
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
end

if redis.call('ZSCORE', KEYS[1], leaseId) then
  return { 1, 0 }
end
if redis.call('ZCARD', KEYS[1]) >= userLimit then
  return { 0, 1 }
end
if bearerLimit > 0 and redis.call('ZCARD', KEYS[2]) >= bearerLimit then
  return { 0, 2 }
end

redis.call('ZADD', KEYS[1], expiresAt, leaseId)
redis.call('PEXPIRE', KEYS[1], keyTtl)
if bearerLimit > 0 then
  redis.call('ZADD', KEYS[2], expiresAt, leaseId)
  redis.call('PEXPIRE', KEYS[2], keyTtl)
end
return { 1, 0 }
`;

const RENEW_CONNECTION_SCRIPT = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local leaseId = ARGV[3]
local bearer = tonumber(ARGV[4])
local keyTtl = tonumber(ARGV[5])
local userExpiry = tonumber(redis.call('ZSCORE', KEYS[1], leaseId))
local bearerExpiry = expiresAt
if bearer > 0 then
  bearerExpiry = tonumber(redis.call('ZSCORE', KEYS[2], leaseId))
end

if not userExpiry or userExpiry <= now or not bearerExpiry or bearerExpiry <= now then
  redis.call('ZREM', KEYS[1], leaseId)
  if bearer > 0 then
    redis.call('ZREM', KEYS[2], leaseId)
  end
  return 0
end

redis.call('ZADD', KEYS[1], expiresAt, leaseId)
redis.call('PEXPIRE', KEYS[1], keyTtl)
if bearer > 0 then
  redis.call('ZADD', KEYS[2], expiresAt, leaseId)
  redis.call('PEXPIRE', KEYS[2], keyTtl)
end
return 1
`;

const RELEASE_CONNECTION_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
if tonumber(ARGV[2]) > 0 then
  redis.call('ZREM', KEYS[2], ARGV[1])
end
return 1
`;

/**
 * Per-user state is capped at 5 sockets × 8 watches, so a small lease→asset
 * hash can count its distinct values directly. Global state does not scan all
 * viewers: one sorted-set member per distinct asset is scored by the latest
 * viewer expiry, while a per-asset lease set lets release/renew recompute that
 * score. Admission therefore stays atomic without work growing with audience.
 */
const ACQUIRE_WATCH_SCRIPT = `
local function reconcileUser(expiryKey, assetKey, now)
  local expired = redis.call('ZRANGEBYSCORE', expiryKey, '-inf', now)
  for _, leaseId in ipairs(expired) do
    redis.call('HDEL', assetKey, leaseId)
  end
  redis.call('ZREMRANGEBYSCORE', expiryKey, '-inf', now)
  local mapped = redis.call('HKEYS', assetKey)
  for _, leaseId in ipairs(mapped) do
    if not redis.call('ZSCORE', expiryKey, leaseId) then
      redis.call('HDEL', assetKey, leaseId)
    end
  end
end

local function refreshGlobalAsset(globalKey, assetLeasesKey, assetId, now)
  redis.call('ZREMRANGEBYSCORE', globalKey, '-inf', now)
  redis.call('ZREMRANGEBYSCORE', assetLeasesKey, '-inf', now)
  local latest = redis.call('ZREVRANGE', assetLeasesKey, 0, 0, 'WITHSCORES')
  if #latest == 0 then
    redis.call('ZREM', globalKey, assetId)
    return 0
  end
  redis.call('ZADD', globalKey, tonumber(latest[2]), assetId)
  return 1
end

local function distinctAssets(assetKey)
  local seen = {}
  local count = 0
  for _, assetId in ipairs(redis.call('HVALS', assetKey)) do
    if not seen[assetId] then
      seen[assetId] = true
      count = count + 1
    end
  end
  return seen, count
end

local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local leaseId = ARGV[3]
local assetId = ARGV[4]
local userLimit = tonumber(ARGV[5])
local globalLimit = tonumber(ARGV[6])
local keyTtl = tonumber(ARGV[7])

reconcileUser(KEYS[1], KEYS[2], now)
local globalAssetActive = refreshGlobalAsset(KEYS[3], KEYS[4], assetId, now)

local heldByUser = redis.call('ZSCORE', KEYS[1], leaseId)
local heldGlobally = redis.call('ZSCORE', KEYS[4], leaseId)
if heldByUser and heldGlobally then
  return { 1, globalAssetActive }
end
if heldByUser or heldGlobally then
  redis.call('ZREM', KEYS[1], leaseId)
  redis.call('HDEL', KEYS[2], leaseId)
  redis.call('ZREM', KEYS[4], leaseId)
  globalAssetActive = refreshGlobalAsset(KEYS[3], KEYS[4], assetId, now)
end

local userAssets, userCount = distinctAssets(KEYS[2])
if not userAssets[assetId] and userCount >= userLimit then
  return { 0, 1 }
end
if globalAssetActive == 0 and redis.call('ZCARD', KEYS[3]) >= globalLimit then
  return { 0, 2 }
end
local sharedGlobalAsset = globalAssetActive

redis.call('ZADD', KEYS[1], expiresAt, leaseId)
redis.call('HSET', KEYS[2], leaseId, assetId)
redis.call('ZADD', KEYS[4], expiresAt, leaseId)
local globalExpiry = tonumber(redis.call('ZSCORE', KEYS[3], assetId) or '0')
redis.call('ZADD', KEYS[3], math.max(globalExpiry, expiresAt), assetId)
for _, key in ipairs(KEYS) do
  redis.call('PEXPIRE', key, keyTtl)
end
return { 1, sharedGlobalAsset }
`;

const RENEW_WATCH_SCRIPT = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local leaseId = ARGV[3]
local assetId = ARGV[4]
local keyTtl = tonumber(ARGV[5])
local userExpiry = tonumber(redis.call('ZSCORE', KEYS[1], leaseId))
local globalExpiry = tonumber(redis.call('ZSCORE', KEYS[4], leaseId))
if not userExpiry or userExpiry <= now or not globalExpiry or globalExpiry <= now then
  redis.call('ZREM', KEYS[1], leaseId)
  redis.call('HDEL', KEYS[2], leaseId)
  redis.call('ZREM', KEYS[4], leaseId)
  redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
  local latest = redis.call('ZREVRANGE', KEYS[4], 0, 0, 'WITHSCORES')
  if #latest == 0 then
    redis.call('ZREM', KEYS[3], assetId)
  else
    redis.call('ZADD', KEYS[3], tonumber(latest[2]), assetId)
  end
  return 0
end
redis.call('ZADD', KEYS[1], expiresAt, leaseId)
redis.call('ZADD', KEYS[4], expiresAt, leaseId)
local assetExpiry = tonumber(redis.call('ZSCORE', KEYS[3], assetId) or '0')
redis.call('ZADD', KEYS[3], math.max(assetExpiry, expiresAt), assetId)
for _, key in ipairs(KEYS) do
  redis.call('PEXPIRE', key, keyTtl)
end
return 1
`;

const RELEASE_WATCH_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', tonumber(ARGV[3]))
local latest = redis.call('ZREVRANGE', KEYS[4], 0, 0, 'WITHSCORES')
if #latest == 0 then
  redis.call('ZREM', KEYS[3], ARGV[2])
else
  redis.call('ZADD', KEYS[3], tonumber(latest[2]), ARGV[2])
end
return 1
`;

const CONSUME_BUCKET_SCRIPT = `
local now = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local keyTtl = tonumber(ARGV[4])
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local updatedAt = tonumber(redis.call('HGET', KEYS[1], 'updatedAt'))

if not tokens or not updatedAt then
  tokens = burst
  updatedAt = now
else
  local elapsed = math.max(0, now - updatedAt)
  tokens = math.min(burst, tokens + elapsed * rate / 1000)
  updatedAt = math.max(updatedAt, now)
end

local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'updatedAt', tostring(updatedAt))
redis.call('PEXPIRE', KEYS[1], keyTtl)
return allowed
`;

const ACQUIRE_SEMAPHORE_SCRIPT = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local leaseId = ARGV[3]
local limit = tonumber(ARGV[4])
local keyTtl = tonumber(ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], leaseId) then
  return 1
end
if redis.call('ZCARD', KEYS[1]) >= limit then
  return 0
end
redis.call('ZADD', KEYS[1], expiresAt, leaseId)
redis.call('PEXPIRE', KEYS[1], keyTtl)
return 1
`;

const RENEW_SEMAPHORE_SCRIPT = `
local now = tonumber(ARGV[1])
local expiresAt = tonumber(ARGV[2])
local leaseId = ARGV[3]
local keyTtl = tonumber(ARGV[4])
local heldUntil = tonumber(redis.call('ZSCORE', KEYS[1], leaseId))
if not heldUntil or heldUntil <= now then
  redis.call('ZREM', KEYS[1], leaseId)
  return 0
end
redis.call('ZADD', KEYS[1], expiresAt, leaseId)
redis.call('PEXPIRE', KEYS[1], keyTtl)
return 1
`;

/**
 * Small process-local token bucket used for one socket. The user bucket above
 * remains Redis-backed because a user's sockets may span API processes.
 */
export interface RealtimeTokenBucket {
  consume(): boolean;
}

export function createRealtimeTokenBucket(
  ratePerSecond = REALTIME_SOCKET_COMMANDS_PER_SECOND,
  burst = REALTIME_SOCKET_COMMAND_BURST,
  now: () => number = Date.now,
): RealtimeTokenBucket {
  let tokens = burst;
  let updatedAt = now();
  return {
    consume(): boolean {
      const current = now();
      const elapsed = Math.max(0, current - updatedAt);
      tokens = Math.min(burst, tokens + (elapsed * ratePerSecond) / 1_000);
      updatedAt = Math.max(updatedAt, current);
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export function createRealtimeAdmission(
  redis: Redis,
  options: RealtimeAdmissionOptions = {},
): RealtimeAdmission {
  const limits = { ...DEFAULT_REALTIME_ADMISSION_LIMITS, ...options.limits };
  const leaseTtlMs = options.leaseTtlMs ?? REALTIME_ADMISSION_LEASE_TTL_MS;
  const keyTtlMs = leaseTtlMs * 2;
  const now = options.now ?? Date.now;
  const expiresAt = (): number => now() + leaseTtlMs;
  const watchKeys = (userId: string, assetId: string) =>
    [
      realtimeAdmissionKeys.userWatches(userId),
      realtimeAdmissionKeys.userWatchAssets(userId),
      realtimeAdmissionKeys.globalWatches,
      realtimeAdmissionKeys.globalAssetWatches(assetId),
    ] as const;

  return {
    async acquireConnection({ leaseId, userId, bearerCredentialId }) {
      const userKey = realtimeAdmissionKeys.connectionUser(userId);
      const bearerKey =
        bearerCredentialId === null
          ? `bt:rt:connection:no-bearer:${keyPart(leaseId)}`
          : realtimeAdmissionKeys.connectionBearer(bearerCredentialId);
      const result = (await redis.eval(
        ACQUIRE_CONNECTION_SCRIPT,
        2,
        userKey,
        bearerKey,
        now(),
        expiresAt(),
        leaseId,
        limits.connectionsPerUser,
        bearerCredentialId === null ? 0 : limits.connectionsPerBearer,
        keyTtlMs,
      )) as [number, number];
      if (result[0] === 1) return { ok: true };
      return {
        ok: false,
        error: result[1] === 1 ? 'USER_CONNECTION_LIMIT' : 'BEARER_CONNECTION_LIMIT',
      };
    },

    async renewConnection({ leaseId, userId, bearerCredentialId }) {
      const userKey = realtimeAdmissionKeys.connectionUser(userId);
      const bearerKey =
        bearerCredentialId === null
          ? `bt:rt:connection:no-bearer:${keyPart(leaseId)}`
          : realtimeAdmissionKeys.connectionBearer(bearerCredentialId);
      const renewed = await redis.eval(
        RENEW_CONNECTION_SCRIPT,
        2,
        userKey,
        bearerKey,
        now(),
        expiresAt(),
        leaseId,
        bearerCredentialId === null ? 0 : 1,
        keyTtlMs,
      );
      return renewed === 1;
    },

    async releaseConnection({ leaseId, userId, bearerCredentialId }) {
      const userKey = realtimeAdmissionKeys.connectionUser(userId);
      const bearerKey =
        bearerCredentialId === null
          ? `bt:rt:connection:no-bearer:${keyPart(leaseId)}`
          : realtimeAdmissionKeys.connectionBearer(bearerCredentialId);
      await redis.eval(
        RELEASE_CONNECTION_SCRIPT,
        2,
        userKey,
        bearerKey,
        leaseId,
        bearerCredentialId === null ? 0 : 1,
      );
    },

    async consumeUserCommand(userId) {
      const allowed = await redis.eval(
        CONSUME_BUCKET_SCRIPT,
        1,
        realtimeAdmissionKeys.userCommand(userId),
        now(),
        limits.userCommandsPerSecond,
        limits.userCommandBurst,
        Math.ceil((limits.userCommandBurst / limits.userCommandsPerSecond) * 4_000),
      );
      return allowed === 1;
    },

    async acquireWatch({ leaseId, userId, assetId }) {
      const result = (await redis.eval(
        ACQUIRE_WATCH_SCRIPT,
        4,
        ...watchKeys(userId, assetId),
        now(),
        expiresAt(),
        leaseId,
        assetId,
        limits.watchedAssetsPerUser,
        limits.globalLiveAssets,
        keyTtlMs,
      )) as [number, number];
      if (result[0] === 1) return { ok: true, sharedGlobalAsset: result[1] === 1 };
      return {
        ok: false,
        error: result[1] === 1 ? 'USER_WATCH_LIMIT' : 'GLOBAL_LIVE_LIMIT',
      };
    },

    async renewWatch({ leaseId, userId, assetId }) {
      const renewed = await redis.eval(
        RENEW_WATCH_SCRIPT,
        4,
        ...watchKeys(userId, assetId),
        now(),
        expiresAt(),
        leaseId,
        assetId,
        keyTtlMs,
      );
      return renewed === 1;
    },

    async releaseWatch({ leaseId, userId, assetId }) {
      await redis.eval(
        RELEASE_WATCH_SCRIPT,
        4,
        ...watchKeys(userId, assetId),
        leaseId,
        assetId,
        now(),
      );
    },

    async acquireWatchStart(leaseId) {
      const acquired = await redis.eval(
        ACQUIRE_SEMAPHORE_SCRIPT,
        1,
        realtimeAdmissionKeys.watchStarts,
        now(),
        expiresAt(),
        leaseId,
        limits.concurrentWatchStarts,
        keyTtlMs,
      );
      return acquired === 1;
    },

    async renewWatchStart(leaseId) {
      const renewed = await redis.eval(
        RENEW_SEMAPHORE_SCRIPT,
        1,
        realtimeAdmissionKeys.watchStarts,
        now(),
        expiresAt(),
        leaseId,
        keyTtlMs,
      );
      return renewed === 1;
    },

    async releaseWatchStart(leaseId) {
      await redis.zrem(realtimeAdmissionKeys.watchStarts, leaseId);
    },
  };
}
