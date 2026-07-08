import type { RealtimeLiveFrame } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

/**
 * Per-asset Redis ring buffer of live frames (PROJECTPLAN.md §6.3, V3-P7b).
 *
 * The shared poll loop appends one frame per tick; a viewer joining mid-stream
 * is backfilled from here before live frames take over, so the loop's history
 * survives the loop itself (and would survive moving the loop to the worker
 * process — the buffer, not the process, is the source of truth).
 *
 * Mechanics: RPUSH + LTRIM caps the list at `capacity` (enough frames to cover
 * the longest live window at the base poll cadence); PEXPIRE reaps buffers of
 * assets nobody has watched for a retention period, so idle assets cost zero
 * Redis memory.
 */
export const liveRingKey = (assetId: string): string => `live:ring:${assetId}`;

export interface LiveRingBuffer {
  /** Append one frame, trim to capacity, refresh the retention TTL. */
  append(frame: RealtimeLiveFrame): Promise<void>;
  /** All retained frames observed at or after `sinceMs`, oldest first. */
  readSince(assetId: string, sinceMs: number): Promise<RealtimeLiveFrame[]>;
}

export interface CreateLiveRingBufferOptions {
  /** Maximum frames retained per asset. */
  capacity: number;
  /** Idle-buffer expiry in milliseconds. */
  retentionMs: number;
}

export function createLiveRingBuffer(
  redis: Redis,
  options: CreateLiveRingBufferOptions,
): LiveRingBuffer {
  const { capacity, retentionMs } = options;

  return {
    async append(frame) {
      const key = liveRingKey(frame.assetId);
      await redis.rpush(key, JSON.stringify(frame));
      await redis.ltrim(key, -capacity, -1);
      await redis.pexpire(key, retentionMs);
    },

    async readSince(assetId, sinceMs) {
      const raw = await redis.lrange(liveRingKey(assetId), 0, -1);
      const frames: RealtimeLiveFrame[] = [];
      for (const entry of raw) {
        try {
          const frame = JSON.parse(entry) as RealtimeLiveFrame;
          if (Date.parse(frame.at) >= sinceMs) frames.push(frame);
        } catch {
          // Corrupt entry: skip it — the ring is a best-effort backfill source.
        }
      }
      return frames;
    },
  };
}
