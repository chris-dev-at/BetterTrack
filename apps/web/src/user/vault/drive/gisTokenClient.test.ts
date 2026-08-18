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

    await client.prepare();
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
    await client.authorize();
    expect(requestAccessToken).toHaveBeenCalledTimes(1);
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

    await client.prepare();
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

  it('turns a synchronous popup failure into a retryable gesture state', async () => {
    const requestAccessToken = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('popup blocked');
      })
      .mockImplementationOnce(() => undefined);
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      loadOauth2: async () => ({
        initTokenClient: () => ({ requestAccessToken }),
      }),
    });

    await client.prepare();
    await expect(client.authorize()).resolves.toEqual({
      status: 'gesture-required',
      message: 'popup blocked',
    });
    expect(client.getAccessToken()).toMatchObject({ status: 'gesture-required' });

    const retry = client.authorize();
    await vi.waitFor(() => expect(requestAccessToken).toHaveBeenCalledTimes(2));
    client.clear();
    await expect(retry).resolves.toMatchObject({ status: 'gesture-required' });
  });

  it('ignores a successful callback after clear, even when a new request has started', async () => {
    const callbacks: Array<(response: GoogleTokenResponse) => void> = [];
    const requestAccessToken = vi.fn();
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      loadOauth2: async () => ({
        initTokenClient(config) {
          callbacks.push(config.callback);
          return { requestAccessToken };
        },
      }),
    });

    await client.prepare();
    const first = client.authorize();
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    client.clear();
    await expect(first).resolves.toMatchObject({
      status: 'gesture-required',
      message: 'Google sign-in was cancelled.',
    });

    callbacks[0]!({ access_token: 'stale-after-clear', expires_in: 3600 });
    expect(client.getAccessToken()).toMatchObject({ status: 'consent-required' });

    const second = client.authorize();
    await vi.waitFor(() => expect(callbacks).toHaveLength(2));
    callbacks[0]!({ access_token: 'stale-during-retry', expires_in: 3600 });
    expect(client.getAccessToken()).toMatchObject({ status: 'consent-required' });
    callbacks[1]!({ access_token: 'fresh', expires_in: 3600 });

    await expect(second).resolves.toMatchObject({ status: 'ok', accessToken: 'fresh' });
  });

  it('publishes browser-memory token expiry without another user action', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T10:00:00.000Z'));
    try {
      let callback!: (response: GoogleTokenResponse) => void;
      const listener = vi.fn();
      const client = createGoogleDriveTokenClient({
        clientId: 'browser-client-id',
        loadOauth2: async () => ({
          initTokenClient(config) {
            callback = config.callback;
            return {
              requestAccessToken: () => callback({ access_token: 'short', expires_in: 31 }),
            };
          },
        }),
      });
      await client.prepare();
      client.subscribe(listener);

      await expect(client.authorize()).resolves.toMatchObject({ status: 'ok' });
      expect(client.state).toBe('connected');

      await vi.advanceTimersByTimeAsync(1_001);

      expect(client.state).toBe('token-expired');
      expect(listener).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recreates GIS after a failed preload without deferring its popup past a gesture', async () => {
    delete window.google;
    document
      .querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]')
      ?.remove();
    const client = createGoogleDriveTokenClient({ clientId: 'browser-client-id' });

    const failed = client.prepare();
    const failedScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    expect(failedScript).not.toBeNull();
    failedScript!.dispatchEvent(new Event('error'));
    await expect(failed).rejects.toThrow('Google Identity Services could not be loaded.');
    expect(failedScript!.isConnected).toBe(false);

    await expect(client.authorize()).resolves.toMatchObject({
      status: 'gesture-required',
      message: 'Google sign-in is still loading. Try again once it is ready.',
    });
    const script = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    expect(script).not.toBeNull();
    expect(script).not.toBe(failedScript);
    let callback!: (response: GoogleTokenResponse) => void;
    const requestAccessToken = vi.fn(() => {
      callback({ access_token: 'fresh', expires_in: 3600 });
    });
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient(config) {
            callback = config.callback;
            return {
              requestAccessToken,
            };
          },
        },
      },
    };
    script!.dispatchEvent(new Event('load'));

    await client.prepare();
    expect(requestAccessToken).not.toHaveBeenCalled();

    const authorized = client.authorize();
    expect(requestAccessToken).toHaveBeenCalledOnce();

    await expect(authorized).resolves.toMatchObject({
      status: 'ok',
      accessToken: 'fresh',
    });
    client.clear();
  });
});
