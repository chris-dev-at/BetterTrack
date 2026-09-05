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
 * tally must not itself write rows. Two counters per role — a TRAILING-window
 * one whose TTL is refreshed on every drop (so it reads as "drops in the last
 * window" and disappears on its own once the storm stops) and a retained total.
 * Both are best-effort: a tally failure degrades the number the admin sees, it
 * never fails a capture or a request.
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

/** Trailing window the `inWindow` counter reports, matching the capture cap. */
const DEFAULT_WINDOW_MS = 60_000;

/**
 * How long the running total is retained. "Since boot" is not expressible
 * across processes, so the shared total is a bounded recent history instead —
 * long enough that an operator opening the page after a night of job failures
 * still sees them, short enough that it cannot become an immortal key.
 */
const TOTAL_TTL_SECONDS = 24 * 60 * 60;

export interface CreateProblemDropTallyDeps {
  logger?: Logger;
  /** Trailing window length in ms. Defaults to 60_000 (the cap window). */
  windowMs?: number;
}

export function createProblemDropTally(
  redis: Redis,
  role: ProblemDropRole,
  deps: CreateProblemDropTallyDeps = {},
): ProblemDropTally {
  const { logger } = deps;
  const windowSeconds = Math.max(1, Math.ceil((deps.windowMs ?? DEFAULT_WINDOW_MS) / 1000));
  const windowKey = `${KEY_PREFIX}:${role}:recent`;
  const totalKey = `${KEY_PREFIX}:${role}:total`;
  const inflight = new Set<Promise<unknown>>();

  const toCount = (value: unknown): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  };

  return {
    record() {
      const write = redis
        .multi()
        .incr(windowKey)
        .expire(windowKey, windowSeconds)
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
        const [inWindow, total] = await redis.mget(windowKey, totalKey);
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
