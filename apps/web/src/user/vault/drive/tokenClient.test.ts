import { describe, expect, it, vi } from 'vitest';

import {
  createGoogleDriveTokenClient,
  DRIVE_APPDATA_SCOPE,
  googleDriveClientId,
  type GoogleIdentityServices,
} from './tokenClient';

function gisHarness() {
  let callback: ((response: Record<string, unknown>) => void) | undefined;
  let errorCallback: ((error: { type?: string }) => void) | undefined;
  const requestAccessToken = vi.fn();
  const revoke = vi.fn((_token: string, done?: () => void) => done?.());
  const initTokenClient = vi.fn((config) => {
    callback = config.callback;
    errorCallback = config.error_callback;
    return { requestAccessToken };
  });
  const google: GoogleIdentityServices = {
    accounts: { oauth2: { initTokenClient, revoke } },
  };
  return {
    google,
    initTokenClient,
    requestAccessToken,
    revoke,
    respond: (response: Record<string, unknown>) => callback?.(response),
    fail: (type: string) => errorCallback?.({ type }),
  };
}

describe('Google Drive GIS token client', () => {
  it('reads the deploy-time runtime client id without requiring a rebuilt image', () => {
    const previous = window.__BT__;
    window.__BT__ = {
      app: 'user',
      apiOrigin: '',
      googleDriveClientId: 'runtime-client.apps.googleusercontent.com',
    };
    expect(googleDriveClientId()).toBe('runtime-client.apps.googleusercontent.com');
    window.__BT__ = previous;
  });

  it('requests the app-data permission exactly and keeps the token in memory', async () => {
    const gis = gisHarness();
    let now = 1_000;
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      google: gis.google,
      now: () => now,
    });
    await client.prepare();
    expect(gis.initTokenClient).toHaveBeenCalledWith(
      expect.objectContaining({
        client_id: 'browser-client-id',
        scope: DRIVE_APPDATA_SCOPE,
        include_granted_scopes: false,
      }),
    );

    const authorization = client.authorize();
    await vi.waitFor(() =>
      expect(gis.requestAccessToken).toHaveBeenCalledWith({
        prompt: 'consent',
        scope: DRIVE_APPDATA_SCOPE,
        include_granted_scopes: false,
      }),
    );
    gis.respond({ access_token: 'memory-only-token', expires_in: 3600 });
    await expect(authorization).resolves.toEqual({
      status: 'ok',
      accessToken: 'memory-only-token',
      expiresAt: 3_601_000,
    });
    await expect(client.token()).resolves.toMatchObject({ status: 'ok' });

    now = 3_580_000;
    await expect(client.token()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'token-expired',
    });
  });

  it('keeps absent consent, offline, and gesture-required outcomes distinct', async () => {
    const gis = gisHarness();
    let online = true;
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      google: gis.google,
      online: () => online,
    });

    await expect(client.token()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'consent-required',
    });
    online = false;
    await expect(client.authorize()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'offline',
    });
    online = true;
    const authorization = client.authorize();
    await vi.waitFor(() => expect(gis.requestAccessToken).toHaveBeenCalledOnce());
    gis.fail('popup_failed_to_open');
    await expect(authorization).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'gesture-required',
    });
  });

  it('revokes only the held token and clears it before the callback', async () => {
    const gis = gisHarness();
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      google: gis.google,
    });
    const authorization = client.authorize();
    await vi.waitFor(() => expect(gis.requestAccessToken).toHaveBeenCalledOnce());
    gis.respond({ access_token: 'ephemeral', expires_in: 3600 });
    await authorization;
    await client.disconnect();
    expect(gis.revoke).toHaveBeenCalledWith('ephemeral', expect.any(Function));
    expect(client.status()).toEqual({ status: 'consent-required' });
  });
});
