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

  test('a working socket + a resolved quote enters in ONE generation (no fallback flash)', async () => {
    const backfill = [
      frame('2026-07-08T10:00:00.000Z', 100),
      frame('2026-07-08T10:00:10.000Z', 101),
    ];
    const { value } = makeContext({ watchLive: vi.fn(async () => ackOf(backfill)) });
    const quote: QuoteResponse = {
      quote: { price: 99, currency: 'EUR', dayChangePct: null, asOf: '2026-07-08T09:59:00.000Z' },
      stale: false,
      asOf: '2026-07-08T09:59:00.000Z',
    };

    const { result } = renderHook(() => useLiveSeries(ASSET_ID, '10m', '10s', true, quote), {
      wrapper: wrapperFor(value),
    });

    await waitFor(() => expect(result.current.streaming).toBe(true));
    // The backfill is the FIRST and only content: the pre-watch fallback quote
    // (99) never seeded a throwaway generation 1 ahead of it while the watch was
    // in flight — exactly one clean rebuild.
    expect(result.current.points.map((p) => p.value)).toEqual([100, 101]);
    expect(result.current.generation).toBe(1);
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

  test('closed-market frames flip the badge but never append as fake flat ticks (Part A)', async () => {
    const backfill = [
      frame('2026-07-08T10:00:00.000Z', 100),
      frame('2026-07-08T10:01:00.000Z', 101),
    ];
    const { value, push } = makeContext({ watchLive: vi.fn(async () => ackOf(backfill)) });
    const { result } = renderHook(() => useLiveSeries(ASSET_ID, '30m', '1s', true), {
      wrapper: wrapperFor(value),
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    const gen = result.current.generation;
    const chartBefore = result.current.chartPoints;
    const lastBefore = chartBefore[chartBefore.length - 1]!;

    act(() => {
      // The market closes: the loop keeps re-serving the last close, stamped now.
      push({ ...frame('2026-07-08T10:05:00.000Z', 101), marketState: 'closed' });
      push({ ...frame('2026-07-08T10:06:00.000Z', 101), marketState: 'closed' });
    });

    // The badge flips closed…
    expect(result.current.marketState).toBe('closed');
    // …but not one flat tick was appended: the series is still the real seed, so
    // the pinned viewport frames the past window instead of an all-flat line.
    expect(result.current.points.map((p) => p.value)).toEqual([100, 101]);
    const chartAfter = result.current.chartPoints;
    expect(chartAfter[chartAfter.length - 1]).toEqual(lastBefore); // no growth past 10:01
    expect(result.current.generation).toBe(gen); // still one clean generation

    // A real session resuming (open/pre/post move prices) appends as normal — the
    // filter is closed-only, never "freeze forever".
    act(() => {
      push({ ...frame('2026-07-08T10:07:00.000Z', 105), marketState: 'open' });
    });
    expect(result.current.points.map((p) => p.value)).toEqual([100, 101, 105]);
    expect(result.current.marketState).toBe('open');
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

  test('a closed-market fallback quote flips the badge but seeds no flat tick (Part A)', async () => {
    const watchLive = vi.fn(async () => null); // no socket → poll fallback
    const { value } = makeContext({ watchLive });
    const closed: QuoteResponse = {
      quote: {
        price: 100,
        currency: 'EUR',
        dayChangePct: null,
        marketState: 'closed',
        asOf: '2026-07-08T10:00:00.000Z',
      },
      stale: false,
      asOf: '2026-07-08T10:00:00.000Z',
    };

    const { result } = renderHook(() => useLiveSeries(ASSET_ID, '10m', '10s', true, closed), {
      wrapper: wrapperFor(value),
    });

    await waitFor(() => expect(result.current.marketState).toBe('closed'));
    // No socket ⇒ no backfill; a closed quote must not fabricate a lone flat
    // point — the chart shows the empty "waiting" state + the closed chip.
    expect(result.current.points).toEqual([]);
    expect(result.current.streaming).toBe(false);
  });
});

describe('useLiveSeries — chart grid (densify, issue #690 symptom 3)', () => {
  test('chartPoints resample the mixed-density series to ONE grid; points stays honest', async () => {
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
      push(frame('2026-07-08T10:01:37.000Z', 102)); // 1 s live ticks after the seed
      push(frame('2026-07-08T10:01:38.000Z', 103));
    });

    // points: the four REAL observations, untouched (the honest source).
    expect(result.current.points.map((p) => p.value)).toEqual([100, 101, 102, 103]);

    // chartPoints: one uniform 1 s grid from the first seed to the newest tick, so
    // the minute seed can't be crushed to its point-count share by the dense tail.
    const chart = result.current.chartPoints;
    const t0 = Math.floor(Date.parse('2026-07-08T10:00:00.000Z') / 1000);
    const tEnd = Math.floor(Date.parse('2026-07-08T10:01:38.000Z') / 1000);
    expect(chart[0]!.time).toBe(t0);
    expect(chart[chart.length - 1]).toEqual({ time: tEnd, value: 103 });
    expect(chart).toHaveLength(tEnd - t0 + 1); // one point per second — uniform
    expect(chart.every((p, i) => i === 0 || p.time - chart[i - 1]!.time === 1)).toBe(true);
    // The 30 s inside the first minute carry the seed's 100 (a stepped hold).
    expect(chart.find((p) => p.time === t0 + 30)!.value).toBe(100);
  });

  test('a long window coarsens the chart grid to stay under the point cap', async () => {
    const backfill = [
      frame('2026-07-08T10:00:00.000Z', 100),
      frame('2026-07-08T10:02:00.000Z', 101),
    ];
    const { value } = makeContext({ watchLive: vi.fn(async () => ackOf(backfill)) });
    const { result } = renderHook(() => useLiveSeries(ASSET_ID, '12h', '1s', true), {
      wrapper: wrapperFor(value),
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));

    // 12 h @ 1 s would be 43 200 points; the grid coarsens to a uniform 12 s.
    const chart = result.current.chartPoints;
    expect(chart.length).toBeGreaterThan(1);
    expect(chart.every((p, i) => i === 0 || p.time - chart[i - 1]!.time === 12)).toBe(true);
  });
});
