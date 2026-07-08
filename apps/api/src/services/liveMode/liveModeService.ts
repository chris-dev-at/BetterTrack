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
 * Live Mode core (PROJECTPLAN.md §6.3, §5.3, V3-P7b): the hot-asset registry
 * and the shared per-asset polling loop behind the chart's LIVE toggle.
 *
 * The §5.3 contract this service exists to keep: **N viewers of one asset cost
 * exactly one upstream stream.** The realtime gateway reports watchers in and
 * out; the FIRST watcher of an asset starts its loop, every further watcher
 * only bumps a counter, and when the LAST one leaves the loop stops within its
 * own interval (auto-stop on idle). Each tick fetches one fresh quote through
 * {@link MarketDataService.pollQuote} — inside the provider request budget and
 * circuit breaker — appends the frame to the per-asset Redis ring buffer
 * (mid-stream joiners backfill their window from there) and hands it to the
 * gateway for `asset:{id}` room fan-out.
 *
 * Upstream distress never reaches viewers: a failed tick (429/tripped breaker/
 * timeout) doubles the poll interval up to {@link LIVE_POLL_MAX_INTERVAL_MS}
 * and the next success snaps back to the base cadence — frames slow down,
 * nothing errors (§5.3 "TTLs stretch instead of users seeing errors").
 *
 * Hosting decision (§6.3 sketches the loop in the worker): the loop lives in
 * the API process next to the gateway, because the watcher lifecycle is
 * socket-driven and in-process counting makes start/auto-stop trivially
 * correct with no cross-process watcher registry. The ring buffer stays in
 * Redis, so relocating the loop to the worker later is a wiring change, not a
 * data-path change.
 */

/** Base poll cadence per hot asset. */
export const LIVE_POLL_INTERVAL_MS = 10_000;
/** Ceiling for the distress-stretched interval. */
export const LIVE_POLL_MAX_INTERVAL_MS = 120_000;
/** Ring retention: the longest live window plus one stretched interval of slack. */
export const LIVE_RING_RETENTION_MS = LIVE_WINDOW_MS['12h'] + LIVE_POLL_MAX_INTERVAL_MS;

export interface LiveModeService {
  /**
   * Register a watcher. The first watcher starts the asset's poll loop (first
   * tick immediate); later watchers only increment the count. The caller (the
   * gateway) has already authorized the user and resolved the provider ref.
   */
  watch(assetId: string, ref: AssetRef): void;
  /** Deregister a watcher; at zero the loop stops and the asset goes cold. */
  unwatch(assetId: string): void;
  /** The requested window's frames from the ring buffer, oldest first. */
  backfill(assetId: string, window: LiveWindow): Promise<RealtimeLiveFrame[]>;
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
  /** Base poll cadence; defaults to {@link LIVE_POLL_INTERVAL_MS}. */
  intervalMs?: number;
  /** Stretch ceiling; defaults to {@link LIVE_POLL_MAX_INTERVAL_MS}. */
  maxIntervalMs?: number;
  /** Ring capacity; defaults to covering the 12 h window at the base cadence. */
  ringCapacity?: number;
  /** Ring retention; defaults to {@link LIVE_RING_RETENTION_MS}. */
  ringRetentionMs?: number;
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
  count: number;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
}

export function createLiveModeService(deps: LiveModeServiceDeps): LiveModeService {
  const { marketData, logger } = deps;
  const options = deps.options ?? {};
  const baseIntervalMs = options.intervalMs ?? LIVE_POLL_INTERVAL_MS;
  const maxIntervalMs = options.maxIntervalMs ?? LIVE_POLL_MAX_INTERVAL_MS;
  const retentionMs = options.ringRetentionMs ?? LIVE_RING_RETENTION_MS;
  const capacity = options.ringCapacity ?? Math.ceil(retentionMs / baseIntervalMs);
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

  async function tick(assetId: string, loop: AssetLoop): Promise<void> {
    // A superseded loop (last watcher left, or close()) never polls again.
    if (closed || loops.get(assetId) !== loop) return;
    loop.timer = null;
    try {
      const cached = await marketData.pollQuote(loop.ref);
      const frame: RealtimeLiveFrame = {
        assetId,
        price: cached.value.price,
        currency: cached.value.currency,
        dayChangePct: cached.value.dayChangePct ?? null,
        at: new Date(now()).toISOString(),
      };
      loop.intervalMs = baseIntervalMs; // recovered — snap back to base cadence
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
      loop.intervalMs = Math.min(loop.intervalMs * 2, maxIntervalMs);
      logger.warn(
        { err, assetId, nextPollMs: loop.intervalMs },
        'live poll tick failed; stretching interval',
      );
    } finally {
      if (!closed && loops.get(assetId) === loop && loop.count > 0) {
        loop.timer = setTimeout(() => void tick(assetId, loop), loop.intervalMs);
      }
    }
  }

  return {
    watch(assetId, ref) {
      if (closed) return;
      const existing = loops.get(assetId);
      if (existing) {
        existing.count += 1;
        return;
      }
      const loop: AssetLoop = { ref, count: 1, intervalMs: baseIntervalMs, timer: null };
      loops.set(assetId, loop);
      // Immediate first tick: the first watcher sees a frame right away.
      void tick(assetId, loop);
    },

    unwatch(assetId) {
      const loop = loops.get(assetId);
      if (!loop) return;
      loop.count -= 1;
      if (loop.count > 0) return;
      // Last watcher gone: stop now. An in-flight tick notices the map no
      // longer holds its loop and never reschedules — upstream calls cease
      // within one interval (§6.3 auto-stop).
      if (loop.timer) clearTimeout(loop.timer);
      loops.delete(assetId);
    },

    backfill(assetId, window) {
      return ring.readSince(assetId, now() - LIVE_WINDOW_MS[window]);
    },

    onFrame(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    watcherCount(assetId) {
      return loops.get(assetId)?.count ?? 0;
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
