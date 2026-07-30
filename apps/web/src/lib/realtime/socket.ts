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
