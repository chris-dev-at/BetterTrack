import type { Redis } from 'ioredis';

import type { ProblemRow } from '../../data/schema';
import type { Logger } from '../../logger';

import type { DropReason, ProblemDropCounters } from './problemService';

/**
 * Cross-process tally of refused problem captures (§13.5 V5-P2 arc (d)).
 *
 * The API and the worker each build their OWN {@link createProblemService} with
 * its own in-memory counters, but only the API serves `/admin/problems` — and
 * every `kind: 'job'` capture is refused in the worker. Without a shared tally
 * the admin page reports `droppedCaptures: 0` through a worker drop storm,
 * which is precisely the silent drop the capture contract says cannot happen
 * (and §6.12: the admin console is the only management surface — the container
 * log is not a channel the operator is expected to read).
 *
 * Redis, not the DB: a drop means the write budget is already exhausted, so the
 * tally must not itself write rows. Two counters per role — a per-window one
 * (the key is BUCKETED by window, so it reads as "drops in the current window"
 * and starts from zero in the next one) and a retained total. Both are
 * best-effort: a tally failure degrades the number the admin sees, it never
 * fails a capture or a request.
 *
 * The window counter used to be ONE key whose TTL was refreshed on every drop
 * (#1847): under exactly the sustained pressure it exists to report, the key
 * never expired, so a six-hour storm's 18 000 refusals were published — and
 * summed with the capture service's genuinely per-window counter — as a
 * one-minute figure. Bucketing makes the two halves of `droppedCaptures` the
 * same fixed window the capture cap itself rolls on.
 */
export interface ProblemDropTally {
  /** Record one refused capture. Fire-and-forget; never throws, never blocks. */
  record(kind: ProblemRow['kind'], reason: DropReason): void;
  /** Read the tally (the publishing side). Resolves to zeroes when unreadable. */
  read(): Promise<ProblemDropCounters>;
  /** Await in-flight `record` writes (tests / shutdown). Never rejects. */
  settled(): Promise<void>;
}

/** Which process's refusals a tally instance carries. */
export type ProblemDropRole = 'worker';

const KEY_PREFIX = 'problems:drops';

/** Fixed window the `inWindow` counter reports, matching the capture cap. */
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Grace seconds a closed bucket lingers past its own window, so a read whose
 * clock is a shade behind the writer's still finds the bucket it asks for. Not
 * a widening of the window: a bucket is only ever READ during its own window.
 */
const BUCKET_GRACE_SECONDS = 5;

/**
 * How long the running total is retained. "Since boot" is not expressible
 * across processes, so the shared total is a bounded recent history instead —
 * long enough that an operator opening the page after a night of job failures
 * still sees them, short enough that it cannot become an immortal key.
 */
const TOTAL_TTL_SECONDS = 24 * 60 * 60;

export interface CreateProblemDropTallyDeps {
  logger?: Logger;
  /** Fixed window length in ms. Defaults to 60_000 (the cap window). */
  windowMs?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export function createProblemDropTally(
  redis: Redis,
  role: ProblemDropRole,
  deps: CreateProblemDropTallyDeps = {},
): ProblemDropTally {
  const { logger } = deps;
  const now = deps.now ?? Date.now;
  const windowMs = Math.max(1000, deps.windowMs ?? DEFAULT_WINDOW_MS);
  const totalKey = `${KEY_PREFIX}:${role}:total`;
  const inflight = new Set<Promise<unknown>>();

  /**
   * The key of the window `t` falls in. Both sides derive it from the same
   * wall clock, so the reader always asks for the bucket the writer is filling.
   */
  const windowKeyAt = (t: number): string =>
    `${KEY_PREFIX}:${role}:window:${Math.floor(t / windowMs)}`;

  /**
   * Seconds this bucket has left. Recomputed per drop from the window's END, so
   * repeating it is idempotent rather than an extension: a bucket dies when its
   * window does however many refusals land in it.
   */
  const bucketTtlSeconds = (t: number): number =>
    Math.ceil((Math.floor(t / windowMs) * windowMs + windowMs - t) / 1000) + BUCKET_GRACE_SECONDS;

  const toCount = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  };

  return {
    record() {
      const t = now();
      const write = redis
        .multi()
        .incr(windowKeyAt(t))
        .expire(windowKeyAt(t), bucketTtlSeconds(t))
        .incr(totalKey)
        .expire(totalKey, TOTAL_TTL_SECONDS)
        .exec()
        .catch((err: unknown) => {
          logger?.warn({ err }, 'failed to publish a problem-capture drop to the shared tally');
        });
      inflight.add(write);
      void write.finally(() => inflight.delete(write));
    },

    async read() {
      try {
        const [inWindow, total] = await redis.mget(windowKeyAt(now()), totalKey);
        return { inWindow: toCount(inWindow), total: toCount(total) };
      } catch (err) {
        logger?.warn({ err }, 'failed to read the shared problem-capture drop tally');
        return { inWindow: 0, total: 0 };
      }
    },

    async settled() {
      await Promise.allSettled([...inflight]);
    },
  };
}
