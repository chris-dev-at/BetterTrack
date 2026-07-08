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

    const { result } = renderHook(() => useLiveFrames(ASSET_ID, '10m', true), {
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

    const { result } = renderHook(() => useLiveFrames(ASSET_ID, '1m', true), {
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
      ({ window }: { window: '1m' | '12h' }) => useLiveFrames(ASSET_ID, window, true),
      { wrapper: wrapperFor(value), initialProps: { window: '1m' } as { window: '1m' | '12h' } },
    );
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '1m'));

    rerender({ window: '12h' as const });
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '12h'));
    expect(unwatchLive).not.toHaveBeenCalled(); // the loop must survive the switch

    unmount();
    expect(unwatchLive).toHaveBeenCalledTimes(1);
    expect(unwatchLive).toHaveBeenCalledWith(ASSET_ID);
  });

  test('disabled: never watches, resets state', async () => {
    const watchLive = vi.fn(async () => [] as RealtimeLiveFrame[]);
    const { value } = makeContext({ watchLive });

    const { result } = renderHook(() => useLiveFrames(ASSET_ID, '10m', false), {
      wrapper: wrapperFor(value),
    });
    expect(watchLive).not.toHaveBeenCalled();
    expect(result.current).toEqual({ frames: [], streaming: false });
  });

  test('while disconnected it waits; a reconnect re-establishes the watch', async () => {
    const watchLive = vi.fn(async () => [] as RealtimeLiveFrame[]);
    const disconnected = makeContext({ connected: false, watchLive });

    const { result, rerender } = renderHook(() => useLiveFrames(ASSET_ID, '10m', true), {
      wrapper: wrapperFor(disconnected.value),
    });
    expect(watchLive).not.toHaveBeenCalled();
    expect(result.current.streaming).toBe(false);

    // The socket comes (back) up: same context surface, connected flips true.
    disconnected.value.connected = true;
    rerender();
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '10m'));
  });
});
