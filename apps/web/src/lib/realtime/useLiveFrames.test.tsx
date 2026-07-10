import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import type { RealtimeLiveFrame } from '@bettertrack/contracts';

import { RealtimeContext, type RealtimeContextValue } from './RealtimeProvider';
import { useLiveFrames } from './useLiveFrames';

const ASSET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ID = '00000000-0000-0000-0000-000000000002';

const frame = (at: string, price: number, assetId = ASSET_ID): RealtimeLiveFrame => ({
  assetId,
  price,
  currency: 'EUR',
  dayChangePct: null,
  at,
});

/** A controllable context double: capture handlers, script the watch ack. */
function makeContext(overrides: Partial<RealtimeContextValue> = {}) {
  const handlers = new Set<(payload: unknown) => void>();
  const value: RealtimeContextValue = {
    connected: true,
    on: (_event, handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    joinRoom: () => () => {},
    watchLive: vi.fn(async () => [] as RealtimeLiveFrame[]),
    unwatchLive: vi.fn(),
    ...overrides,
  };
  const push = (payload: unknown) => {
    for (const handler of [...handlers]) handler(payload);
  };
  return { value, push };
}

function wrapperFor(value: RealtimeContextValue) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
  };
}

describe('useLiveFrames', () => {
  test('backfills from the watch ack, then appends streamed frames for this asset only', async () => {
    const backfill = [
      frame('2026-07-08T10:00:00.000Z', 100),
      frame('2026-07-08T10:00:10.000Z', 101),
    ];
    const { value, push } = makeContext({ watchLive: vi.fn(async () => backfill) });

    const { result } = renderHook(() => useLiveFrames(ASSET_ID, '10m', '10s', true), {
      wrapper: wrapperFor(value),
    });

    await waitFor(() => expect(result.current.streaming).toBe(true));
    expect(result.current.frames.map((f) => f.price)).toEqual([100, 101]);

    act(() => {
      push(frame('2026-07-08T10:00:20.000Z', 102));
      push(frame('2026-07-08T10:00:20.000Z', 102)); // replay: deduped
      push(frame('2026-07-08T10:00:30.000Z', 999, OTHER_ID)); // other asset: ignored
      push({ garbage: true }); // malformed: ignored
    });
    expect(result.current.frames.map((f) => f.price)).toEqual([100, 101, 102]);
  });

  test('unavailable stream (noop/rejected watch) means streaming:false and no frames — silent fallback', async () => {
    const watchLive = vi.fn(async () => null);
    const { value } = makeContext({ watchLive });

    const { result } = renderHook(() => useLiveFrames(ASSET_ID, '1m', '10s', true), {
      wrapper: wrapperFor(value),
    });

    await waitFor(() => expect(watchLive).toHaveBeenCalled());
    expect(result.current.streaming).toBe(false);
    expect(result.current.frames).toEqual([]);
  });

  test('a window switch re-watches without releasing; unmount releases exactly once', async () => {
    const watchLive = vi.fn(async () => [] as RealtimeLiveFrame[]);
    const unwatchLive = vi.fn();
    const { value } = makeContext({ watchLive, unwatchLive });

    const { rerender, unmount } = renderHook(
      ({ window }: { window: '1m' | '12h' }) => useLiveFrames(ASSET_ID, window, '10s', true),
      { wrapper: wrapperFor(value), initialProps: { window: '1m' } as { window: '1m' | '12h' } },
    );
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '1m', '10s'));

    rerender({ window: '12h' as const });
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '12h', '10s'));
    expect(unwatchLive).not.toHaveBeenCalled(); // the loop must survive the switch

    unmount();
    expect(unwatchLive).toHaveBeenCalledTimes(1);
    expect(unwatchLive).toHaveBeenCalledWith(ASSET_ID);
  });

  test('disabled: never watches, resets state', async () => {
    const watchLive = vi.fn(async () => [] as RealtimeLiveFrame[]);
    const { value } = makeContext({ watchLive });

    const { result } = renderHook(() => useLiveFrames(ASSET_ID, '10m', '10s', false), {
      wrapper: wrapperFor(value),
    });
    expect(watchLive).not.toHaveBeenCalled();
    expect(result.current).toEqual({ frames: [], streaming: false });
  });

  test('a coarser viewer downsamples a finer shared stream to its own rate (#372)', async () => {
    // The shared loop runs at some finer viewer's 1 s; this viewer asked for
    // 10 s — it keeps the first frame of each of its own 10 s buckets.
    const backfill = [
      frame('2026-07-08T10:00:00.000Z', 100),
      frame('2026-07-08T10:00:01.000Z', 101), // same 10 s bucket: dropped
      frame('2026-07-08T10:00:11.000Z', 102),
    ];
    const { value, push } = makeContext({ watchLive: vi.fn(async () => backfill) });

    const { result } = renderHook(() => useLiveFrames(ASSET_ID, '10m', '10s', true), {
      wrapper: wrapperFor(value),
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    expect(result.current.frames.map((f) => f.price)).toEqual([100, 102]);

    act(() => {
      push(frame('2026-07-08T10:00:12.000Z', 103)); // still bucket of 102: dropped
      push(frame('2026-07-08T10:00:21.000Z', 104)); // next bucket: kept
      push(frame('2026-07-08T10:00:22.000Z', 105)); // same bucket: dropped
    });
    expect(result.current.frames.map((f) => f.price)).toEqual([100, 102, 104]);
  });

  test('a rate switch re-watches at the new rate without releasing (#372)', async () => {
    const watchLive = vi.fn(async () => [] as RealtimeLiveFrame[]);
    const unwatchLive = vi.fn();
    const { value } = makeContext({ watchLive, unwatchLive });

    const { rerender } = renderHook(
      ({ rate }: { rate: '1s' | '10s' }) => useLiveFrames(ASSET_ID, '10m', rate, true),
      { wrapper: wrapperFor(value), initialProps: { rate: '10s' } as { rate: '1s' | '10s' } },
    );
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '10m', '10s'));

    rerender({ rate: '1s' as const });
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '10m', '1s'));
    expect(unwatchLive).not.toHaveBeenCalled(); // the shared loop survives the switch
  });

  test('hiding the tab releases the watch (presence gating); showing re-establishes it (#372)', async () => {
    const watchLive = vi.fn(async () => [] as RealtimeLiveFrame[]);
    const unwatchLive = vi.fn();
    const { value } = makeContext({ watchLive, unwatchLive });

    const setVisibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    try {
      const { result } = renderHook(() => useLiveFrames(ASSET_ID, '10m', '10s', true), {
        wrapper: wrapperFor(value),
      });
      await waitFor(() => expect(result.current.streaming).toBe(true));
      expect(unwatchLive).not.toHaveBeenCalled();

      // Nobody is looking: the watch is released so the shared upstream loop
      // can go cold — polling is presence-gated.
      act(() => setVisibility('hidden'));
      expect(unwatchLive).toHaveBeenCalledTimes(1);
      expect(unwatchLive).toHaveBeenCalledWith(ASSET_ID);
      expect(result.current.streaming).toBe(false);

      // Back to the tab: watch + backfill resume without a remount.
      watchLive.mockClear();
      act(() => setVisibility('visible'));
      await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '10m', '10s'));
      await waitFor(() => expect(result.current.streaming).toBe(true));
    } finally {
      setVisibility('visible');
    }
  });

  test('while disconnected it waits; a reconnect re-establishes the watch', async () => {
    const watchLive = vi.fn(async () => [] as RealtimeLiveFrame[]);
    const disconnected = makeContext({ connected: false, watchLive });

    const { result, rerender } = renderHook(() => useLiveFrames(ASSET_ID, '10m', '10s', true), {
      wrapper: wrapperFor(disconnected.value),
    });
    expect(watchLive).not.toHaveBeenCalled();
    expect(result.current.streaming).toBe(false);

    // The socket comes (back) up: same context surface, connected flips true.
    disconnected.value.connected = true;
    rerender();
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '10m', '10s'));
  });
});
