import { describe, expect, it, vi } from 'vitest';

import {
  createGoogleDriveTokenClient,
  DRIVE_APPDATA_SCOPE,
  type GoogleOauth2,
  type GoogleTokenResponse,
} from './gisTokenClient';

describe('Google Drive GIS token client', () => {
  it('requests exactly Drive appdata and keeps tokens only in closure memory', async () => {
    let callback!: (response: GoogleTokenResponse) => void;
    let configuredScope: string | undefined;
    let includeGrantedScopes: boolean | undefined;
    const requestAccessToken = vi.fn(() => {
      callback({ access_token: 'memory-only-token', expires_in: 3600 });
    });
    const oauth2: GoogleOauth2 = {
      initTokenClient(config) {
        configuredScope = config.scope;
        includeGrantedScopes = config.include_granted_scopes;
        callback = config.callback;
        return { requestAccessToken };
      },
    };
    const localWrite = vi.spyOn(Storage.prototype, 'setItem');
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      loadOauth2: async () => oauth2,
      now: () => 1_000,
    });

    await expect(client.authorize()).resolves.toEqual({
      status: 'ok',
      accessToken: 'memory-only-token',
      expiresAt: 3_601_000,
    });
    expect(configuredScope).toBe(DRIVE_APPDATA_SCOPE);
    expect(configuredScope).toBe('https://www.googleapis.com/auth/drive.appdata');
    expect(includeGrantedScopes).toBe(false);
    expect(requestAccessToken).toHaveBeenCalledWith({
      prompt: 'consent',
      scope: DRIVE_APPDATA_SCOPE,
      include_granted_scopes: false,
    });
    expect(client.getAccessToken()).toMatchObject({ status: 'ok' });
    expect(localWrite).not.toHaveBeenCalled();
    client.clear();
    expect(client.getAccessToken()).toMatchObject({ status: 'consent-required' });
  });

  it('keeps expiry, absent consent and gesture reauthorization distinct', async () => {
    let clock = 10_000;
    let callback!: (response: GoogleTokenResponse) => void;
    const requestAccessToken = vi.fn(() => callback({ access_token: 'short', expires_in: 60 }));
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      now: () => clock,
      loadOauth2: async () => ({
        initTokenClient(config) {
          callback = config.callback;
          return { requestAccessToken };
        },
      }),
    });

    expect(client.getAccessToken()).toMatchObject({ status: 'consent-required' });
    await client.authorize();
    clock += 31_000;
    expect(client.getAccessToken()).toMatchObject({ status: 'token-expired' });

    requestAccessToken.mockImplementationOnce(() =>
      callback({ error: 'interaction_required', error_description: 'gesture again' }),
    );
    await expect(client.authorize()).resolves.toEqual({
      status: 'gesture-required',
      message: 'gesture again',
    });
  });
});
