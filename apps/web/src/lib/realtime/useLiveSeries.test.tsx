import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, test, vi } from 'vitest';

import type { QuoteResponse, RealtimeLiveFrame } from '@bettertrack/contracts';

import {
  RealtimeContext,
  type LiveWatchResult,
  type RealtimeContextValue,
} from './RealtimeProvider';
import { useLiveSeries } from './useLiveSeries';

const ASSET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_ID = '00000000-0000-0000-0000-000000000002';

const frame = (at: string, price: number, assetId = ASSET_ID): RealtimeLiveFrame => ({
  assetId,
  price,
  currency: 'EUR',
  dayChangePct: null,
  at,
});

const ackOf = (frames: RealtimeLiveFrame[]): LiveWatchResult => ({
  frames,
  coverageFrom: frames[0]?.at ?? null,
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
    watchLive: vi.fn(async () => ackOf([])),
    unwatchLive: vi.fn(),
    presenceEnter: () => {},
    presenceLeave: () => {},
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

describe('useLiveSeries — merged timeline + streaming', () => {
  test('renders the full backfill window immediately, then appends streamed ticks for this asset only', async () => {
    const backfill = [
      frame('2026-07-08T10:00:00.000Z', 100),
      frame('2026-07-08T10:00:10.000Z', 101),
    ];
    const { value, push } = makeContext({ watchLive: vi.fn(async () => ackOf(backfill)) });

    const { result } = renderHook(() => useLiveSeries(ASSET_ID, '10m', '10s', true), {
      wrapper: wrapperFor(value),
    });

    await waitFor(() => expect(result.current.streaming).toBe(true));
    // Full window is present from the first frame — never an empty chart.
    expect(result.current.points.map((p) => p.value)).toEqual([100, 101]);
    expect(result.current.coverageFrom).toBe(Date.parse(backfill[0]!.at));
    const gen = result.current.generation;

    act(() => {
      push(frame('2026-07-08T10:00:20.000Z', 102));
      push(frame('2026-07-08T10:00:20.000Z', 102)); // replay: same bucket, deduped
      push(frame('2026-07-08T10:00:30.000Z', 999, OTHER_ID)); // other asset: ignored
      push({ garbage: true }); // malformed: ignored
    });
    expect(result.current.points.map((p) => p.value)).toEqual([100, 101, 102]);
    // A tail append never rebuilds — the generation is stable within a stream.
    expect(result.current.generation).toBe(gen);
  });

  test('output is always strictly increasing across a mixed-density stream', async () => {
    const backfill = [
      frame('2026-07-08T10:00:00.000Z', 100), // minute-granularity seed
      frame('2026-07-08T10:01:00.000Z', 101),
    ];
    const { value, push } = makeContext({ watchLive: vi.fn(async () => ackOf(backfill)) });
    const { result } = renderHook(() => useLiveSeries(ASSET_ID, '30m', '1s', true), {
      wrapper: wrapperFor(value),
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));

    act(() => {
      // Second-granularity live ticks after the minute seeds.
      push(frame('2026-07-08T10:01:37.000Z', 102));
      push(frame('2026-07-08T10:01:38.000Z', 103));
    });
    const times = result.current.points.map((p) => p.time);
    expect(times.every((t, i) => i === 0 || t > times[i - 1]!)).toBe(true);
  });

  test('a window switch is exactly ONE clean rebuild (generation bump) without releasing the loop', async () => {
    const watchLive = vi.fn(async () => ackOf([frame('2026-07-08T10:00:00.000Z', 100)]));
    const unwatchLive = vi.fn();
    const { value } = makeContext({ watchLive, unwatchLive });

    const { result, rerender } = renderHook(
      ({ window }: { window: '1m' | '12h' }) => useLiveSeries(ASSET_ID, window, '10s', true),
      { wrapper: wrapperFor(value), initialProps: { window: '1m' } as { window: '1m' | '12h' } },
    );
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '1m', '10s'));
    await waitFor(() => expect(result.current.generation).toBeGreaterThan(0));
    const genBefore = result.current.generation;

    rerender({ window: '12h' });
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '12h', '10s'));
    await waitFor(() => expect(result.current.generation).toBe(genBefore + 1));
    expect(unwatchLive).not.toHaveBeenCalled(); // the loop must survive the switch
  });

  test('a rate switch is exactly ONE clean rebuild without releasing the loop (#372)', async () => {
    const watchLive = vi.fn(async () => ackOf([frame('2026-07-08T10:00:00.000Z', 100)]));
    const unwatchLive = vi.fn();
    const { value } = makeContext({ watchLive, unwatchLive });

    const { result, rerender } = renderHook(
      ({ rate }: { rate: '1s' | '10s' }) => useLiveSeries(ASSET_ID, '10m', rate, true),
      { wrapper: wrapperFor(value), initialProps: { rate: '10s' } as { rate: '1s' | '10s' } },
    );
    await waitFor(() => expect(result.current.generation).toBeGreaterThan(0));
    const genBefore = result.current.generation;

    rerender({ rate: '1s' });
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '10m', '1s'));
    await waitFor(() => expect(result.current.generation).toBe(genBefore + 1));
    expect(unwatchLive).not.toHaveBeenCalled();
  });

  test('unmount releases the watch exactly once', async () => {
    const watchLive = vi.fn(async () => ackOf([]));
    const unwatchLive = vi.fn();
    const { value } = makeContext({ watchLive, unwatchLive });

    const { unmount } = renderHook(() => useLiveSeries(ASSET_ID, '1m', '10s', true), {
      wrapper: wrapperFor(value),
    });
    await waitFor(() => expect(watchLive).toHaveBeenCalled());
    unmount();
    expect(unwatchLive).toHaveBeenCalledTimes(1);
    expect(unwatchLive).toHaveBeenCalledWith(ASSET_ID);
  });

  test('unavailable stream (rejected watch) ⇒ streaming:false and no points — silent fallback', async () => {
    const watchLive = vi.fn(async () => null);
    const { value } = makeContext({ watchLive });

    const { result } = renderHook(() => useLiveSeries(ASSET_ID, '1m', '10s', true), {
      wrapper: wrapperFor(value),
    });

    await waitFor(() => expect(watchLive).toHaveBeenCalled());
    expect(result.current.streaming).toBe(false);
    expect(result.current.points).toEqual([]);
  });

  test('disabled: never watches, resets state', () => {
    const watchLive = vi.fn(async () => ackOf([]));
    const { value } = makeContext({ watchLive });

    const { result } = renderHook(() => useLiveSeries(ASSET_ID, '10m', '10s', false), {
      wrapper: wrapperFor(value),
    });
    expect(watchLive).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ points: [], streaming: false, coverageFrom: null });
  });

  test('hiding the tab releases the watch (presence gating); showing re-establishes it (#372)', async () => {
    const watchLive = vi.fn(async () => ackOf([]));
    const unwatchLive = vi.fn();
    const { value } = makeContext({ watchLive, unwatchLive });

    const setVisibility = (state: 'visible' | 'hidden') => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };

    try {
      const { result } = renderHook(() => useLiveSeries(ASSET_ID, '10m', '10s', true), {
        wrapper: wrapperFor(value),
      });
      await waitFor(() => expect(result.current.streaming).toBe(true));
      expect(unwatchLive).not.toHaveBeenCalled();

      act(() => setVisibility('hidden'));
      expect(unwatchLive).toHaveBeenCalledTimes(1);
      expect(unwatchLive).toHaveBeenCalledWith(ASSET_ID);
      expect(result.current.streaming).toBe(false);

      watchLive.mockClear();
      act(() => setVisibility('visible'));
      await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '10m', '10s'));
      await waitFor(() => expect(result.current.streaming).toBe(true));
    } finally {
      setVisibility('visible');
    }
  });

  test('while disconnected it waits; a reconnect re-establishes the watch (one rebuild)', async () => {
    const watchLive = vi.fn(async () => ackOf([]));
    const disconnected = makeContext({ connected: false, watchLive });

    const { result, rerender } = renderHook(() => useLiveSeries(ASSET_ID, '10m', '10s', true), {
      wrapper: wrapperFor(disconnected.value),
    });
    expect(watchLive).not.toHaveBeenCalled();
    expect(result.current.streaming).toBe(false);

    disconnected.value.connected = true;
    rerender();
    await waitFor(() => expect(watchLive).toHaveBeenCalledWith(ASSET_ID, '10m', '10s'));
  });
});

describe('useLiveSeries — poll fallback (§4.5)', () => {
  const quoteResponse = (price: number, at: string): QuoteResponse => ({
    quote: { price, currency: 'EUR', dayChangePct: null, asOf: at },
    stale: false,
    asOf: at,
  });

  test('feeds the series from the 60 s quote when the socket is unavailable, one rebuild on entry', async () => {
    const watchLive = vi.fn(async () => null); // no socket
    const { value } = makeContext({ watchLive });

    const { result, rerender } = renderHook(
      ({ quote }: { quote: QuoteResponse }) => useLiveSeries(ASSET_ID, '10m', '10s', true, quote),
      {
        wrapper: wrapperFor(value),
        initialProps: { quote: quoteResponse(100, '2026-07-08T10:00:00.000Z') },
      },
    );

    await waitFor(() => expect(result.current.points.map((p) => p.value)).toEqual([100]));
    expect(result.current.streaming).toBe(false);
    const gen = result.current.generation;

    // A later poll appends without another rebuild.
    rerender({ quote: quoteResponse(101, '2026-07-08T10:01:00.000Z') });
    await waitFor(() => expect(result.current.points.map((p) => p.value)).toEqual([100, 101]));
    expect(result.current.generation).toBe(gen);
  });
});
