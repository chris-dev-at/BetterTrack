import type { Redis } from 'ioredis';

import type { RememberedDeviceSummary } from '@bettertrack/contracts';

import { sha256Base64Url } from '../crypto/tokens';
import {
  pinQuickAuthMarkerKey,
  rememberedDeviceKey,
  rememberedDeviceMetadataKey,
  rememberedDevicesForUserKey,
  REMEMBERED_DEVICE_TTL_SECONDS,
} from './loginThrottle';

/** Domain separation keeps this selector distinct from every other token hash. */
export const REMEMBERED_DEVICE_HANDLE_DOMAIN = 'bettertrack:remembered-device:v1:';

/** Stable public revocation selector; never expose the raw cookie id. */
export const rememberedDeviceHandle = (deviceId: string): string =>
  sha256Base64Url(`${REMEMBERED_DEVICE_HANDLE_DOMAIN}${deviceId}`);

interface RememberedDeviceMetadata {
  /** Epoch milliseconds, or null when the binding predates metadata (#1327). */
  createdAt: number | null;
  /** Epoch milliseconds of the latest successful quick-auth, if any. */
  lastSeenAt: number | null;
}

export interface RememberedDeviceStoreOptions {
  /** Injectable wall clock for deterministic metadata/expiry tests. */
  now?: () => number;
}

/**
 * Redis ownership boundary for remembered-device management (#1327).
 *
 * Every management read/revoke begins at the authenticated user's reverse-index
 * key. A client-supplied handle is compared only with digests derived while
 * walking that set; it is never interpolated into a Redis key, and there is no
 * global handle lookup. Each candidate's forward binding must still name the
 * same user before it can be returned or cleared. This makes cross-account
 * access structurally unavailable to the HTTP controller.
 */
export interface RememberedDeviceStore {
  /** Atomically create the forward binding, owner index and metadata sidecar. */
  createForUser(userId: string, deviceId: string): Promise<void>;
  /** Resolve the raw cookie id for the cookie-bound quick-auth/forget flows. */
  ownerOf(deviceId: string): Promise<string | null>;
  /** Slide a verified binding/index/metadata lifetime with its browser cookie. */
  refreshForUser(userId: string, deviceId: string): Promise<void>;
  /** Record a successful quick-auth without extending the binding lifetime. */
  touchLastSeen(deviceId: string): Promise<void>;
  /** Clear the full binding state when the raw id and owner are already trusted. */
  clearForUser(userId: string, deviceId: string): Promise<void>;
  /** Clear ancillary state for a cookie id whose forward binding is already gone. */
  clearOrphan(deviceId: string): Promise<void>;
  /** List only verified live bindings rooted at this user's reverse index. */
  listForUser(userId: string): Promise<RememberedDeviceSummary[]>;
  /** Idempotently revoke one verified binding selected by its safe handle. */
  revokeForUser(userId: string, handle: string): Promise<boolean>;
  /** Revoke every verified binding owned by this user and return the count. */
  revokeAllForUser(userId: string, onRevoked?: (handle: string) => void): Promise<number>;
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function parseMetadata(raw: string | null): RememberedDeviceMetadata {
  if (!raw) return { createdAt: null, lastSeenAt: null };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      createdAt: timestamp(value.createdAt),
      lastSeenAt: timestamp(value.lastSeenAt),
    };
  } catch {
    return { createdAt: null, lastSeenAt: null };
  }
}

const iso = (value: number | null): string | null =>
  value === null ? null : new Date(value).toISOString();

function pipelineValue<T>(
  results: [error: Error | null, result: unknown][] | null,
  index: number,
): T {
  const entry = results?.[index];
  if (!entry) throw new Error('Remembered-device read pipeline returned an incomplete result');
  const [error, value] = entry;
  if (error) throw error;
  return value as T;
}

export function createRememberedDeviceStore(
  redis: Redis,
  options: RememberedDeviceStoreOptions = {},
): RememberedDeviceStore {
  const clock = options.now ?? Date.now;

  async function clearForUser(userId: string, deviceId: string): Promise<void> {
    await redis
      .multi()
      .del(
        rememberedDeviceKey(deviceId),
        rememberedDeviceMetadataKey(deviceId),
        pinQuickAuthMarkerKey(deviceId),
      )
      .srem(rememberedDevicesForUserKey(userId), deviceId)
      .exec();
  }

  async function pruneUnownedIndexMember(
    userId: string,
    deviceId: string,
    boundUserId: string | null,
  ): Promise<void> {
    const transaction = redis.multi().srem(rememberedDevicesForUserKey(userId), deviceId);
    // When the forward binding is absent, ancillary state cannot belong to any
    // live account. A foreign binding is different: remove only the poisoned
    // caller-index member and leave the real owner's state byte-for-byte intact.
    if (boundUserId === null) {
      transaction.del(rememberedDeviceMetadataKey(deviceId), pinQuickAuthMarkerKey(deviceId));
    }
    await transaction.exec();
  }

  const store: RememberedDeviceStore = {
    async createForUser(userId, deviceId) {
      const metadata: RememberedDeviceMetadata = { createdAt: clock(), lastSeenAt: null };
      await redis
        .multi()
        .set(rememberedDeviceKey(deviceId), userId, 'EX', REMEMBERED_DEVICE_TTL_SECONDS)
        .sadd(rememberedDevicesForUserKey(userId), deviceId)
        .expire(rememberedDevicesForUserKey(userId), REMEMBERED_DEVICE_TTL_SECONDS)
        .set(
          rememberedDeviceMetadataKey(deviceId),
          JSON.stringify(metadata),
          'EX',
          REMEMBERED_DEVICE_TTL_SECONDS,
        )
        .exec();
    },

    ownerOf(deviceId) {
      return redis.get(rememberedDeviceKey(deviceId));
    },

    async refreshForUser(userId, deviceId) {
      await redis
        .multi()
        .sadd(rememberedDevicesForUserKey(userId), deviceId)
        .expire(rememberedDevicesForUserKey(userId), REMEMBERED_DEVICE_TTL_SECONDS)
        .expire(rememberedDeviceKey(deviceId), REMEMBERED_DEVICE_TTL_SECONDS)
        .expire(rememberedDeviceMetadataKey(deviceId), REMEMBERED_DEVICE_TTL_SECONDS)
        .exec();
    },

    async touchLastSeen(deviceId) {
      const ttlMs = await redis.pttl(rememberedDeviceKey(deviceId));
      if (ttlMs <= 0) return;
      const metadata = parseMetadata(await redis.get(rememberedDeviceMetadataKey(deviceId)));
      metadata.lastSeenAt = clock();
      // Align the sidecar to the binding's remaining lifetime. Touching display
      // metadata must never extend remembered trust.
      await redis.set(rememberedDeviceMetadataKey(deviceId), JSON.stringify(metadata), 'PX', ttlMs);
    },

    clearForUser,

    async clearOrphan(deviceId) {
      await redis.del(
        rememberedDeviceKey(deviceId),
        rememberedDeviceMetadataKey(deviceId),
        pinQuickAuthMarkerKey(deviceId),
      );
    },

    async listForUser(userId) {
      const indexKey = rememberedDevicesForUserKey(userId);
      const deviceIds = await redis.smembers(indexKey);
      if (deviceIds.length === 0) return [];

      const reads = redis.pipeline();
      for (const deviceId of deviceIds) {
        const bindingKey = rememberedDeviceKey(deviceId);
        reads.get(bindingKey).pttl(bindingKey).get(rememberedDeviceMetadataKey(deviceId));
      }
      const readResults = await reads.exec();
      const devices: RememberedDeviceSummary[] = [];

      for (const [index, deviceId] of deviceIds.entries()) {
        const resultOffset = index * 3;
        const bindingKey = rememberedDeviceKey(deviceId);
        const boundUserId = pipelineValue<string | null>(readResults, resultOffset);
        if (boundUserId !== userId) {
          await pruneUnownedIndexMember(userId, deviceId, boundUserId);
          continue;
        }

        let ttlMs = pipelineValue<number>(readResults, resultOffset + 1);
        if (ttlMs === -1) {
          // A bounded reverse-index member may still come from the brief legacy
          // retention transition. Give that already-live binding the standard
          // expiry; never do this for a missing/expired key.
          await redis
            .multi()
            .expire(bindingKey, REMEMBERED_DEVICE_TTL_SECONDS)
            .expire(indexKey, REMEMBERED_DEVICE_TTL_SECONDS)
            .expire(rememberedDeviceMetadataKey(deviceId), REMEMBERED_DEVICE_TTL_SECONDS)
            .exec();
          ttlMs = REMEMBERED_DEVICE_TTL_SECONDS * 1000;
        }
        if (ttlMs <= 0) {
          await pruneUnownedIndexMember(userId, deviceId, null);
          continue;
        }

        const metadata = parseMetadata(pipelineValue<string | null>(readResults, resultOffset + 2));
        devices.push({
          handle: rememberedDeviceHandle(deviceId),
          createdAt: iso(metadata.createdAt),
          lastSeenAt: iso(metadata.lastSeenAt),
          expiresAt: new Date(clock() + ttlMs).toISOString(),
        });
      }

      // Recent activity first, then creation. Legacy rows have no trustworthy
      // activity timestamp and stay after every metadata-backed binding.
      devices.sort((left, right) => {
        const leftOrder = left.lastSeenAt ?? left.createdAt;
        const rightOrder = right.lastSeenAt ?? right.createdAt;
        if (leftOrder === null) {
          return rightOrder === null ? right.expiresAt.localeCompare(left.expiresAt) : 1;
        }
        if (rightOrder === null) return -1;
        return rightOrder.localeCompare(leftOrder);
      });
      return devices;
    },

    async revokeForUser(userId, handle) {
      // Idempotency key: (authenticated user id, stable handle). Replaying this
      // after expiry/revocation walks the same owner index and returns false;
      // callers deliberately receive the same `{ ok: true }` either way.
      const deviceIds = await redis.smembers(rememberedDevicesForUserKey(userId));
      for (const deviceId of deviceIds) {
        if (rememberedDeviceHandle(deviceId) !== handle) continue;
        const boundUserId = await redis.get(rememberedDeviceKey(deviceId));
        if (boundUserId !== userId) {
          await pruneUnownedIndexMember(userId, deviceId, boundUserId);
          return false;
        }
        await clearForUser(userId, deviceId);
        return true;
      }
      return false;
    },

    async revokeAllForUser(userId, onRevoked) {
      const deviceIds = await redis.smembers(rememberedDevicesForUserKey(userId));
      if (deviceIds.length === 0) return 0;

      const reads = redis.pipeline();
      for (const deviceId of deviceIds) reads.get(rememberedDeviceKey(deviceId));
      const readResults = await reads.exec();
      let revoked = 0;
      for (const [index, deviceId] of deviceIds.entries()) {
        const boundUserId = pipelineValue<string | null>(readResults, index);
        if (boundUserId !== userId) {
          await pruneUnownedIndexMember(userId, deviceId, boundUserId);
          continue;
        }
        await clearForUser(userId, deviceId);
        onRevoked?.(rememberedDeviceHandle(deviceId));
        revoked += 1;
      }
      return revoked;
    },
  };

  return store;
}
