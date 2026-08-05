import type { Redis } from 'ioredis';

import type { UserRow } from '../../data/schema';
import { resetProgressiveLimiter } from '../security/progressiveLimiter';

/**
 * Per-account progressive login throttle (PROJECTPLAN.md §6.1, §10). The auth
 * service tracks failed logins per account with a {@link createProgressiveLimiter}
 * under this namespace — independent of the per-IP counter the HTTP middleware
 * keeps. Owned here so both the auth service (which drives it) and the admin
 * service (which clears it on password reset / re-enable) name the namespace once
 * and never drift.
 */
export const LOGIN_ACCOUNT_NAMESPACE = 'login_account';

/**
 * Per-account wrong-second-factor throttle for login and session-authenticated
 * TOTP re-auth (§6.1, §10, §13.2 V2-P5). Independent of the password-failure
 * counter above and of the per-IP request limiter the HTTP middleware keeps: a
 * correct password or hijacked session still gates code brute-forcing per
 * account. Drives the same {@link createProgressiveLimiter} with the
 * `loginAccount` schedule.
 */
export const TWO_FACTOR_ACCOUNT_NAMESPACE = 'two_factor_account';

/**
 * Per-account brute-force throttle for bearer PIN verification (#361, §6.1, §10).
 * The session PIN gate (below) protects the cookie flow by destroying the
 * session after {@link PIN_FALLBACK_THRESHOLD} wrong PINs; a bearer request has
 * no session to drop, so the token PIN-verify endpoint gates a 4-digit PIN with
 * its own {@link createProgressiveLimiter} under this namespace instead —
 * independent of the per-IP HTTP limiter and of the session counter.
 */
export const PIN_TOKEN_ACCOUNT_NAMESPACE = 'pin_token_account';

/**
 * Per-account brute-force throttle for the self-service account-deletion
 * re-auth (§13.4 V4-P2c, #362). Deletion re-verifies a credential (password /
 * TOTP / recovery code); wrong attempts accrue here — independent of the login
 * and 2FA counters, and of the per-IP HTTP limiter — so the deletion endpoint
 * can never be a lighter-weight oracle for password or code brute-forcing.
 */
export const ACCOUNT_DELETE_NAMESPACE = 'account_delete_account';

/**
 * Per-account brute-force throttle for the data-export re-auth (§13.4 V4-P6a,
 * #494). The export request re-verifies a credential (password / TOTP / recovery
 * code); wrong attempts accrue here, independent of the login/2FA counters and
 * the per-IP limiter, so the export endpoint is never a lighter brute-force
 * oracle than login itself. Reuses the `loginAccount` schedule like deletion.
 */
export const ACCOUNT_EXPORT_NAMESPACE = 'account_export_account';

/**
 * Per-account brute-force throttle for the passkey add/delete re-auth (§13.4
 * V4-P4). Registering or removing a passkey re-verifies a credential (password /
 * TOTP / recovery code); wrong attempts accrue here — independent of the login/2FA
 * counters and the per-IP limiter — so the passkey-management endpoints can never
 * be a lighter-weight oracle for password or code brute-forcing. Reuses the
 * `loginAccount` schedule like deletion and export.
 */
export const ACCOUNT_PASSKEY_NAMESPACE = 'account_passkey_account';

/**
 * Per-account brute-force throttle for the paranoid `discard` re-auth (§13.5
 * V5-P13, docs/paranoid-design.md §3). Destroying an undecryptable vault
 * re-verifies a credential exactly like account deletion; wrong attempts accrue
 * here — independent of the login/2FA counters, of deletion/export/passkey, and
 * of the per-IP limiter — so this exit is never a lighter-weight oracle than
 * login. Reuses the `loginAccount` schedule like every sibling re-auth.
 */
export const ACCOUNT_PARANOID_DISCARD_NAMESPACE = 'account_paranoid_discard_account';

/**
 * Consecutive-failure counter for the PIN gate (§6.1). Kept separate from the
 * login throttle above: five wrong PINs in a row drop the user back to full login
 * (the session is destroyed), so the gate can never be a lighter-weight bypass of
 * password brute-force protection. Session/PIN fallback mechanics are their own
 * P2 issue — this counter is left untouched by the progressive-limit rework.
 */
export const pinFailCountKey = (userId: string) => `pin_fail:${userId}`;

/** Wrong PINs in a row before the gate falls back to a full login (§6.1). */
export const PIN_FALLBACK_THRESHOLD = 5;

/**
 * OAuth account memory + PIN quick re-auth (§16, owner spec #399 §B, V4-P2b).
 * A device that a PIN user opted to be remembered on holds a signed httpOnly
 * `bt_rdid` cookie whose opaque device id maps to that user here — the server-
 * side binding for the quick re-auth flow. The binding expires with the
 * browser's 400-day remembered-device cookie, so abandoned mappings cannot
 * survive forever. The value is the user id (the device is bound to one account
 * at a time).
 */
const REMEMBERED_DEVICE_KEY_PREFIX = 'remember_dev:';

export const rememberedDeviceKey = (deviceId: string) =>
  `${REMEMBERED_DEVICE_KEY_PREFIX}${deviceId}`;

/** Reverse index that lets account deletion enumerate every remembered device. */
export const rememberedDevicesForUserKey = (userId: string) => `remember_dev_user:${userId}`;

/** Matches the fixed 400-day lifetime of the signed `bt_rdid` browser cookie. */
export const REMEMBERED_DEVICE_TTL_SECONDS = 400 * 24 * 60 * 60;

/**
 * Marks that this remembered device recently proved its PIN, so the next OAuth
 * quick re-auth within {@link PIN_QUICK_AUTH_WINDOW_SECONDS} auto-passes without
 * re-entering it (owner: "the PIN timer from a recent entry is still running").
 * Device-keyed (not user-keyed) so entering a PIN on one device never opens the
 * window on another; the {@link rememberedDeviceKey} cookie is required to read
 * it. Set only on a real PIN entry, given a fixed TTL — an auto-pass never
 * refreshes it, so the window measures time since the last actual PIN.
 */
export const pinQuickAuthMarkerKey = (deviceId: string) => `pin_quick_ok:${deviceId}`;

/** A user row that a remembered device may still be bound to (§16 #419 §B). */
export type RememberableUser = UserRow & {
  status: 'active';
  pinEnabled: true;
  pinHash: string;
};

/**
 * The single predicate for "this account can still be quick-re-authed". Quick
 * auth, the remember-device write fence and the legacy sweep below all read it,
 * so a binding can never be kept alive by one path that another would retire.
 */
export function isRememberableUser(user: UserRow | undefined): user is RememberableUser {
  return Boolean(
    user &&
    user.status === 'active' &&
    user.pinEnabled === true &&
    typeof user.pinHash === 'string' &&
    user.pinHash.length > 0,
  );
}

const REMEMBERED_DEVICE_SCAN_COUNT = 100;
const REMEMBERED_DEVICE_DELETE_BATCH_SIZE = 100;

function* rememberedDeviceBatches<T>(items: readonly T[]): Generator<readonly T[]> {
  for (let start = 0; start < items.length; start += REMEMBERED_DEVICE_DELETE_BATCH_SIZE) {
    yield items.slice(start, start + REMEMBERED_DEVICE_DELETE_BATCH_SIZE);
  }
}

async function deleteRememberedDeviceIds(
  redis: Redis,
  indexKey: string,
  deviceIds: ReadonlySet<string>,
): Promise<void> {
  for (const batch of rememberedDeviceBatches([...deviceIds])) {
    const transaction = redis.multi();
    for (const deviceId of batch) {
      transaction.del(rememberedDeviceKey(deviceId), pinQuickAuthMarkerKey(deviceId));
    }
    await transaction.exec();
  }
  await redis.del(indexKey);
}

/**
 * Remove every remembered-device binding owned by a deleted account.
 *
 * Current bindings are enumerable through the reverse index. Bindings written
 * before that index existed are not, so this compatibility scan stays until
 * {@link sweepLegacyRememberedDeviceBindings} has provably retired the last
 * unindexed key in a deployment — the daily sweep upgrades or deletes them
 * without waiting for the browser to come back, but no single request can
 * assert that it already finished everywhere. Small SCAN pages and bounded
 * deletion transactions keep this from issuing one unbounded Redis command
 * batch.
 */
export async function removeRememberedDeviceBindings(redis: Redis, userId: string): Promise<void> {
  const indexKey = rememberedDevicesForUserKey(userId);
  const deviceIds = new Set(await redis.smembers(indexKey));

  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${REMEMBERED_DEVICE_KEY_PREFIX}*`,
      'COUNT',
      REMEMBERED_DEVICE_SCAN_COUNT,
    );
    if (keys.length > 0) {
      const userIds = await redis.mget(...keys);
      for (const [index, rememberedUserId] of userIds.entries()) {
        if (rememberedUserId === userId) {
          deviceIds.add(keys[index]!.slice(REMEMBERED_DEVICE_KEY_PREFIX.length));
        }
      }
    }
    cursor = nextCursor;
  } while (cursor !== '0');

  await deleteRememberedDeviceIds(redis, indexKey, deviceIds);
}

/** One remembered-device binding with the account id it is bound to. */
interface RememberedBinding {
  deviceId: string;
  userId: string;
}

/** What one {@link sweepLegacyRememberedDeviceBindings} pass did. */
export interface LegacyRememberedDeviceSweepResult {
  /** Unbounded (`TTL -1`) bindings the pass acted on. */
  legacy: number;
  /** Legacy bindings that are now indexed and TTL-bounded. */
  upgraded: number;
  /** Legacy bindings deleted because their account can no longer be remembered. */
  retired: number;
}

/** Batched account lookup — one round trip per SCAN page, never one per key. */
export interface RememberedDeviceUserLookup {
  listByIds(ids: string[]): Promise<UserRow[]>;
}

/** Read every key's TTL in one pipeline; a vanished key reports as `-2`. */
async function rememberedDeviceTtls(redis: Redis, keys: readonly string[]): Promise<number[]> {
  const pipeline = redis.pipeline();
  for (const key of keys) pipeline.ttl(key);
  const replies = await pipeline.exec();
  return keys.map((_, index) => {
    const reply = replies?.[index];
    if (!reply || reply[0]) return -2;
    return typeof reply[1] === 'number' ? reply[1] : -2;
  });
}

async function rememberableIdsOf(
  users: RememberedDeviceUserLookup,
  bindings: readonly RememberedBinding[],
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(bindings.map((binding) => binding.userId))];
  if (ids.length === 0) return new Set<string>();
  const rows = await users.listByIds(ids);
  return new Set(rows.filter(isRememberableUser).map((row) => row.id));
}

/** Give a legacy binding the standard TTL and make it enumerable per user. */
async function upgradeRememberedBindings(
  redis: Redis,
  bindings: readonly RememberedBinding[],
): Promise<void> {
  for (const batch of rememberedDeviceBatches(bindings)) {
    const transaction = redis.multi();
    for (const { deviceId, userId } of batch) {
      const indexKey = rememberedDevicesForUserKey(userId);
      transaction.sadd(indexKey, deviceId);
      transaction.expire(indexKey, REMEMBERED_DEVICE_TTL_SECONDS);
      transaction.expire(rememberedDeviceKey(deviceId), REMEMBERED_DEVICE_TTL_SECONDS);
    }
    await transaction.exec();
  }
}

/** Drop a binding, its quick-auth window and its index membership. */
async function retireRememberedBindings(
  redis: Redis,
  bindings: readonly RememberedBinding[],
): Promise<void> {
  for (const batch of rememberedDeviceBatches(bindings)) {
    const transaction = redis.multi();
    for (const { deviceId, userId } of batch) {
      transaction.del(rememberedDeviceKey(deviceId), pinQuickAuthMarkerKey(deviceId));
      transaction.srem(rememberedDevicesForUserKey(userId), deviceId);
    }
    await transaction.exec();
  }
}

/**
 * Retire the pre-retention remembered-device bindings (§13.5 V5-P14, PL-01).
 *
 * Bindings written before the reverse index existed carry no TTL and no index
 * membership. Quick auth upgrades one lazily, but only if that exact browser
 * ever returns — a wiped device would keep an immortal, unenumerable binding
 * forever. This bounded, idempotent daily pass reaches the whole population
 * instead:
 *
 * - only keys at `TTL -1` are touched, so an already-bounded binding is skipped
 *   and a second run is a no-op (SCAN may also repeat a key across pages);
 * - a binding whose account can still be remembered is indexed and expired;
 * - a binding whose account is gone, suspended or PIN-less is DELETED, never
 *   handed a fresh 400-day lease — resurrecting that residue is exactly the
 *   leftover this sweep exists to remove;
 * - every write is fenced against a concurrent account deletion the same way
 *   the request paths are: the account is re-read after the write, and a
 *   binding whose account vanished in that window is torn down here.
 */
export async function sweepLegacyRememberedDeviceBindings(
  redis: Redis,
  users: RememberedDeviceUserLookup,
): Promise<LegacyRememberedDeviceSweepResult> {
  const result: LegacyRememberedDeviceSweepResult = { legacy: 0, upgraded: 0, retired: 0 };
  let cursor = '0';

  do {
    const [nextCursor, scanned] = await redis.scan(
      cursor,
      'MATCH',
      `${REMEMBERED_DEVICE_KEY_PREFIX}*`,
      'COUNT',
      REMEMBERED_DEVICE_SCAN_COUNT,
    );
    // Termination rests only on Redis' own SCAN guarantee: the cursor advances
    // before any page work, and page work never re-enters the loop.
    cursor = nextCursor;
    const keys = [...new Set(scanned)];
    if (keys.length === 0) continue;

    const boundUserIds = await redis.mget(...keys);
    const ttls = await rememberedDeviceTtls(redis, keys);
    const legacy: RememberedBinding[] = [];
    for (const [index, key] of keys.entries()) {
      const userId = boundUserIds[index];
      // `-1` is persistent (a pre-retention binding); `-2` is already gone and
      // any positive TTL means the binding is bounded and needs nothing.
      if (!userId || ttls[index] !== -1) continue;
      legacy.push({ deviceId: key.slice(REMEMBERED_DEVICE_KEY_PREFIX.length), userId });
    }
    if (legacy.length === 0) continue;
    result.legacy += legacy.length;

    const rememberable = await rememberableIdsOf(users, legacy);
    const upgradable = legacy.filter((binding) => rememberable.has(binding.userId));
    const orphaned = legacy.filter((binding) => !rememberable.has(binding.userId));

    await retireRememberedBindings(redis, orphaned);
    await upgradeRememberedBindings(redis, upgradable);

    // Deletion fence: this read is ordered after the writes above, so either
    // deletion's post-delete sweep runs after them, or this pass observes the
    // missing account and removes what it just wrote — including the index
    // membership that would otherwise resurrect a cleared reverse index.
    const stillRememberable = await rememberableIdsOf(users, upgradable);
    const stale = upgradable.filter((binding) => !stillRememberable.has(binding.userId));
    await retireRememberedBindings(redis, stale);

    result.upgraded += upgradable.length - stale.length;
    result.retired += orphaned.length + stale.length;
  } while (cursor !== '0');

  return result;
}

/**
 * Length of the quick re-auth auto-pass window, in seconds (~15 min, owner spec
 * #399 §B). A deliberate server-side grace distinct from the client-side idle
 * lock (`pinLockIdleMinutes`, a UI-only preference): quick re-auth has no live
 * session to time against, so the window is a fixed server marker keyed to the
 * remembered device. Chosen to match the per-account PIN limiter's 15-min window.
 */
export const PIN_QUICK_AUTH_WINDOW_SECONDS = 15 * 60;

/**
 * Drop the per-account password-failure throttle and PIN-fallback state on a
 * correct password, WITHOUT touching the second-factor throttle. That 2FA
 * counter must survive a re-login so its §10 escalation lock accumulates across
 * challenges: a correct password is exactly what a 2FA-brute-forcing attacker
 * already holds, so if re-submitting it wiped the `two_factor_account` counter
 * the account lock would never accrue. The 2FA throttle is reset only on a
 * successful second-factor verify (and by {@link clearLoginThrottle} on admin
 * reset / re-enable, where a human has vouched for the account).
 */
export const clearPasswordThrottle = async (redis: Redis, userId: string): Promise<void> => {
  await resetProgressiveLimiter(redis, LOGIN_ACCOUNT_NAMESPACE, userId);
  await redis.del(pinFailCountKey(userId));
};

/**
 * Drop all per-account login-throttle state for a user — password-failure, PIN
 * fallback, AND the second-factor throttle — so they can authenticate
 * immediately. Called on a successful second-factor verify, admin password
 * reset, and re-enable. For a bare correct password (which still faces a 2FA
 * gate) use {@link clearPasswordThrottle} instead so the 2FA lock survives.
 */
export const clearLoginThrottle = async (redis: Redis, userId: string): Promise<void> => {
  await clearPasswordThrottle(redis, userId);
  await resetProgressiveLimiter(redis, TWO_FACTOR_ACCOUNT_NAMESPACE, userId);
};
