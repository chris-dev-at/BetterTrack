import { describe, expect, it } from 'vitest';

import {
  LIVE_MIN_POLL_INTERVAL_MS,
  LIVE_RATE_MS,
  REALTIME_ACK_ERRORS,
  REALTIME_CONNECTION_ERRORS,
  REALTIME_MAX_CONNECTIONS_PER_BEARER,
  REALTIME_MAX_CONNECTIONS_PER_USER,
  REALTIME_MAX_GLOBAL_LIVE_ASSETS,
  REALTIME_MAX_PRESENCE_SUBJECTS_PER_SOCKET,
  REALTIME_MAX_ROOMS_PER_SOCKET,
  REALTIME_MAX_ROOMS_PER_USER,
  REALTIME_MAX_WATCHED_ASSETS_PER_SOCKET,
  REALTIME_MAX_WATCHED_ASSETS_PER_USER,
  REALTIME_SOCKET_COMMAND_BURST,
  REALTIME_SOCKET_COMMANDS_PER_SECOND,
  REALTIME_USER_COMMAND_BURST,
  REALTIME_USER_COMMANDS_PER_SECOND,
  realtimeLiveWatchAckSchema,
  realtimeLiveWatchRequestSchema,
} from './realtime';

describe('realtime contracts', () => {
  it('keeps legacy sub-floor rates parseable while documenting the 5-second effective floor', () => {
    expect(
      realtimeLiveWatchRequestSchema.parse({
        assetId: '018f6f00-0000-7000-8000-000000000001',
        window: '10m',
        rate: '1s',
      }).rate,
    ).toBe('1s');
    expect(LIVE_RATE_MS['1s']).toBeLessThan(LIVE_MIN_POLL_INTERVAL_MS);
    expect(LIVE_MIN_POLL_INTERVAL_MS).toBe(5_000);
  });

  it('locks the conservative V5 admission defaults', () => {
    expect({
      connectionsPerUser: REALTIME_MAX_CONNECTIONS_PER_USER,
      connectionsPerBearer: REALTIME_MAX_CONNECTIONS_PER_BEARER,
      socketCommands: [REALTIME_SOCKET_COMMANDS_PER_SECOND, REALTIME_SOCKET_COMMAND_BURST],
      userCommands: [REALTIME_USER_COMMANDS_PER_SECOND, REALTIME_USER_COMMAND_BURST],
      watchedPerSocket: REALTIME_MAX_WATCHED_ASSETS_PER_SOCKET,
      watchedPerUser: REALTIME_MAX_WATCHED_ASSETS_PER_USER,
      globalLiveAssets: REALTIME_MAX_GLOBAL_LIVE_ASSETS,
      roomsPerSocket: REALTIME_MAX_ROOMS_PER_SOCKET,
      roomsPerUser: REALTIME_MAX_ROOMS_PER_USER,
      presencePerSocket: REALTIME_MAX_PRESENCE_SUBJECTS_PER_SOCKET,
    }).toEqual({
      connectionsPerUser: 5,
      connectionsPerBearer: 3,
      socketCommands: [20, 40],
      userCommands: [50, 100],
      watchedPerSocket: 8,
      watchedPerUser: 16,
      globalLiveAssets: 250,
      roomsPerSocket: 32,
      roomsPerUser: 64,
      presencePerSocket: 64,
    });
  });

  it('locks typed handshake and acknowledgement quota failures', () => {
    expect(REALTIME_CONNECTION_ERRORS).toContain('USER_CONNECTION_LIMIT');
    expect(REALTIME_CONNECTION_ERRORS).toContain('BEARER_CONNECTION_LIMIT');
    for (const error of [
      'RATE_LIMITED',
      'SOCKET_WATCH_LIMIT',
      'USER_WATCH_LIMIT',
      'SOCKET_ROOM_LIMIT',
      'USER_ROOM_LIMIT',
      'SOCKET_PRESENCE_LIMIT',
      'GLOBAL_LIVE_LIMIT',
      'LIVE_WORK_BUSY',
    ] as const) {
      expect(REALTIME_ACK_ERRORS).toContain(error);
      expect(realtimeLiveWatchAckSchema.parse({ ok: false, error })).toEqual({
        ok: false,
        error,
      });
    }
  });
});
