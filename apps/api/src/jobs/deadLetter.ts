import type { Redis } from 'ioredis';

/**
 * Dead-letter list for permanently-failed jobs (PROJECTPLAN.md §9: "dead-letter
 * list visible in admin stats").
 *
 * BullMQ keeps its own failed set, but §9 calls for a dedicated, stable list the
 * admin stats endpoint can read directly. We push a compact record onto a Redis
 * list (newest first) and cap its length, so reads are a cheap `LRANGE` and the
 * list cannot grow without bound.
 */

export const DEAD_LETTER_KEY = 'bt:jobs:dead-letter';

/** Hard cap on retained dead-letter entries; older ones are trimmed away. */
export const DEAD_LETTER_MAX = 1000;

export interface DeadLetterEntry {
  /** Queue (job type) the job belonged to. */
  queue: string;
  /** BullMQ job id, if assigned. */
  jobId?: string;
  /** Job name within the queue. */
  name: string;
  /** The job payload, for diagnosis/replay. */
  data: unknown;
  /** Why the final attempt failed. */
  failedReason: string;
  /** How many attempts were made (equals the configured `attempts` for a permanent failure). */
  attemptsMade: number;
  /** Epoch ms when the entry was recorded. */
  timestamp: number;
}

export interface DeadLetter {
  /** Record a permanently-failed job. */
  record(entry: DeadLetterEntry): Promise<void>;
  /** Most-recent-first entries, capped at `limit` (default: all retained). */
  list(limit?: number): Promise<DeadLetterEntry[]>;
  /** Current number of retained entries. */
  size(): Promise<number>;
  /** Drop every entry. */
  clear(): Promise<void>;
}

export interface CreateDeadLetterOptions {
  key?: string;
  max?: number;
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number;
}

export function createDeadLetter(redis: Redis, options: CreateDeadLetterOptions = {}): DeadLetter {
  const key = options.key ?? DEAD_LETTER_KEY;
  const max = options.max ?? DEAD_LETTER_MAX;
  const now = options.now ?? Date.now;

  return {
    async record(entry: DeadLetterEntry): Promise<void> {
      const stamped: DeadLetterEntry = {
        ...entry,
        timestamp: entry.timestamp || now(),
      };
      // Newest first, then trim to the cap. LTRIM keeps indices [0, max-1].
      await redis.lpush(key, JSON.stringify(stamped));
      await redis.ltrim(key, 0, max - 1);
    },

    async list(limit?: number): Promise<DeadLetterEntry[]> {
      const end = limit && limit > 0 ? limit - 1 : -1;
      const raw = await redis.lrange(key, 0, end);
      const out: DeadLetterEntry[] = [];
      for (const item of raw) {
        try {
          out.push(JSON.parse(item) as DeadLetterEntry);
        } catch {
          // Skip a corrupt entry rather than failing the whole read.
        }
      }
      return out;
    },

    async size(): Promise<number> {
      return redis.llen(key);
    },

    async clear(): Promise<void> {
      await redis.del(key);
    },
  };
}

/**
 * Whether a BullMQ failure is permanent (all attempts exhausted) rather than a
 * still-retryable one. BullMQ emits `failed` after *every* attempt; only the
 * final one — where `attemptsMade` has reached the configured `attempts` — must
 * be dead-lettered. `attempts` defaults to 1 (a single run, no retries).
 */
export function isPermanentFailure(job: {
  attemptsMade: number;
  opts?: { attempts?: number };
}): boolean {
  const maxAttempts = job.opts?.attempts ?? 1;
  return job.attemptsMade >= maxAttempts;
}
