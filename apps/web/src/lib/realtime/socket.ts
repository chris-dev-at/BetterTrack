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
  // Empty apiOrigin = same origin (dev Vite proxy / single-origin setups).
  return apiOrigin ? io(apiOrigin, options) : io(options);
}
