import { randomUUID } from 'node:crypto';

import {
  LIVE_WINDOW_MS,
  type AssetRef,
  type LiveWindow,
  type RealtimeLiveFrame,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';

import { createLiveRingBuffer, liveRingKey, type LiveRingBuffer } from './ringBuffer';
import { liveAssetRetirementStateKey, readLiveAssetRetirementGeneration } from './retirementFence';

/**
 * Live Mode core (PROJECTPLAN.md §6.3, §5.3, V3-P7b; overhauled per #372): the
 * hot-asset registry and the shared per-asset polling loop behind the chart's
 * LIVE toggle.
 *
 * The §5.3 contract this service exists to keep: **N viewers of one asset cost
 * exactly one upstream stream.** The realtime gateway reports watchers in and
 * out; the FIRST watcher of an asset starts its loop, every further watcher
 * only registers its requested rate, and when the LAST one leaves the loop
 * stops within its own interval (auto-stop on idle — polling is strictly
 * presence-gated, #372). Each tick fetches one fresh quote through
 * {@link MarketDataService.pollQuote} — inside the provider request budget and
 * circuit breaker — appends the frame to the per-asset Redis ring buffer
 * (mid-stream joiners backfill their window from there) and hands it to the
 * gateway for `asset:{id}` room fan-out.
 *
 * Refresh rates (#372): every watcher registers with its own effective
 * interval and the shared loop polls at the FINEST rate any ACTIVE watcher
 * requested — the minimum, never a common divisor. The realtime contract
 * clamps client requests to a 5-second floor before they reach this service;
 * direct callers may inject smaller cadences only as a test seam.
 *
 * Upstream distress never reaches viewers: a failed tick (429/tripped breaker/
 * timeout) doubles the poll interval (from the finest active rate) up to
 * {@link LIVE_POLL_MAX_INTERVAL_MS} and the next success snaps back to the
 * finest-active cadence — frames slow down, nothing errors (§5.3 "TTLs stretch
 * instead of users seeing errors").
 *
 * History-stitched start (#372): when a viewer's window reaches further back
 * than the ring buffer holds (their live granularity is finer than anything
 * recorded), {@link LiveModeService.backfill} seeds the gap with the tail of
 * provider history — cached, coalesced 1-minute bars through the §5.3 core,
 * never a fresh per-viewer upstream call — marked `seed: true`. Live ticks
 * then age the seed out of the window until it is 100 % real observations.
 *
 * Hosting decision (§6.3 sketches the loop in the worker): API processes keep
 * socket-local watcher counts, while Redis elects exactly one process to poll
 * each globally-hot asset. Followers register their finest local rate and hold
 * no provider timer; an expiring owner lease plus a graceful-release wakeup
 * gives crash recovery without overlapping provider loops. The ring buffer and
 * cross-process gateway fan-out stay in Redis, so ownership can move without
 * changing the client data path.
 */

/** Default watcher rate when none is requested (pre-#372 cadence). */
export const LIVE_POLL_INTERVAL_MS = 10_000;
/** Ceiling for the distress-stretched interval. */
export const LIVE_POLL_MAX_INTERVAL_MS = 120_000;
/** Ring retention: the longest live window plus one stretched interval of slack. */
export const LIVE_RING_RETENTION_MS = LIVE_WINDOW_MS['12h'] + LIVE_POLL_MAX_INTERVAL_MS;
/** Cross-process poll-owner lease: one missed heartbeat is tolerated before failover. */
export const LIVE_LOOP_LEASE_TTL_MS = 60_000;
/** Poll-owner/rate reconciliation cadence across API processes. */
export const LIVE_LOOP_COORDINATION_INTERVAL_MS = 20_000;
/** Graceful owner release wakes follower processes on this ephemeral channel. */
export const LIVE_LOOP_COORDINATION_CHANNEL = 'bt:live:coordinate';
/**
 * Smallest ring-coverage gap worth stitching from history (#372): provider
 * intraday bars are 1-minute, so a finer gap has no history to fill it.
 */
export const LIVE_SEED_MIN_GAP_MS = 60_000;

export interface LiveModeService {
  /**
   * Register a watcher at its requested poll interval (#372; defaults to
   * {@link LIVE_POLL_INTERVAL_MS}). The first watcher starts the asset's poll
   * loop (first tick immediate); later watchers only register their rate, and
   * the loop re-derives its cadence — the finest ACTIVE rate. The caller (the
   * gateway) has already authorized the user and resolved the provider ref.
   * `sharedGlobalAsset` suppresses eager ownership when Redis admission already
   * saw another process holding this asset; the follower still registers for
   * rate reconciliation and crash failover.
   */
  /** Null when shutdown/fenced; otherwise the exact retirement generation held. */
  watch(
    assetId: string,
    ref: AssetRef,
    intervalMs?: number,
    sharedGlobalAsset?: boolean,
    previous?: { intervalMs?: number; retirementEpoch: number },
  ): Promise<{ retirementEpoch: number } | null>;
  /**
   * Deregister one watcher previously registered at `intervalMs` (same default
   * as {@link watch}); at zero watchers the loop stops and the asset goes cold.
   * A rate with no registered watcher is a no-op — never steals another
   * watcher's registration.
   */
  unwatch(assetId: string, intervalMs?: number, retirementEpoch?: number): void;
  /**
   * The requested window's frames, oldest first: the ring buffer's real
   * observations, preceded — when the ring does not reach back to the window's
   * start — by a history-stitched seed (`seed: true`) from cached provider
   * 1-minute bars (#372). Stitching is best-effort: on any history/quote
   * failure the ring frames alone are returned.
   */
  backfill(
    assetId: string,
    ref: AssetRef,
    window: LiveWindow,
    retirementEpoch?: number,
  ): Promise<RealtimeLiveFrame[]>;
  /** Subscribe to every frame the loops produce. Returns the unsubscribe. */
  onFrame(handler: (frame: RealtimeLiveFrame) => void): () => void;
  /** Current watcher count for an asset (0 = cold). */
  watcherCount(assetId: string): number;
  /** The asset's current poll interval, or null when no loop runs (introspection). */
  pollIntervalMs(assetId: string): number | null;
  /** Promptly reconcile a follower after another process releases poll ownership. */
  reconcile(assetId: string): void;
  /**
   * Fence provider work and delete retained live frames for assets whose
   * server-side identities are being retired by a paranoid-mode transition.
   */
  retireAssets(assetIds: readonly string[]): Promise<void>;
  /** Stop every loop and drop all subscribers (shutdown). */
  close(): void;
}

export interface LiveModeServiceOptions {
  /** Default watcher rate; defaults to {@link LIVE_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Stretch ceiling; defaults to {@link LIVE_POLL_MAX_INTERVAL_MS}. */
  maxIntervalMs?: number;
  /** Ring capacity; defaults to covering the 12 h window at the default rate. */
  ringCapacity?: number;
  /** Ring retention; defaults to {@link LIVE_RING_RETENTION_MS}. */
  ringRetentionMs?: number;
  /** Minimum ring gap worth history-stitching; defaults to {@link LIVE_SEED_MIN_GAP_MS}. */
  seedMinGapMs?: number;
  /** Cross-process owner heartbeat cadence; injectable only for focused tests. */
  coordinationIntervalMs?: number;
  /** Cross-process owner lease TTL; injectable only for focused tests. */
  leaderLeaseTtlMs?: number;
  /** Stable process token; injectable only to make cross-process tests legible. */
  instanceId?: string;
  /** Injectable clock for frame timestamps (tests). */
  now?: () => number;
}

export interface LiveModeServiceDeps {
  marketData: MarketDataService;
  redis: Redis;
  logger: Logger;
  /**
   * Resolve a closed E4 generation against account-locked Postgres state.
   * This repairs a fence left by SIGKILL before the move-in transaction could
   * commit or execute its process-local rollback hook.
   */
  reconcileRetirement?: (assetId: string) => Promise<void>;
  options?: LiveModeServiceOptions;
}

interface AssetLoop {
  ref: AssetRef;
  /** Per-hot-generation token; prevents a late release deleting a restarted loop. */
  coordinationId: string;
  /** Exact durable generation pinned when this local registration was admitted. */
  retirementEpoch: number;
  /** Requested interval → number of watchers holding it (a multiset, #372). */
  rates: Map<number, number>;
  /** Consecutive failed ticks; each one doubles the cadence up to the ceiling. */
  failures: number;
  /** Finest active rate across every API process, refreshed with the owner lease. */
  baseIntervalMs: number;
  /** Effective cadence: finest active rate × 2^failures, capped. */
  intervalMs: number;
  /** When the last tick started — anchor for rescheduling on rate changes. */
  lastTickAt: number;
  timer: NodeJS.Timeout | null;
  coordinationRunning: boolean;
  coordinationQueued: boolean;
  coordinationAllowAcquire: boolean;
  coordinationNotifyPeers: boolean;
  leader: boolean;
  /** Local work fence for the currently-proven Redis owner lease. */
  leaderLeaseExpiresAt: number;
}

export const liveLoopLeaderKey = (assetId: string): string =>
  `bt:live:leader:${encodeURIComponent(assetId)}`;
export const liveLoopProcessesKey = (assetId: string): string =>
  `bt:live:processes:${encodeURIComponent(assetId)}`;
const liveLoopRatesKey = (assetId: string): string =>
  `bt:live:rates:${encodeURIComponent(assetId)}`;

/**
 * Register this process's local demand, reap crashed peers, and atomically elect
 * at most one provider-loop owner. Followers still refresh their rate lease so
 * the owner can poll at the finest rate requested anywhere in the cluster.
 *
 * Every CROSS-PROCESS comparison here is on Redis's own clock: the registration
 * scores are stamped from `TIME` inside this script and reaped against the same
 * source, so a peer whose container clock runs minutes fast can neither reap a
 * live registration early nor keep a stale one alive (§13.5 V5-P1). Each
 * process still fences its OWN provider work with its own clock — but as an
 * elapsed-duration measurement from the instant this election was requested,
 * never as a comparison against a timestamp another process wrote.
 */
const COORDINATE_LOOP_SCRIPT = `
local instanceId = ARGV[1]
local rateMs = tonumber(ARGV[2])
local leaseTtlMs = tonumber(ARGV[3])
local keyTtlMs = tonumber(ARGV[4])
local allowAcquire = tonumber(ARGV[5])
local expectedEpoch = tonumber(ARGV[6])

local redisTime = redis.call('TIME')
local now = tonumber(redisTime[1]) * 1000 + math.floor(tonumber(redisTime[2]) / 1000)
local expiresAt = now + leaseTtlMs

-- E4's durable fence wins over every stale local watcher and lease. Remove this
-- process's demand atomically so deleting/recreating an API process cannot
-- resurrect polling while the custom asset exists only in ciphertext.
local retirementEpoch = tonumber(redis.call('HGET', KEYS[4], 'epoch') or '0')
local retirementState = redis.call('HGET', KEYS[4], 'state') or 'open'
if retirementState ~= 'open' or retirementEpoch ~= expectedEpoch then
  redis.call('ZREM', KEYS[2], instanceId)
  redis.call('HDEL', KEYS[3], instanceId)
  if redis.call('GET', KEYS[1]) == instanceId then
    redis.call('DEL', KEYS[1])
  end
  return { -1, rateMs }
end

local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, expiredId in ipairs(expired) do
  redis.call('HDEL', KEYS[3], expiredId)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)

redis.call('ZADD', KEYS[2], expiresAt, instanceId)
redis.call('HSET', KEYS[3], instanceId, rateMs)
redis.call('PEXPIRE', KEYS[2], keyTtlMs)
redis.call('PEXPIRE', KEYS[3], keyTtlMs)

-- The leader key carries its own PX lease, refreshed by its owner on every
-- coordination pass. That TTL is the single authority on whether an owner is
-- still live: a peer must never force-delete a key whose lease Redis still
-- honours, however the registration ZSET looks from here.
local owner = redis.call('GET', KEYS[1])
if not owner and allowAcquire == 1 then
  redis.call('SET', KEYS[1], instanceId, 'PX', leaseTtlMs)
  owner = instanceId
elseif owner == instanceId then
  redis.call('PEXPIRE', KEYS[1], leaseTtlMs)
end

local finest = rateMs
for _, candidate in ipairs(redis.call('HVALS', KEYS[3])) do
  finest = math.min(finest, tonumber(candidate))
end
return { owner == instanceId and 1 or 0, finest }
`;

/** Remove this process without deleting a successor's ownership. */
const RELEASE_LOOP_SCRIPT = `
local instanceId = ARGV[1]
redis.call('ZREM', KEYS[2], instanceId)
redis.call('HDEL', KEYS[3], instanceId)
local releasedOwner = 0
if redis.call('GET', KEYS[1]) == instanceId then
  redis.call('DEL', KEYS[1])
  releasedOwner = 1
end
return releasedOwner
`;

export function createLiveModeService(deps: LiveModeServiceDeps): LiveModeService {
  const { marketData, logger } = deps;
  const options = deps.options ?? {};
  const defaultIntervalMs = options.intervalMs ?? LIVE_POLL_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? LIVE_POLL_MAX_INTERVAL_MS;
  const retentionMs = options.ringRetentionMs ?? LIVE_RING_RETENTION_MS;
  const capacity = options.ringCapacity ?? Math.ceil(retentionMs / defaultIntervalMs);
  const seedMinGapMs = options.seedMinGapMs ?? LIVE_SEED_MIN_GAP_MS;
  const coordinationIntervalMs =
    options.coordinationIntervalMs ?? LIVE_LOOP_COORDINATION_INTERVAL_MS;
  const leaderLeaseTtlMs = options.leaderLeaseTtlMs ?? LIVE_LOOP_LEASE_TTL_MS;
  const coordinationKeyTtlMs = leaderLeaseTtlMs * 2;
  const instanceId = options.instanceId ?? randomUUID();
  const now = options.now ?? Date.now;

  const ring: LiveRingBuffer = createLiveRingBuffer(deps.redis, {
    capacity,
    retentionMs,
  });
  const loops = new Map<string, AssetLoop>();
  const inFlightTicks = new Map<string, Set<Promise<void>>>();
  const handlers = new Set<(frame: RealtimeLiveFrame) => void>();
  let coordinationTimer: NodeJS.Timeout | null = null;
  let closed = false;

  function emit(frame: RealtimeLiveFrame): void {
    for (const handler of [...handlers]) {
      try {
        handler(frame);
      } catch (err) {
        logger.warn({ err, assetId: frame.assetId }, 'live frame handler failed');
      }
    }
  }

  const watcherTotal = (loop: AssetLoop): number =>
    [...loop.rates.values()].reduce((sum, count) => sum + count, 0);

  /** Finest rate requested by this process; Redis reconciles it with every peer. */
  const finestLocalRateMs = (loop: AssetLoop): number => Math.min(...loop.rates.keys());

  /**
   * Re-derive the effective cadence from the rate set + distress state. The
   * ceiling only bounds distress STRETCHING — it never pulls the cadence below
   * the finest requested rate (a 2 s viewer must get 2 s, whatever the ceiling).
   */
  function applyCadence(loop: AssetLoop): void {
    // 2^failures with a hard cap keeps the multiplier finite under long outages.
    const stretched = loop.baseIntervalMs * 2 ** Math.min(loop.failures, 30);
    loop.intervalMs = Math.max(loop.baseIntervalMs, Math.min(stretched, maxIntervalMs));
  }

  /**
   * Move a PENDING tick onto the current cadence, anchored at the last tick —
   * a finer watcher arriving mid-wait gets their rate immediately (a 60 s wait
   * must not gate a new 1 s viewer), a coarser set just waits longer. A tick
   * already in flight reschedules itself in its `finally` instead.
   */
  function reschedule(assetId: string, loop: AssetLoop): void {
    if (closed || loops.get(assetId) !== loop || !loop.leader || loop.timer === null) return;
    if (now() >= loop.leaderLeaseExpiresAt) {
      stopPolling(loop);
      requestCoordination(assetId, loop, true);
      return;
    }
    clearTimeout(loop.timer);
    const delay = Math.max(0, loop.lastTickAt + loop.intervalMs - now());
    loop.timer = setTimeout(() => launchTick(assetId, loop), delay);
  }

  function stopPolling(loop: AssetLoop): void {
    loop.leader = false;
    loop.leaderLeaseExpiresAt = 0;
    if (loop.timer) clearTimeout(loop.timer);
    loop.timer = null;
  }

  function retireLocalLoop(assetId: string, loop: AssetLoop): void {
    if (loops.get(assetId) !== loop) return;
    stopPolling(loop);
    loops.delete(assetId);
    stopCoordinationTimerWhenIdle();
  }

  function applyGlobalRate(assetId: string, loop: AssetLoop, intervalMs: number): void {
    const before = loop.intervalMs;
    loop.baseIntervalMs = intervalMs;
    applyCadence(loop);
    if (loop.intervalMs < before) reschedule(assetId, loop);
  }

  async function releaseProcessRegistration(
    assetId: string,
    coordinationId: string,
  ): Promise<void> {
    const releasedOwner = await deps.redis.eval(
      RELEASE_LOOP_SCRIPT,
      3,
      liveLoopLeaderKey(assetId),
      liveLoopProcessesKey(assetId),
      liveLoopRatesKey(assetId),
      coordinationId,
    );
    // A follower leaving may also change the globally-finest rate, while an
    // owner leaving requires immediate election. One compact poke covers both.
    await deps.redis.publish(LIVE_LOOP_COORDINATION_CHANNEL, JSON.stringify({ assetId }));
    if (releasedOwner === 1) {
      logger.debug({ assetId }, 'live poll ownership released');
    }
  }

  async function runCoordination(assetId: string, loop: AssetLoop): Promise<void> {
    if (loop.coordinationRunning) return;
    loop.coordinationRunning = true;
    try {
      while (
        loop.coordinationQueued &&
        !closed &&
        loops.get(assetId) === loop &&
        watcherTotal(loop) > 0
      ) {
        const allowAcquire = loop.coordinationAllowAcquire;
        const notifyPeers = loop.coordinationNotifyPeers;
        loop.coordinationQueued = false;
        loop.coordinationAllowAcquire = false;
        loop.coordinationNotifyPeers = false;
        // The local fence is an elapsed-duration budget anchored BEFORE the
        // round trip: whatever Redis's clock says, this process may only work
        // for `leaderLeaseTtlMs` measured on its own clock from here, so the
        // election's cost is charged against the lease rather than added to it.
        const coordinatedAt = now();
        const leaseExpiresAt = coordinatedAt + leaderLeaseTtlMs;
        const result = (await deps.redis.eval(
          COORDINATE_LOOP_SCRIPT,
          4,
          liveLoopLeaderKey(assetId),
          liveLoopProcessesKey(assetId),
          liveLoopRatesKey(assetId),
          liveAssetRetirementStateKey(assetId),
          loop.coordinationId,
          finestLocalRateMs(loop),
          leaderLeaseTtlMs,
          coordinationKeyTtlMs,
          allowAcquire ? 1 : 0,
          loop.retirementEpoch,
        )) as [number | string, number | string];

        if (closed || loops.get(assetId) !== loop || watcherTotal(loop) === 0) {
          await releaseProcessRegistration(assetId, loop.coordinationId);
          return;
        }

        // A delayed Redis response never grants local work beyond the deadline
        // encoded in that exact atomic election.
        const ownership = Number(result[0]);
        if (ownership < 0) {
          retireLocalLoop(assetId, loop);
          return;
        }
        const ownsLoop = ownership === 1 && now() < leaseExpiresAt;
        applyGlobalRate(assetId, loop, Number(result[1]));
        if (ownsLoop) {
          loop.leaderLeaseExpiresAt = leaseExpiresAt;
          if (!loop.leader) {
            loop.leader = true;
            loop.failures = 0;
            applyCadence(loop);
            launchTick(assetId, loop);
          }
        } else if (!ownsLoop && loop.leader) {
          stopPolling(loop);
        }
        if (notifyPeers) {
          await deps.redis.publish(LIVE_LOOP_COORDINATION_CHANNEL, JSON.stringify({ assetId }));
        }
      }
    } catch (err) {
      // Losing Redis means ownership cannot be proven. Stop provider work now;
      // the expiring lease lets a healthy process take over without overlap.
      stopPolling(loop);
      logger.warn({ err, assetId }, 'live poll ownership reconciliation failed');
    } finally {
      loop.coordinationRunning = false;
      if (
        loop.coordinationQueued &&
        !closed &&
        loops.get(assetId) === loop &&
        watcherTotal(loop) > 0
      ) {
        void runCoordination(assetId, loop);
      }
    }
  }

  function requestCoordination(
    assetId: string,
    loop: AssetLoop,
    allowAcquire: boolean,
    notifyPeers = false,
  ): void {
    if (closed || loops.get(assetId) !== loop || watcherTotal(loop) === 0) return;
    loop.coordinationQueued = true;
    loop.coordinationAllowAcquire ||= allowAcquire;
    loop.coordinationNotifyPeers ||= notifyPeers;
    void runCoordination(assetId, loop);
  }

  function ensureCoordinationTimer(): void {
    if (coordinationTimer) return;
    coordinationTimer = setInterval(() => {
      for (const [assetId, loop] of loops) requestCoordination(assetId, loop, true);
    }, coordinationIntervalMs);
    coordinationTimer.unref?.();
  }

  function stopCoordinationTimerWhenIdle(): void {
    if (!coordinationTimer || loops.size > 0) return;
    clearInterval(coordinationTimer);
    coordinationTimer = null;
  }

  async function resolvedRetirementGeneration(assetId: string) {
    let generation = await readLiveAssetRetirementGeneration(deps.redis, assetId);
    if (!generation.open && deps.reconcileRetirement) {
      await deps.reconcileRetirement(assetId);
      generation = await readLiveAssetRetirementGeneration(deps.redis, assetId);
    }
    return generation;
  }

  async function proveOpenGeneration(
    assetId: string,
    loop: AssetLoop,
    stage: string,
  ): Promise<boolean> {
    try {
      const generation = await resolvedRetirementGeneration(assetId);
      if (generation.open && generation.epoch === loop.retirementEpoch) return true;
    } catch (err) {
      logger.warn({ err, assetId, stage }, 'live retirement-generation proof failed');
    }
    retireLocalLoop(assetId, loop);
    return false;
  }

  async function tick(assetId: string, loop: AssetLoop): Promise<void> {
    // A superseded loop (last watcher left, or close()) never polls again.
    if (closed || loops.get(assetId) !== loop || !loop.leader) return;
    loop.timer = null;
    // The local boolean is only a cache of the last election. A paused process
    // may resume after this lease expired and a follower took ownership; fence
    // provider work at the call boundary before an overdue timer can poll.
    if (now() >= loop.leaderLeaseExpiresAt) {
      stopPolling(loop);
      requestCoordination(assetId, loop, true);
      return;
    }
    if (!(await proveOpenGeneration(assetId, loop, 'before-poll'))) return;
    loop.lastTickAt = now();
    try {
      const cached = await marketData.pollQuote(loop.ref);
      if (!(await proveOpenGeneration(assetId, loop, 'after-poll'))) return;
      // Do not publish or reschedule a call whose owner proof expired in flight.
      if (
        closed ||
        loops.get(assetId) !== loop ||
        !loop.leader ||
        now() >= loop.leaderLeaseExpiresAt
      ) {
        if (loop.leader) {
          stopPolling(loop);
          requestCoordination(assetId, loop, true);
        }
        return;
      }
      const frame: RealtimeLiveFrame = {
        assetId,
        price: cached.value.price,
        currency: cached.value.currency,
        dayChangePct: cached.value.dayChangePct ?? null,
        // The provider's session state rides the quote (§13.5 V5-P1): the chart
        // shows "Market closed" when ticks stop because the exchange is closed.
        marketState: cached.value.marketState ?? null,
        at: new Date(now()).toISOString(),
      };
      loop.failures = 0; // recovered — snap back to the finest-active cadence
      applyCadence(loop);
      // A CLOSED market produces no new trades: the provider just re-serves the
      // last close, so a frame stamped `now` is a stale repeat, not an
      // observation. It still EMITS (drives the chart's "Market closed" chip),
      // but it must NOT enter the ring — otherwise a fresh joiner's backfill
      // fills the pinned [now − window, now] viewport with fake flat ticks
      // stamped `now` and the real last session scrolls off-screen (issue #690
      // Part A: "no fake flat ticks"). Real sessions — open/pre/post all move
      // prices — still record. This touches only what is stored, never the
      // verified coalescing/cadence loop (#372). §16-logged (V5-P1).
      if (frame.marketState !== 'closed') {
        try {
          const appended = await ring.append(frame, loop.retirementEpoch);
          if (!appended) {
            retireLocalLoop(assetId, loop);
            return;
          }
        } catch (err) {
          // The append is also the final atomic retirement-generation proof.
          // Losing Redis means the proof is unavailable, so fail closed: no
          // private frame may escape merely because backfill storage failed.
          retireLocalLoop(assetId, loop);
          logger.warn({ err, assetId }, 'live ring append/fence proof failed; loop retired');
          return;
        }
      }
      // Closed-session frames bypass the ring, so they need their own last
      // durable-fence read before crossing into gateway fan-out.
      if (frame.marketState === 'closed') {
        if (!(await proveOpenGeneration(assetId, loop, 'before-closed-frame'))) return;
      }
      emit(frame);
    } catch (err) {
      // 429 (breaker just tripped), CircuitOpenError, timeout, 5xx: stretch the
      // cadence instead of erroring viewers (§5.3); success resets it above.
      if (loop.leader && now() < loop.leaderLeaseExpiresAt) {
        loop.failures += 1;
        applyCadence(loop);
        logger.warn(
          { err, assetId, nextPollMs: loop.intervalMs },
          'live poll tick failed; stretching interval',
        );
      } else if (loop.leader) {
        stopPolling(loop);
        requestCoordination(assetId, loop, true);
      }
    } finally {
      if (
        !closed &&
        loops.get(assetId) === loop &&
        loop.leader &&
        now() < loop.leaderLeaseExpiresAt &&
        watcherTotal(loop) > 0
      ) {
        loop.timer = setTimeout(() => launchTick(assetId, loop), loop.intervalMs);
      }
    }
  }

  function launchTick(assetId: string, loop: AssetLoop): void {
    const task = tick(assetId, loop);
    const tasks = inFlightTicks.get(assetId) ?? new Set<Promise<void>>();
    tasks.add(task);
    inFlightTicks.set(assetId, tasks);
    void task
      .finally(() => {
        tasks.delete(task);
        if (tasks.size === 0) inFlightTicks.delete(assetId);
      })
      .catch((err) => {
        logger.warn({ err, assetId }, 'live poll tick escaped its error boundary');
      });
  }

  return {
    async watch(assetId, ref, intervalMs = defaultIntervalMs, sharedGlobalAsset = false, previous) {
      if (closed) return null;
      const generation = await resolvedRetirementGeneration(assetId);
      if (!generation.open || closed) return null;
      let existing = loops.get(assetId);
      if (existing && existing.retirementEpoch !== generation.epoch) {
        retireLocalLoop(assetId, existing);
        existing = undefined;
      }
      if (existing) {
        const previousRate = previous?.intervalMs ?? defaultIntervalMs;
        const previousIsCurrent = previous?.retirementEpoch === generation.epoch;
        if (!previousIsCurrent || previousRate !== intervalMs) {
          existing.rates.set(intervalMs, (existing.rates.get(intervalMs) ?? 0) + 1);
        }
        if (previousIsCurrent && previousRate !== intervalMs) {
          const held = existing.rates.get(previousRate);
          if (held !== undefined) {
            if (held > 1) existing.rates.set(previousRate, held - 1);
            else existing.rates.delete(previousRate);
          }
        }
        const before = existing.intervalMs;
        existing.baseIntervalMs = finestLocalRateMs(existing);
        applyCadence(existing);
        // Only a finer cadence moves the pending tick — poll-rate changes must
        // never fire an extra upstream call, so coarsening waits its turn.
        if (existing.intervalMs < before) reschedule(assetId, existing);
        requestCoordination(assetId, existing, true, true);
        return { retirementEpoch: generation.epoch };
      }
      const loop: AssetLoop = {
        ref,
        coordinationId: `${instanceId}:${randomUUID()}`,
        retirementEpoch: generation.epoch,
        rates: new Map([[intervalMs, 1]]),
        failures: 0,
        baseIntervalMs: intervalMs,
        intervalMs,
        lastTickAt: 0,
        timer: null,
        coordinationRunning: false,
        coordinationQueued: false,
        coordinationAllowAcquire: false,
        coordinationNotifyPeers: false,
        leader: false,
        leaderLeaseExpiresAt: 0,
      };
      applyCadence(loop);
      loops.set(assetId, loop);
      ensureCoordinationTimer();
      // A globally-shared asset starts as a follower: it registers its demand
      // but cannot opportunistically create a second provider loop. Periodic or
      // release-triggered reconciliation may elect it after the owner vanishes.
      requestCoordination(assetId, loop, !sharedGlobalAsset, true);
      return { retirementEpoch: generation.epoch };
    },

    unwatch(assetId, intervalMs = defaultIntervalMs, retirementEpoch) {
      const loop = loops.get(assetId);
      if (!loop) return;
      if (retirementEpoch !== undefined && loop.retirementEpoch !== retirementEpoch) return;
      const held = loop.rates.get(intervalMs);
      // Unknown rate ⇒ no watcher registered it — never steal another's count.
      if (held === undefined) return;
      if (held > 1) loop.rates.set(intervalMs, held - 1);
      else loop.rates.delete(intervalMs);
      if (loop.rates.size > 0) {
        // The finest watcher leaving coarsens the loop to the new minimum. The
        // pending tick keeps its (finer) schedule — one early tick, then the
        // new cadence takes over at its reschedule.
        loop.baseIntervalMs = finestLocalRateMs(loop);
        applyCadence(loop);
        requestCoordination(assetId, loop, true, true);
        return;
      }
      // Last watcher gone: stop now. An in-flight tick notices the map no
      // longer holds its loop and never reschedules — upstream calls cease
      // within one interval (§6.3 auto-stop; presence-gated, #372).
      if (loop.timer) clearTimeout(loop.timer);
      stopPolling(loop);
      loops.delete(assetId);
      stopCoordinationTimerWhenIdle();
      void releaseProcessRegistration(assetId, loop.coordinationId).catch((err) => {
        logger.warn({ err, assetId }, 'live poll ownership release failed');
      });
    },

    async backfill(assetId, ref, window, retirementEpoch) {
      const generation = await resolvedRetirementGeneration(assetId);
      if (
        !generation.open ||
        (retirementEpoch !== undefined && generation.epoch !== retirementEpoch)
      ) {
        throw new Error('live asset retirement generation changed');
      }
      const windowStart = now() - LIVE_WINDOW_MS[window];
      const frames = await ring.readSince(assetId, windowStart);
      // Where real observations start; an empty ring covers nothing (gap = full window).
      const coveredFromMs = frames.length > 0 ? Date.parse(frames[0]!.at) : now();
      if (coveredFromMs - windowStart < seedMinGapMs) return frames;
      try {
        // Cached + coalesced through the §5.3 core (finest bars the provider
        // has): a burst of joining viewers shares ONE upstream history call.
        const history = await marketData.getHistory(ref, '1D', '1m');
        // Seeds carry a currency like every frame; the ring's newest real frame
        // is authoritative, else the (cache-served) quote — primed by the poll
        // loop's first tick in the common path.
        const currency = frames[0]?.currency ?? (await marketData.getQuote(ref)).value.currency;
        const seed: RealtimeLiveFrame[] = [];
        for (const point of history.value) {
          const atMs = Date.parse(point.time);
          if (Number.isNaN(atMs) || atMs < windowStart || atMs >= coveredFromMs) continue;
          seed.push({
            assetId,
            price: point.close,
            currency,
            dayChangePct: null,
            at: new Date(atMs).toISOString(),
            seed: true,
          });
        }
        seed.sort((a, b) => a.at.localeCompare(b.at));
        return [...seed, ...frames];
      } catch (err) {
        // Best-effort: a viewer who cannot be seeded still gets every real
        // frame — silence over errors, exactly like the poll loop (§5.3).
        logger.warn({ err, assetId, window }, 'live backfill history stitch failed');
        return frames;
      }
    },

    onFrame(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    watcherCount(assetId) {
      const loop = loops.get(assetId);
      return loop ? watcherTotal(loop) : 0;
    },

    pollIntervalMs(assetId) {
      return loops.get(assetId)?.intervalMs ?? null;
    },

    reconcile(assetId) {
      const loop = loops.get(assetId);
      if (loop) requestCoordination(assetId, loop, true);
    },

    async retireAssets(assetIds) {
      const retiredIds = [...new Set(assetIds)];
      const releases: Promise<void>[] = [];
      const ticks: Promise<void>[] = [];

      for (const assetId of retiredIds) {
        const loop = loops.get(assetId);
        if (loop) {
          stopPolling(loop);
          loops.delete(assetId);
          releases.push(releaseProcessRegistration(assetId, loop.coordinationId));
        }
        ticks.push(...(inFlightTicks.get(assetId) ?? []));
      }
      stopCoordinationTimerWhenIdle();

      const releaseResults = await Promise.allSettled(releases);
      for (const result of releaseResults) {
        if (result.status === 'rejected') {
          logger.warn({ err: result.reason }, 'live poll ownership retirement release failed');
        }
      }
      await Promise.allSettled(ticks);
      if (retiredIds.length > 0) {
        await deps.redis.del(...retiredIds.map(liveRingKey));
      }
    },

    close() {
      closed = true;
      if (coordinationTimer) clearInterval(coordinationTimer);
      coordinationTimer = null;
      for (const [assetId, loop] of loops) {
        if (loop.timer) clearTimeout(loop.timer);
        stopPolling(loop);
        void releaseProcessRegistration(assetId, loop.coordinationId).catch((err) => {
          logger.warn({ err, assetId }, 'live poll ownership shutdown release failed');
        });
      }
      loops.clear();
      handlers.clear();
    },
  };
}
