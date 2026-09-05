import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));
vi.mock('../runtimeConfig', () => ({ getRuntimeConfig: vi.fn() }));

import { REALTIME_PATH } from '@bettertrack/contracts';
import { io } from 'socket.io-client';

import { getRuntimeConfig } from '../runtimeConfig';
import {
  createRealtimeSocket,
  realtimeReconnectDelayMs,
  REALTIME_RECONNECT_BASE_MS,
  REALTIME_RECONNECT_MAX_MS,
} from './socket';

const fakeSocket = {};

beforeEach(() => {
  vi.mocked(io).mockReset();
  vi.mocked(io).mockReturnValue(fakeSocket as never);
  vi.mocked(getRuntimeConfig).mockReset();
});

describe('createRealtimeSocket', () => {
  it.each(['user', 'admin'] as const)(
    'starts the same-origin %s client with WebSocket so the browser sends Origin',
    (app) => {
      vi.mocked(getRuntimeConfig).mockReturnValue({
        app,
        apiOrigin: '',
        productOrigin: 'https://bettertrack.at',
        googleDriveClientId: '',
      });

      expect(createRealtimeSocket()).toBe(fakeSocket);
      expect(io).toHaveBeenCalledWith({
        path: REALTIME_PATH,
        withCredentials: true,
        reconnectionDelayMax: 60_000,
        transports: ['websocket'],
      });
    },
  );

  it('keeps the cross-origin deployment on the default polling-to-WebSocket path', () => {
    vi.mocked(getRuntimeConfig).mockReturnValue({
      app: 'user',
      apiOrigin: 'https://api.example.test',
      productOrigin: 'https://bettertrack.at',
      googleDriveClientId: '',
    });

    expect(createRealtimeSocket()).toBe(fakeSocket);
    expect(io).toHaveBeenCalledWith('https://api.example.test', {
      path: REALTIME_PATH,
      withCredentials: true,
      reconnectionDelayMax: 60_000,
    });
  });
});

describe('realtimeReconnectDelayMs — the manual ladder for what Socket.IO calls terminal', () => {
  const noJitter = () => 0.5; // the ±25% band's midpoint ⇒ the nominal rung

  it('doubles from 1 s and caps at 60 s, so a refusing gateway costs ≤1 handshake/min', () => {
    expect(realtimeReconnectDelayMs(0, noJitter)).toBe(REALTIME_RECONNECT_BASE_MS);
    expect(realtimeReconnectDelayMs(1, noJitter)).toBe(2_000);
    expect(realtimeReconnectDelayMs(2, noJitter)).toBe(4_000);
    expect(realtimeReconnectDelayMs(6, noJitter)).toBe(REALTIME_RECONNECT_MAX_MS);
    // The ladder never runs away, whatever the attempt count reaches.
    expect(realtimeReconnectDelayMs(99, noJitter)).toBe(REALTIME_RECONNECT_MAX_MS);
    expect(realtimeReconnectDelayMs(-5, noJitter)).toBe(REALTIME_RECONNECT_BASE_MS);
  });

  it('jitters ±25% within the cap, so a fleet-wide drop does not return as one wave', () => {
    expect(realtimeReconnectDelayMs(1, () => 0)).toBe(1_500);
    expect(realtimeReconnectDelayMs(1, () => 0.999)).toBeLessThanOrEqual(2_500);
    // Even the top of the band respects the ceiling.
    expect(realtimeReconnectDelayMs(20, () => 0.999)).toBe(REALTIME_RECONNECT_MAX_MS);
    for (let attempt = 0; attempt < 12; attempt++) {
      const delay = realtimeReconnectDelayMs(attempt);
      expect(delay).toBeGreaterThanOrEqual(REALTIME_RECONNECT_BASE_MS * 0.75);
      expect(delay).toBeLessThanOrEqual(REALTIME_RECONNECT_MAX_MS);
    }
  });
});
