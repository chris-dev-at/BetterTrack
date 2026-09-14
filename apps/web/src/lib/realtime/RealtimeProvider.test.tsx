import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Only the factory is stubbed: the reconnect ladder is real, so this suite
// exercises the delays the app actually schedules.
vi.mock('./socket', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./socket')>()),
  createRealtimeSocket: vi.fn(),
}));

import { REALTIME_CLIENT_EVENTS, REALTIME_SERVER_EVENTS } from '@bettertrack/contracts';

import { workboardQuotesQueryKey, workboardSparklinesQueryKey } from '../assetApi';

import { RealtimeProvider, useRealtime, useRealtimeEvent } from './RealtimeProvider';
import {
  createRealtimeSocket,
  REALTIME_RECONNECT_BASE_MS,
  REALTIME_RECONNECT_MAX_MS,
} from './socket';

type Listener = (payload?: unknown) => void;

/** Minimal Socket.IO client double: listener registry + emit/disconnect log. */
class FakeSocket {
  listeners = new Map<string, Set<Listener>>();
  emitted: Array<[string, unknown]> = [];
  disconnectCalls = 0;
  connectCalls = 0;
  /** Socket.IO's own "I will reconnect" flag — false once it has given up. */
  active = true;
  connected = false;

  connect() {
    this.connectCalls += 1;
    return this;
  }

  on(event: string, fn: Listener) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return this;
  }

  off(event: string, fn: Listener) {
    this.listeners.get(event)?.delete(fn);
    return this;
  }

  emit(event: string, payload: unknown) {
    this.emitted.push([event, payload]);
    return this;
  }

  disconnect() {
    this.disconnectCalls += 1;
    return this;
  }

  /** Test-side: simulate a frame arriving from the server. */
  fire(event: string, payload?: unknown) {
    for (const fn of [...(this.listeners.get(event) ?? [])]) fn(payload);
  }
}

let fakeSocket: FakeSocket;
let queryClient: QueryClient;

beforeEach(() => {
  vi.clearAllMocks();
  fakeSocket = new FakeSocket();
  vi.mocked(createRealtimeSocket).mockReturnValue(fakeSocket as never);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function ConnectionProbe() {
  const { connected } = useRealtime();
  return <span data-testid="conn">{connected ? 'connected' : 'disconnected'}</span>;
}

function renderProvider(enabled: boolean, children?: React.ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider enabled={enabled}>
        <ConnectionProbe />
        {children}
      </RealtimeProvider>
    </QueryClientProvider>,
  );
}

describe('RealtimeProvider', () => {
  test('creates no socket while disabled (anonymous / logged out)', () => {
    renderProvider(false);
    expect(createRealtimeSocket).not.toHaveBeenCalled();
    expect(screen.getByTestId('conn')).toHaveTextContent('disconnected');
  });

  test('connects when enabled and tracks connection state across connect/disconnect', () => {
    renderProvider(true);
    expect(createRealtimeSocket).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('conn')).toHaveTextContent('disconnected');

    act(() => fakeSocket.fire('connect'));
    expect(screen.getByTestId('conn')).toHaveTextContent('connected');

    act(() => fakeSocket.fire('disconnect'));
    expect(screen.getByTestId('conn')).toHaveTextContent('disconnected');
  });

  test('a connect_error is swallowed — the poll fallback carries the app', () => {
    renderProvider(true);
    expect(() => act(() => fakeSocket.fire('connect_error', new Error('down')))).not.toThrow();
    expect(screen.getByTestId('conn')).toHaveTextContent('disconnected');
  });

  test('a server-initiated disconnect is retried, not left down for the page session', () => {
    // A Redis blip makes the gateway's admission heartbeat reject and close every
    // socket. Socket.IO treats a server `disconnect(true)` as terminal (`active`
    // goes false), so without a manual ladder this tab polls until a reload.
    vi.useFakeTimers();
    try {
      renderProvider(true);
      act(() => fakeSocket.fire('connect'));
      act(() => {
        fakeSocket.active = false;
        fakeSocket.fire('disconnect', 'io server disconnect');
      });

      // Consumers see `connected: false` and stay on their polls meanwhile (§4.5).
      expect(screen.getByTestId('conn')).toHaveTextContent('disconnected');
      // Backed off, not immediate: no reconnect inside the first rung's floor.
      act(() => void vi.advanceTimersByTime(700));
      expect(fakeSocket.connectCalls).toBe(0);

      act(() => void vi.advanceTimersByTime(REALTIME_RECONNECT_MAX_MS));
      expect(fakeSocket.connectCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a connect_error refusal retries on a capped backoff — one attempt per rung, never a storm', () => {
    vi.useFakeTimers();
    try {
      renderProvider(true);
      // A namespace-level refusal (flag off, USER_CONNECTION_LIMIT, UNAVAILABLE):
      // Socket.IO stops reconnecting for good.
      act(() => {
        fakeSocket.active = false;
        fakeSocket.fire('connect_error', new Error('USER_CONNECTION_LIMIT'));
      });
      expect(screen.getByTestId('conn')).toHaveTextContent('disconnected');
      expect(fakeSocket.connectCalls).toBe(0);

      act(() => void vi.advanceTimersByTime(REALTIME_RECONNECT_MAX_MS));
      expect(fakeSocket.connectCalls).toBe(1);

      // Still refused → the next rung is further out, and only ONE attempt is
      // ever pending, so a persistently refusing gateway cannot be stormed.
      act(() => fakeSocket.fire('connect_error', new Error('USER_CONNECTION_LIMIT')));
      act(() => void vi.advanceTimersByTime(REALTIME_RECONNECT_BASE_MS));
      expect(fakeSocket.connectCalls).toBe(1);
      act(() => void vi.advanceTimersByTime(REALTIME_RECONNECT_MAX_MS));
      expect(fakeSocket.connectCalls).toBe(2);

      // Recovery resets the ladder and unmounting cancels the pending attempt.
      act(() => {
        fakeSocket.active = true;
        fakeSocket.fire('connect');
      });
      expect(screen.getByTestId('conn')).toHaveTextContent('connected');
      act(() => void vi.advanceTimersByTime(5 * REALTIME_RECONNECT_MAX_MS));
      expect(fakeSocket.connectCalls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('while Socket.IO is still retrying itself the provider stays out of the way', () => {
    vi.useFakeTimers();
    try {
      renderProvider(true);
      // A transport blip: `active` holds, so the manager owns the backoff.
      act(() => fakeSocket.fire('disconnect', 'transport close'));
      act(() => void vi.advanceTimersByTime(5 * REALTIME_RECONNECT_MAX_MS));
      expect(fakeSocket.connectCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('feature.disabled records the shed feature; a fresh connect clears it', () => {
    function ShedProbe() {
      const { featureDisabled } = useRealtime();
      return (
        <span data-testid="shed">
          {featureDisabled.liveMode ? 'liveMode' : ''}
          {featureDisabled.realtime ? 'realtime' : ''}
          {!featureDisabled.liveMode && !featureDisabled.realtime ? 'none' : ''}
        </span>
      );
    }
    renderProvider(true, <ShedProbe />);
    act(() => fakeSocket.fire('connect'));
    expect(screen.getByTestId('shed')).toHaveTextContent('none');

    // The `liveMode` kill switch sheds this socket's watches and LEAVES IT UP —
    // `connected` alone can never tell a consumer its pushes stopped.
    act(() => fakeSocket.fire(REALTIME_SERVER_EVENTS.featureDisabled, { feature: 'liveMode' }));
    expect(screen.getByTestId('shed')).toHaveTextContent('liveMode');
    expect(screen.getByTestId('conn')).toHaveTextContent('connected');

    act(() => fakeSocket.fire(REALTIME_SERVER_EVENTS.featureDisabled, { feature: 'nope' }));
    expect(screen.getByTestId('shed')).toHaveTextContent('liveMode');

    // A fresh handshake supersedes it — the next watch ack is the authority.
    act(() => fakeSocket.fire('connect'));
    expect(screen.getByTestId('shed')).toHaveTextContent('none');
  });

  test('disconnects the socket on unmount', () => {
    const { unmount } = renderProvider(true);
    unmount();
    expect(fakeSocket.disconnectCalls).toBe(1);
  });

  test('useRealtimeEvent handlers receive server pushes', () => {
    const received: unknown[] = [];
    function Subscriber() {
      useRealtimeEvent(REALTIME_SERVER_EVENTS.notificationNew, (payload) => received.push(payload));
      return null;
    }
    renderProvider(true, <Subscriber />);

    const push = { notificationId: '018f6f00-0000-7000-8000-000000000001', occurredAt: 'now' };
    act(() => fakeSocket.fire(REALTIME_SERVER_EVENTS.notificationNew, push));
    expect(received).toEqual([push]);
  });

  test('quote.updated invalidates only the matching quote cache; portfolio.changed keeps its caches', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const quoteKey = ['asset', 'asset-1', 'quote'];
    const historyKey = ['asset', 'asset-1', 'history', '1Y'];
    queryClient.setQueryData(quoteKey, { price: 100 });
    queryClient.setQueryData(historyKey, { points: [] });
    renderProvider(true);

    act(() =>
      fakeSocket.fire(REALTIME_SERVER_EVENTS.quoteUpdated, {
        assetId: 'asset-1',
        occurredAt: 'now',
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: quoteKey });
    expect(queryClient.getQueryState(quoteKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(historyKey)?.isInvalidated).toBe(false);

    const portfolioId = '018f6f00-0000-7000-8000-000000000002';
    act(() =>
      fakeSocket.fire(REALTIME_SERVER_EVENTS.portfolioChanged, {
        portfolioId,
        occurredAt: 'now',
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['portfolio', portfolioId] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['portfolios'] });
  });

  test('a quote push reaches the watchlist batch holding that asset, and only that one', () => {
    // The watchlist reads its quotes as one batch whose key carries the id
    // list, so the ['asset', id] prefix cannot reach it. The predicate that
    // closes the gap must stay as narrow as the per-row keys it replaced.
    const watching = workboardQuotesQueryKey(['asset-1', 'asset-2']);
    const unrelated = workboardQuotesQueryKey(['asset-9']);
    const sparklines = workboardSparklinesQueryKey(['asset-1', 'asset-2']);
    queryClient.setQueryData(watching, { quotes: [], failed: [] });
    queryClient.setQueryData(unrelated, { quotes: [], failed: [] });
    queryClient.setQueryData(sparklines, { sparklines: [], failed: [] });
    renderProvider(true);

    act(() =>
      fakeSocket.fire(REALTIME_SERVER_EVENTS.quoteUpdated, {
        assetId: 'asset-1',
        occurredAt: 'now',
      }),
    );

    expect(queryClient.getQueryState(watching)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(unrelated)?.isInvalidated).toBe(false);
    // A moved quote says nothing new about the daily sparkline candles.
    expect(queryClient.getQueryState(sparklines)?.isInvalidated).toBe(false);
  });

  test('a malformed push invalidates nothing', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderProvider(true);
    act(() => fakeSocket.fire(REALTIME_SERVER_EVENTS.quoteUpdated, { nope: true }));
    expect(invalidate).not.toHaveBeenCalled();
  });

  test('joinRoom is reference-counted and rooms are (re-)joined on connect', () => {
    const room = { kind: 'asset', id: '018f6f00-0000-7000-8000-000000000003' } as const;
    let leaveFirst: (() => void) | undefined;
    let leaveSecond: (() => void) | undefined;
    function Joiner() {
      const { joinRoom } = useRealtime();
      // Two independent references to the same room (e.g. chart + header).
      if (!leaveFirst) leaveFirst = joinRoom(room);
      if (!leaveSecond) leaveSecond = joinRoom(room);
      return null;
    }
    renderProvider(true, <Joiner />);

    const joins = () =>
      fakeSocket.emitted.filter(([event]) => event === REALTIME_CLIENT_EVENTS.roomJoin);
    const leaves = () =>
      fakeSocket.emitted.filter(([event]) => event === REALTIME_CLIENT_EVENTS.roomLeave);

    // Membership is sent at connect time: ONE join frame despite two references.
    act(() => fakeSocket.fire('connect'));
    expect(joins()).toEqual([[REALTIME_CLIENT_EVENTS.roomJoin, { room }]]);

    // Rooms don't survive a reconnect — the provider re-joins referenced rooms.
    act(() => fakeSocket.fire('connect'));
    expect(joins()).toHaveLength(2);

    // The leave frame goes out only when the LAST reference releases.
    act(() => leaveFirst!());
    expect(leaves()).toHaveLength(0);
    act(() => leaveSecond!());
    expect(leaves()).toEqual([[REALTIME_CLIENT_EVENTS.roomLeave, { room }]]);
  });

  test('joinRoom on an already-connected socket sends the join frame immediately', () => {
    const room = { kind: 'portfolio', id: '018f6f00-0000-7000-8000-000000000004' } as const;
    let leave: (() => void) | undefined;
    function LateJoiner() {
      const { joinRoom } = useRealtime();
      if (!leave) leave = joinRoom(room);
      return null;
    }
    const tree = (children?: React.ReactNode) => (
      <QueryClientProvider client={queryClient}>
        <RealtimeProvider enabled>{children}</RealtimeProvider>
      </QueryClientProvider>
    );
    const view = render(tree());
    act(() => fakeSocket.fire('connect'));

    // A consumer mounting AFTER the socket is live (e.g. navigating to an asset
    // page) emits its join right away rather than waiting for a reconnect.
    view.rerender(tree(<LateJoiner />));
    expect(
      fakeSocket.emitted.filter(([event]) => event === REALTIME_CLIENT_EVENTS.roomJoin),
    ).toContainEqual([REALTIME_CLIENT_EVENTS.roomJoin, { room }]);
  });
});
