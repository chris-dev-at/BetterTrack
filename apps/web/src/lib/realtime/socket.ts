import { io, type Socket } from 'socket.io-client';

import { REALTIME_PATH } from '@bettertrack/contracts';

import { getRuntimeConfig } from '../runtimeConfig';

/**
 * The realtime gateway socket (PROJECTPLAN.md §4.5, V3-P7a): Socket.IO against
 * the API origin at /ws, carrying the session cookie on handshake.
 *
 * The gateway is a pure enhancement layer — everything the socket delivers is
 * also covered by TanStack Query's poll/refetch fallback. So connection
 * problems (flag off, gateway down, network blip) must be invisible: reconnect
 * forever with a capped backoff and never surface an error to the user.
 */
export function createRealtimeSocket(): Socket {
  const { apiOrigin } = getRuntimeConfig();
  const options = {
    path: REALTIME_PATH,
    withCredentials: true,
    reconnectionDelayMax: 60_000,
  };
  if (apiOrigin) return io(apiOrigin, options);

  // A browser omits Origin from a same-origin polling GET, while the gateway's
  // native/no-Origin policy requires bearer credentials. Start same-origin
  // sessions with WebSocket instead: browsers attach Origin to that handshake,
  // and both the Vite and single-origin production proxies support upgrades.
  return io({ ...options, transports: ['websocket'] });
}

/** First delay of the manual reconnect ladder, in ms. */
export const REALTIME_RECONNECT_BASE_MS = 1_000;

/**
 * Ceiling of the manual reconnect ladder, in ms — the same cap the Socket.IO
 * manager uses for its own backoff (`reconnectionDelayMax` above), so a tab that
 * fell through to the manual path retries no faster than one that did not.
 */
export const REALTIME_RECONNECT_MAX_MS = 60_000;

/** Where the ladder stops doubling — beyond this the cap dominates anyway. */
const MAX_RECONNECT_RUNG = 16;

/**
 * The delay before manual reconnect attempt `attempt` (0-based).
 *
 * Socket.IO stops reconnecting for good on a namespace-level refusal
 * (`connect_error` raised by handshake middleware) and on a server-initiated
 * `disconnect(true)`: it drops the socket's subscriptions, so nothing ever
 * retries. Those are exactly the *transient* faults the gateway raises under
 * load — a Redis blip during admission, a connection-limit refusal — so the
 * provider re-opens the socket itself on this ladder rather than leaving the tab
 * on the 60 s poll for the rest of its page session.
 *
 * It doubles 1 s → 60 s and stays there, so a gateway that refuses forever costs
 * at most one handshake per minute per tab (never a request storm), and carries
 * ±25 % jitter so a fleet dropped by ONE server-side fault does not come back as
 * one synchronized wave. `random` is injectable for deterministic tests.
 */
export function realtimeReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const rung = Math.min(Math.max(0, Math.floor(attempt)), MAX_RECONNECT_RUNG);
  const base = Math.min(REALTIME_RECONNECT_MAX_MS, REALTIME_RECONNECT_BASE_MS * 2 ** rung);
  return Math.round(Math.min(REALTIME_RECONNECT_MAX_MS, base * (0.75 + random() * 0.5)));
}
