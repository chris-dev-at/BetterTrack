import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Socket } from 'socket.io-client';

import {
  PRESENCE_HEARTBEAT_MS,
  REALTIME_CLIENT_EVENTS,
  REALTIME_SERVER_EVENTS,
  realtimeLiveWatchAckSchema,
  realtimePortfolioChangedSchema,
  realtimeQuoteUpdatedSchema,
  type LiveRate,
  type LiveWindow,
  type PresenceSurface,
  type RealtimeLiveFrame,
  type RealtimeRoom,
} from '@bettertrack/contracts';

import { createRealtimeSocket } from './socket';

/** The server pushes a consumer can subscribe to (contract event names). */
export type RealtimeServerEvent =
  (typeof REALTIME_SERVER_EVENTS)[keyof typeof REALTIME_SERVER_EVENTS];

/**
 * A resolved Live Mode watch (§6.3, §13.5 V5-P1): the requested window's
 * backfill (oldest first) plus the earliest instant it honestly covers
 * (`coverageFrom`, ISO), so the chart renders the full window from the first
 * frame and knows how far back the data actually reaches. `null` coverage means
 * an empty backfill.
 */
export interface LiveWatchResult {
  frames: RealtimeLiveFrame[];
  coverageFrom: string | null;
}

export interface RealtimeContextValue {
  /** True while the socket is connected — pushes are flowing. */
  connected: boolean;
  /**
   * Subscribe to a server push. Returns the unsubscribe. Handlers registered
   * while disconnected simply wait — they fire once pushes resume.
   */
  on(event: RealtimeServerEvent, handler: (payload: unknown) => void): () => void;
  /**
   * Reference-counted membership in an `asset:{id}` / `portfolio:{id}` room
   * (§4.5). Returns the leave function; the room is re-joined automatically
   * after a reconnect for as long as any reference holds it.
   */
  joinRoom(room: RealtimeRoom): () => void;
  /**
   * Start (or re-window / re-rate) a Live Mode watch on an asset (§6.3,
   * V3-P7b, #372). Resolves the requested window's backfill from the server
   * (ring buffer, history-stitched when it falls short), or `null` when the
   * stream is unavailable (disconnected, gateway down, rejected) — the caller
   * silently stays on the 60 s poll fallback. A repeat call only re-backfills
   * and re-registers this client's rate; the shared upstream loop keeps
   * running at the finest active rate.
   */
  watchLive(assetId: string, window: LiveWindow, rate: LiveRate): Promise<LiveWatchResult | null>;
  /** Release a Live Mode watch (fire-and-forget; disconnects also release it). */
  unwatchLive(assetId: string): void;
  /**
   * Declare the user actively viewing a surface (#368) — fire-and-forget; the
   * server holds it under a short TTL, so callers re-emit as a heartbeat
   * (see {@link usePresence}, which owns that lifecycle).
   */
  presenceEnter(surface: PresenceSurface, id: string): void;
  /** Clear a presence declaration (surface closed / tab blurred). */
  presenceLeave(surface: PresenceSurface, id: string): void;
}

/**
 * Default = no provider mounted (anonymous, admin app, tests): every operation
 * is a safe no-op, so consumers never need to know whether realtime exists —
 * exactly the poll-fallback guarantee of §4.5.
 */
const NOOP_CONTEXT: RealtimeContextValue = {
  connected: false,
  on: () => () => {},
  joinRoom: () => () => {},
  watchLive: () => Promise.resolve(null),
  unwatchLive: () => {},
  presenceEnter: () => {},
  presenceLeave: () => {},
};

export const RealtimeContext = createContext<RealtimeContextValue>(NOOP_CONTEXT);

export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

/**
 * Subscribe to one server push for the lifetime of the component. The handler
 * is kept in a ref so an inline closure never re-subscribes per render.
 */
export function useRealtimeEvent(
  event: RealtimeServerEvent,
  handler: (payload: unknown) => void,
): void {
  const { on } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => on(event, (payload) => handlerRef.current(payload)), [on, event]);
}

const roomKey = (room: RealtimeRoom): string => `${room.kind}:${room.id}`;

/**
 * Owns the app's single gateway socket (PROJECTPLAN.md §4.5, V3-P7a): connects
 * while `enabled` (an authenticated user-app session), tears down otherwise,
 * and fans server pushes out to `useRealtimeEvent` subscribers.
 *
 * Cache sync: pushes map to TanStack Query invalidations — `quote.updated` →
 * the asset's queries, `portfolio.changed` → that portfolio + the portfolio
 * list (cross-tab / shared-view freshness). `notification.new` is handled by
 * the bell itself, which owns the notifications query key. Every consumer keeps
 * its poll/refetch behavior untouched, so a dead socket degrades silently.
 */
export function RealtimeProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const handlersRef = useRef(new Map<string, Set<(payload: unknown) => void>>());
  const roomsRef = useRef(new Map<string, { room: RealtimeRoom; count: number }>());

  useEffect(() => {
    if (!enabled) return;
    const socket = createRealtimeSocket();
    socketRef.current = socket;

    const onConnect = () => {
      setConnected(true);
      // Room membership does not survive a reconnect — re-join everything a
      // mounted consumer still references.
      for (const { room } of roomsRef.current.values()) {
        socket.emit(REALTIME_CLIENT_EVENTS.roomJoin, { room });
      }
    };
    const onDisconnect = () => setConnected(false);
    // Silent by design: the poll fallback carries the app while we retry.
    const onConnectError = () => {};

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    const pushListeners = Object.values(REALTIME_SERVER_EVENTS).map((event) => {
      const listener = (payload: unknown) => {
        const set = handlersRef.current.get(event);
        if (!set) return;
        for (const handler of [...set]) handler(payload);
      };
      socket.on(event, listener);
      return [event, listener] as const;
    });

    return () => {
      setConnected(false);
      socketRef.current = null;
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      for (const [event, listener] of pushListeners) socket.off(event, listener);
      socket.disconnect();
    };
  }, [enabled]);

  const on = useCallback<RealtimeContextValue['on']>((event, handler) => {
    let set = handlersRef.current.get(event);
    if (!set) {
      set = new Set();
      handlersRef.current.set(event, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }, []);

  const joinRoom = useCallback<RealtimeContextValue['joinRoom']>((room) => {
    const key = roomKey(room);
    const entry = roomsRef.current.get(key) ?? { room, count: 0 };
    entry.count += 1;
    roomsRef.current.set(key, entry);
    if (entry.count === 1) {
      socketRef.current?.emit(REALTIME_CLIENT_EVENTS.roomJoin, { room });
    }
    let left = false;
    return () => {
      if (left) return;
      left = true;
      const current = roomsRef.current.get(key);
      if (!current) return;
      current.count -= 1;
      if (current.count <= 0) {
        roomsRef.current.delete(key);
        socketRef.current?.emit(REALTIME_CLIENT_EVENTS.roomLeave, { room });
      }
    };
  }, []);

  const watchLive = useCallback<RealtimeContextValue['watchLive']>(
    async (assetId, window, rate) => {
      const socket = socketRef.current;
      if (!socket?.connected) return null;
      try {
        const ack: unknown = await socket
          .timeout(5000)
          .emitWithAck(REALTIME_CLIENT_EVENTS.liveWatch, { assetId, window, rate });
        const parsed = realtimeLiveWatchAckSchema.safeParse(ack);
        if (!parsed.success || !parsed.data.ok) return null;
        return {
          frames: parsed.data.frames ?? [],
          coverageFrom: parsed.data.coverageFrom ?? null,
        };
      } catch {
        // No ack (gateway down mid-flight): silent — the poll fallback carries
        // the chart, exactly like every other push in this layer (§4.5).
        return null;
      }
    },
    [],
  );

  const unwatchLive = useCallback<RealtimeContextValue['unwatchLive']>((assetId) => {
    socketRef.current?.emit(REALTIME_CLIENT_EVENTS.liveUnwatch, { assetId });
  }, []);

  const presenceEnter = useCallback<RealtimeContextValue['presenceEnter']>((surface, id) => {
    socketRef.current?.emit(REALTIME_CLIENT_EVENTS.presenceEnter, { surface, id });
  }, []);

  const presenceLeave = useCallback<RealtimeContextValue['presenceLeave']>((surface, id) => {
    socketRef.current?.emit(REALTIME_CLIENT_EVENTS.presenceLeave, { surface, id });
  }, []);

  // Central cache sync for the pushes whose query keys are app-global.
  useEffect(() => {
    const offQuote = on(REALTIME_SERVER_EVENTS.quoteUpdated, (payload) => {
      const parsed = realtimeQuoteUpdatedSchema.safeParse(payload);
      if (!parsed.success) return;
      void queryClient.invalidateQueries({ queryKey: ['asset', parsed.data.assetId] });
    });
    const offPortfolio = on(REALTIME_SERVER_EVENTS.portfolioChanged, (payload) => {
      const parsed = realtimePortfolioChangedSchema.safeParse(payload);
      if (!parsed.success) return;
      void queryClient.invalidateQueries({ queryKey: ['portfolio', parsed.data.portfolioId] });
      void queryClient.invalidateQueries({ queryKey: ['portfolios'] });
    });
    return () => {
      offQuote();
      offPortfolio();
    };
  }, [on, queryClient]);

  const value = useMemo<RealtimeContextValue>(
    () => ({ connected, on, joinRoom, watchLive, unwatchLive, presenceEnter, presenceLeave }),
    [connected, on, joinRoom, watchLive, unwatchLive, presenceEnter, presenceLeave],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

/**
 * Declare the user actively viewing a surface while mounted, focused and
 * connected (#368 presence suppression): enters on mount/focus/reconnect,
 * re-enters every {@link PRESENCE_HEARTBEAT_MS} (the server holds a short TTL,
 * so a dropped client auto-clears), leaves on blur/hide/unmount. Pass `null`
 * to hold no claim. The server suppresses bell/email/push for a surface its
 * user is verifiably looking at — the content just lands in the open view.
 */
export function usePresence(surface: PresenceSurface, id: string | null): void {
  const { connected, presenceEnter, presenceLeave } = useRealtime();
  useEffect(() => {
    if (!id || !connected) return;
    const enter = () => {
      if (!document.hidden && document.hasFocus()) presenceEnter(surface, id);
    };
    const leave = () => presenceLeave(surface, id);
    const onVisibility = () => (document.hidden ? leave() : enter());
    enter();
    const heartbeat = setInterval(enter, PRESENCE_HEARTBEAT_MS);
    window.addEventListener('focus', enter);
    window.addEventListener('blur', leave);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(heartbeat);
      window.removeEventListener('focus', enter);
      window.removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', onVisibility);
      leave();
    };
  }, [surface, id, connected, presenceEnter, presenceLeave]);
}
