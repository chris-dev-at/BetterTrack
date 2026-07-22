import {
  LIVE_WINDOW_MS,
  type AssetRef,
  type LiveWindow,
  type RealtimeLiveFrame,
} from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import type { Logger } from '../../logger';
import type { MarketDataService } from '../../providers';

import { createLiveRingBuffer, type LiveRingBuffer } from './ringBuffer';

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
 * Refresh rates (#372): every watcher registers with its own requested
 * interval (down to 1 s) and the shared loop polls at the FINEST rate any
 * ACTIVE watcher requested — the minimum, never a common divisor (4 s + 2 s
 * viewers ⇒ one 2 s loop, NOT 1 s). When the finest watcher leaves, the loop
 * coarsens to the new minimum; when a finer one arrives, the pending tick is
 * rescheduled against the last tick so the tighter cadence applies at once.
 * Coarser viewers downsample client-side — the loop never polls faster than
 * the fastest active viewer needs, and never once per viewer.
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
 * Hosting decision (§6.3 sketches the loop in the worker): the loop lives in
 * the API process next to the gateway, because the watcher lifecycle is
 * socket-driven and in-process counting makes start/auto-stop trivially
 * correct with no cross-process watcher registry. The ring buffer stays in
 * Redis, so relocating the loop to the worker later is a wiring change, not a
 * data-path change.
 */

/** Default watcher rate when none is requested (pre-#372 cadence). */
export const LIVE_POLL_INTERVAL_MS = 10_000;
/** Ceiling for the distress-stretched interval. */
export const LIVE_POLL_MAX_INTERVAL_MS = 120_000;
/** Ring retention: the longest live window plus one stretched interval of slack. */
export const LIVE_RING_RETENTION_MS = LIVE_WINDOW_MS['12h'] + LIVE_POLL_MAX_INTERVAL_MS;
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
   */
  watch(assetId: string, ref: AssetRef, intervalMs?: number): void;
  /**
   * Deregister one watcher previously registered at `intervalMs` (same default
   * as {@link watch}); at zero watchers the loop stops and the asset goes cold.
   * A rate with no registered watcher is a no-op — never steals another
   * watcher's registration.
   */
  unwatch(assetId: string, intervalMs?: number): void;
  /**
   * The requested window's frames, oldest first: the ring buffer's real
   * observations, preceded — when the ring does not reach back to the window's
   * start — by a history-stitched seed (`seed: true`) from cached provider
   * 1-minute bars (#372). Stitching is best-effort: on any history/quote
   * failure the ring frames alone are returned.
   */
  backfill(assetId: string, ref: AssetRef, window: LiveWindow): Promise<RealtimeLiveFrame[]>;
  /** Subscribe to every frame the loops produce. Returns the unsubscribe. */
  onFrame(handler: (frame: RealtimeLiveFrame) => void): () => void;
  /** Current watcher count for an asset (0 = cold). */
  watcherCount(assetId: string): number;
  /** The asset's current poll interval, or null when no loop runs (introspection). */
  pollIntervalMs(assetId: string): number | null;
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
  /** Injectable clock for frame timestamps (tests). */
  now?: () => number;
}

export interface LiveModeServiceDeps {
  marketData: MarketDataService;
  redis: Redis;
  logger: Logger;
  options?: LiveModeServiceOptions;
}

interface AssetLoop {
  ref: AssetRef;
  /** Requested interval → number of watchers holding it (a multiset, #372). */
  rates: Map<number, number>;
  /** Consecutive failed ticks; each one doubles the cadence up to the ceiling. */
  failures: number;
  /** Effective cadence: finest active rate × 2^failures, capped. */
  intervalMs: number;
  /** When the last tick started — anchor for rescheduling on rate changes. */
  lastTickAt: number;
  timer: NodeJS.Timeout | null;
}

export function createLiveModeService(deps: LiveModeServiceDeps): LiveModeService {
  const { marketData, logger } = deps;
  const options = deps.options ?? {};
  const defaultIntervalMs = options.intervalMs ?? LIVE_POLL_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? LIVE_POLL_MAX_INTERVAL_MS;
  const retentionMs = options.ringRetentionMs ?? LIVE_RING_RETENTION_MS;
  const capacity = options.ringCapacity ?? Math.ceil(retentionMs / defaultIntervalMs);
  const seedMinGapMs = options.seedMinGapMs ?? LIVE_SEED_MIN_GAP_MS;
  const now = options.now ?? Date.now;

  const ring: LiveRingBuffer = createLiveRingBuffer(deps.redis, { capacity, retentionMs });
  const loops = new Map<string, AssetLoop>();
  const handlers = new Set<(frame: RealtimeLiveFrame) => void>();
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

  /** Finest ACTIVE rate: the minimum requested interval — never a divisor (#372). */
  const finestRateMs = (loop: AssetLoop): number => Math.min(...loop.rates.keys());

  /**
   * Re-derive the effective cadence from the rate set + distress state. The
   * ceiling only bounds distress STRETCHING — it never pulls the cadence below
   * the finest requested rate (a 2 s viewer must get 2 s, whatever the ceiling).
   */
  function applyCadence(loop: AssetLoop): void {
    // 2^failures with a hard cap keeps the multiplier finite under long outages.
    const stretched = finestRateMs(loop) * 2 ** Math.min(loop.failures, 30);
    loop.intervalMs = Math.max(finestRateMs(loop), Math.min(stretched, maxIntervalMs));
  }

  /**
   * Move a PENDING tick onto the current cadence, anchored at the last tick —
   * a finer watcher arriving mid-wait gets their rate immediately (a 60 s wait
   * must not gate a new 1 s viewer), a coarser set just waits longer. A tick
   * already in flight reschedules itself in its `finally` instead.
   */
  function reschedule(assetId: string, loop: AssetLoop): void {
    if (closed || loops.get(assetId) !== loop || loop.timer === null) return;
    clearTimeout(loop.timer);
    const delay = Math.max(0, loop.lastTickAt + loop.intervalMs - now());
    loop.timer = setTimeout(() => void tick(assetId, loop), delay);
  }

  async function tick(assetId: string, loop: AssetLoop): Promise<void> {
    // A superseded loop (last watcher left, or close()) never polls again.
    if (closed || loops.get(assetId) !== loop) return;
    loop.timer = null;
    loop.lastTickAt = now();
    try {
      const cached = await marketData.pollQuote(loop.ref);
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
      try {
        await ring.append(frame);
      } catch (err) {
        // A Redis hiccup only costs backfill history — the quote succeeded, so
        // the frame still reaches live viewers and the cadence stays at base;
        // stretching is reserved for UPSTREAM distress (§5.3).
        logger.warn({ err, assetId }, 'live ring append failed; frame emitted without backfill');
      }
      emit(frame);
    } catch (err) {
      // 429 (breaker just tripped), CircuitOpenError, timeout, 5xx: stretch the
      // cadence instead of erroring viewers (§5.3); success resets it above.
      loop.failures += 1;
      applyCadence(loop);
      logger.warn(
        { err, assetId, nextPollMs: loop.intervalMs },
        'live poll tick failed; stretching interval',
      );
    } finally {
      if (!closed && loops.get(assetId) === loop && watcherTotal(loop) > 0) {
        loop.timer = setTimeout(() => void tick(assetId, loop), loop.intervalMs);
      }
    }
  }

  return {
    watch(assetId, ref, intervalMs = defaultIntervalMs) {
      if (closed) return;
      const existing = loops.get(assetId);
      if (existing) {
        existing.rates.set(intervalMs, (existing.rates.get(intervalMs) ?? 0) + 1);
        const before = existing.intervalMs;
        applyCadence(existing);
        // Only a finer cadence moves the pending tick — poll-rate changes must
        // never fire an extra upstream call, so coarsening waits its turn.
        if (existing.intervalMs < before) reschedule(assetId, existing);
        return;
      }
      const loop: AssetLoop = {
        ref,
        rates: new Map([[intervalMs, 1]]),
        failures: 0,
        intervalMs,
        lastTickAt: 0,
        timer: null,
      };
      applyCadence(loop);
      loops.set(assetId, loop);
      // Immediate first tick: the first watcher sees a frame right away.
      void tick(assetId, loop);
    },

    unwatch(assetId, intervalMs = defaultIntervalMs) {
      const loop = loops.get(assetId);
      if (!loop) return;
      const held = loop.rates.get(intervalMs);
      // Unknown rate ⇒ no watcher registered it — never steal another's count.
      if (held === undefined) return;
      if (held > 1) loop.rates.set(intervalMs, held - 1);
      else loop.rates.delete(intervalMs);
      if (loop.rates.size > 0) {
        // The finest watcher leaving coarsens the loop to the new minimum. The
        // pending tick keeps its (finer) schedule — one early tick, then the
        // new cadence takes over at its reschedule.
        applyCadence(loop);
        return;
      }
      // Last watcher gone: stop now. An in-flight tick notices the map no
      // longer holds its loop and never reschedules — upstream calls cease
      // within one interval (§6.3 auto-stop; presence-gated, #372).
      if (loop.timer) clearTimeout(loop.timer);
      loops.delete(assetId);
    },

    async backfill(assetId, ref, window) {
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

    close() {
      closed = true;
      for (const loop of loops.values()) {
        if (loop.timer) clearTimeout(loop.timer);
      }
      loops.clear();
      handlers.clear();
    },
  };
}
