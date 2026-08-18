import { afterEach, describe, expect, it, vi } from 'vitest';

import { getGoogleDriveClientId, getRuntimeConfig } from './runtimeConfig';

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.__BT__;
});

describe('runtime configuration', () => {
  it('defaults an omitted Drive client id to not configured', () => {
    window.__BT__ = { app: 'user', apiOrigin: '' };

    expect(getRuntimeConfig().googleDriveClientId).toBe('');
    expect(getGoogleDriveClientId()).toBe('');
  });

  it('keeps the Vite client id as the build-time fallback', () => {
    vi.stubEnv('VITE_GOOGLE_DRIVE_CLIENT_ID', 'build.apps.googleusercontent.com');
    window.__BT__ = { googleDriveClientId: '' };

    expect(getGoogleDriveClientId()).toBe('build.apps.googleusercontent.com');
  });

  it('lets the runtime client id override the build-time fallback', () => {
    vi.stubEnv('VITE_GOOGLE_DRIVE_CLIENT_ID', 'build.apps.googleusercontent.com');
    window.__BT__ = { googleDriveClientId: '  runtime.apps.googleusercontent.com  ' };

    expect(getGoogleDriveClientId()).toBe('runtime.apps.googleusercontent.com');
  });
});
