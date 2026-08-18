import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', () => ({ io: vi.fn() }));
vi.mock('../runtimeConfig', () => ({ getRuntimeConfig: vi.fn() }));

import { REALTIME_PATH } from '@bettertrack/contracts';
import { io } from 'socket.io-client';

import { getRuntimeConfig } from '../runtimeConfig';
import { createRealtimeSocket } from './socket';

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
