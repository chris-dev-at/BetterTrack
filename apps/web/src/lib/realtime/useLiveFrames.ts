import { useEffect, useState } from 'react';

import {
  REALTIME_SERVER_EVENTS,
  realtimeLiveFrameSchema,
  type LiveWindow,
  type RealtimeLiveFrame,
} from '@bettertrack/contracts';

import { useRealtime } from './RealtimeProvider';

export interface LiveFramesState {
  /** Backfill + streamed frames for the asset, oldest first. */
  frames: RealtimeLiveFrame[];
  /** True while a live watch is established — frames are flowing (or imminent). */
  streaming: boolean;
}

/**
 * Live Mode client lifecycle (§6.3, V3-P7b): while `enabled`, hold one watch on
 * the asset, backfill the requested window and append streamed `live.frame`
 * pushes. Everything degrades silently: no provider, no socket, or a rejected
 * watch just means `streaming: false` — the caller keeps its 60 s quote-poll
 * fallback and the user never sees an error (§4.5).
 *
 * A `window` change re-issues the watch, which the server treats as
 * backfill-only — the shared upstream loop never restarts. A reconnect
 * re-issues it too (`connected` flips), because a new socket holds no watches.
 * Only unmount/disable/asset-change release the watch.
 */
export function useLiveFrames(
  assetId: string | undefined,
  window: LiveWindow,
  enabled: boolean,
): LiveFramesState {
  const { connected, on, watchLive, unwatchLive } = useRealtime();
  const [frames, setFrames] = useState<RealtimeLiveFrame[]>([]);
  const [streaming, setStreaming] = useState(false);
  const active = enabled && assetId !== undefined;

  // Clean slate whenever the target changes or live mode turns off.
  useEffect(() => {
    if (!active) {
      setFrames([]);
      setStreaming(false);
    }
  }, [active, assetId]);

  // Streamed appends. Registered before the watch below so a frame emitted
  // while the watch ack is in flight is not lost.
  useEffect(() => {
    if (!active) return;
    return on(REALTIME_SERVER_EVENTS.liveFrame, (payload) => {
      const parsed = realtimeLiveFrameSchema.safeParse(payload);
      if (!parsed.success || parsed.data.assetId !== assetId) return;
      const frame = parsed.data;
      setFrames((prev) => {
        const last = prev[prev.length - 1];
        // Frames are producer-ordered; drop replays (room emit + backfill overlap).
        return last && last.at >= frame.at ? prev : [...prev, frame];
      });
    });
  }, [active, assetId, on]);

  // Watch lifecycle: (re-)established per connection and per window.
  useEffect(() => {
    if (!enabled || assetId === undefined || !connected) {
      setStreaming(false);
      return;
    }
    let cancelled = false;
    void watchLive(assetId, window).then((backfill) => {
      if (cancelled) return;
      if (backfill === null) {
        setStreaming(false);
        return;
      }
      setStreaming(true);
      // Replace with the authoritative backfill, keeping frames that streamed
      // in while the ack was in flight (they are strictly newer).
      setFrames((prev) => {
        const merged = [...backfill];
        for (const frame of prev) {
          const last = merged[merged.length - 1];
          if (!last || frame.at > last.at) merged.push(frame);
        }
        return merged;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, assetId, window, connected, watchLive]);

  // Release the watch on unmount / disable / asset change — NOT on a window
  // switch (the loop must keep running through it).
  useEffect(() => {
    if (!enabled || assetId === undefined) return;
    const watched = assetId;
    return () => unwatchLive(watched);
  }, [enabled, assetId, unwatchLive]);

  return { frames, streaming };
}
