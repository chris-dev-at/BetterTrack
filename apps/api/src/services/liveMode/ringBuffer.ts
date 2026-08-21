import type { RealtimeLiveFrame } from '@bettertrack/contracts';
import type { Redis } from 'ioredis';

import { liveAssetRetirementStateKey } from './retirementFence';

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
  /** Append unless an E4 retirement fence is present. */
  append(frame: RealtimeLiveFrame, expectedRetirementEpoch?: number): Promise<boolean>;
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
    async append(frame, expectedRetirementEpoch = 0) {
      const key = liveRingKey(frame.assetId);
      // One atomic round-trip closes the remote-process race between an E4
      // fence deleting the ring and an already-running poll appending later.
      const appended = await redis.eval(
        `
          local epoch = tonumber(redis.call('HGET', KEYS[2], 'epoch') or '0')
          local state = redis.call('HGET', KEYS[2], 'state') or 'open'
          if epoch ~= tonumber(ARGV[4]) or state ~= 'open' then return 0 end
          redis.call('RPUSH', KEYS[1], ARGV[1])
          redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
          redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
          return 1
        `,
        2,
        key,
        liveAssetRetirementStateKey(frame.assetId),
        JSON.stringify(frame),
        capacity,
        retentionMs,
        expectedRetirementEpoch,
      );
      return Number(appended) === 1;
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
