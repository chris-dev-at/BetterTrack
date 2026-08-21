import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { Database } from '../../data/db';
import { withFreshLockedPrivacyModes } from '../../data/repositories/paranoidEnforcementRepository';
import { isPortfolioVaultLiveRetirementRequired } from '../../data/repositories/portfolioVaultLiveRetirementRepository';

/**
 * A durable cross-process fence for an owner-manual asset whose cleartext is
 * absent while it lives in a portfolio vault. Unlike the coordination channel,
 * this key survives a missed pub/sub message and an API-process restart.
 */
export const liveAssetRetirementStateKey = (assetId: string): string =>
  `bt:live:retirement:${createHash('sha256')
    .update('bettertrack:live-retirement:v1\0')
    .update(assetId)
    .digest('base64url')}`;

/** Ephemeral wake-up channel shared with the live-loop ownership protocol. */
const LIVE_LOOP_COORDINATION_CHANNEL = 'bt:live:coordinate';
const retiredLiveRingKey = (assetId: string): string => `live:ring:${assetId}`;
const retiredLiveLeaderKey = (assetId: string): string =>
  `bt:live:leader:${encodeURIComponent(assetId)}`;
const retiredLiveProcessesKey = (assetId: string): string =>
  `bt:live:processes:${encodeURIComponent(assetId)}`;
const retiredLiveRatesKey = (assetId: string): string =>
  `bt:live:rates:${encodeURIComponent(assetId)}`;

const CLOSE_RETIREMENT_GENERATION_SCRIPT = `
local count = tonumber(ARGV[1])
for i = 0, count - 1 do
  local offset = i * 5
  redis.call('HINCRBY', KEYS[offset + 1], 'epoch', 1)
  redis.call('HSET', KEYS[offset + 1], 'state', 'closed')
  redis.call('DEL', KEYS[offset + 2], KEYS[offset + 3], KEYS[offset + 4], KEYS[offset + 5])
  redis.call('PUBLISH', ARGV[2], ARGV[i + 3])
end
return count
`;

const OPEN_RETIREMENT_GENERATION_SCRIPT = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    redis.call('HSET', KEYS[i], 'state', 'open')
  end
end
return #KEYS
`;

export interface LiveAssetRetirementGeneration {
  epoch: number;
  open: boolean;
}

/** Missing state is the initial open generation zero. */
export async function readLiveAssetRetirementGeneration(
  redis: Redis,
  assetId: string,
): Promise<LiveAssetRetirementGeneration> {
  const [epochRaw, state] = await redis.hmget(
    liveAssetRetirementStateKey(assetId),
    'epoch',
    'state',
  );
  return {
    epoch: epochRaw === null ? 0 : Number(epochRaw),
    open: state === null || state === 'open',
  };
}

/**
 * Fence first, then remove retained frames. A racing ring append is itself
 * conditional on this fence, so no remote process can repopulate the ring
 * after the delete even when it missed the wake-up message.
 */
export async function fenceRetiredLiveAssets(
  redis: Redis,
  assetIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(assetIds)];
  if (uniqueIds.length === 0) return;
  const keys = uniqueIds.flatMap((assetId) => [
    liveAssetRetirementStateKey(assetId),
    retiredLiveRingKey(assetId),
    retiredLiveLeaderKey(assetId),
    retiredLiveProcessesKey(assetId),
    retiredLiveRatesKey(assetId),
  ]);
  await redis.eval(
    CLOSE_RETIREMENT_GENERATION_SCRIPT,
    keys.length,
    ...keys,
    uniqueIds.length,
    LIVE_LOOP_COORDINATION_CHANNEL,
    ...uniqueIds.map((assetId) => JSON.stringify({ assetId, retired: true })),
  );
}

/** Re-enable identities only after a durable-state reconciliation says they are safe. */
export async function releaseRetiredLiveAssets(
  redis: Redis,
  assetIds: readonly string[],
): Promise<void> {
  const keys = [...new Set(assetIds)].map(liveAssetRetirementStateKey);
  if (keys.length === 0) return;
  await redis.eval(OPEN_RETIREMENT_GENERATION_SCRIPT, keys.length, ...keys);
}

/**
 * Reconcile a crash- or rollback-ambiguous fence with committed Postgres state.
 * The fresh account lock covers both the durable read and Redis release: a new
 * move-in therefore commits before this reads, or fences only after this opens.
 */
export async function reconcilePortfolioVaultLiveAssetRetirements(input: {
  db: Database;
  lockDb: Database;
  redis: Redis;
  userId: string;
  assetIds: readonly string[];
}): Promise<void> {
  const uniqueIds = [...new Set(input.assetIds)];
  if (uniqueIds.length === 0) return;
  await withFreshLockedPrivacyModes(input.lockDb, [input.userId], async () => {
    const required = await Promise.all(
      uniqueIds.map((assetId) =>
        isPortfolioVaultLiveRetirementRequired(input.db, input.userId, assetId),
      ),
    );
    await releaseRetiredLiveAssets(
      input.redis,
      uniqueIds.filter((_assetId, index) => !required[index]),
    );
  });
}
