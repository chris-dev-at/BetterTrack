import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./socket', () => ({ createRealtimeSocket: vi.fn() }));

import { REALTIME_CLIENT_EVENTS, REALTIME_SERVER_EVENTS } from '@bettertrack/contracts';

import { RealtimeProvider, useRealtime, useRealtimeEvent } from './RealtimeProvider';
import { createRealtimeSocket } from './socket';

type Listener = (payload?: unknown) => void;

/** Minimal Socket.IO client double: listener registry + emit/disconnect log. */
class FakeSocket {
  listeners = new Map<string, Set<Listener>>();
  emitted: Array<[string, unknown]> = [];
  disconnectCalls = 0;

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

  test('quote.updated / portfolio.changed pushes invalidate the matching query caches', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderProvider(true);

    act(() =>
      fakeSocket.fire(REALTIME_SERVER_EVENTS.quoteUpdated, {
        assetId: 'asset-1',
        occurredAt: 'now',
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['asset', 'asset-1'] });

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
