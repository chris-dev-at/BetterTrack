import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  createGoogleDriveTokenClient,
  DRIVE_FILE_SCOPE,
  type GoogleOauth2,
  type GoogleTokenResponse,
} from './gisTokenClient';
import { readGoogleDriveIdentity } from './driveIdentity';

describe('Google Drive GIS token client', () => {
  it('contains no retired hidden-folder scope anywhere in shipped web source', () => {
    const root = resolve(process.cwd(), 'src');
    const shipped: string[] = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        const path = resolve(directory, name);
        if (statSync(path).isDirectory()) visit(path);
        else if (!/\.(test|spec)\.[cm]?[jt]sx?$/u.test(name))
          shipped.push(readFileSync(path, 'utf8'));
      }
    };
    visit(root);
    expect(shipped.join('\n')).not.toContain('drive.appdata');
    expect(DRIVE_FILE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('requests exactly drive.file with the connection login hint and keeps tokens in memory', async () => {
    let callback!: (response: GoogleTokenResponse) => void;
    let configuredScope: string | undefined;
    let includeGrantedScopes: boolean | undefined;
    let configuredLoginHint: string | undefined;
    const requestAccessToken = vi.fn(() => {
      callback({ access_token: 'memory-only-token', expires_in: 3600 });
    });
    const oauth2: GoogleOauth2 = {
      initTokenClient(config) {
        configuredScope = config.scope;
        includeGrantedScopes = config.include_granted_scopes;
        configuredLoginHint = config.login_hint;
        callback = config.callback;
        return { requestAccessToken };
      },
    };
    const localWrite = vi.spyOn(Storage.prototype, 'setItem');
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      loginHint: 'google-sub-y',
      loadOauth2: async () => oauth2,
      now: () => 1_000,
    });

    await expect(client.authorize()).resolves.toEqual({
      status: 'ok',
      accessToken: 'memory-only-token',
      expiresAt: 3_601_000,
    });
    expect(configuredScope).toBe(DRIVE_FILE_SCOPE);
    expect(configuredScope).toBe('https://www.googleapis.com/auth/drive.file');
    expect(configuredLoginHint).toBe('google-sub-y');
    expect(includeGrantedScopes).toBe(false);
    expect(requestAccessToken).toHaveBeenCalledWith({
      prompt: 'consent',
      scope: DRIVE_FILE_SCOPE,
      include_granted_scopes: false,
    });
    expect(client.getAccessToken()).toMatchObject({ status: 'ok' });
    expect(localWrite).not.toHaveBeenCalled();
    await client.authorize();
    expect(requestAccessToken).toHaveBeenCalledTimes(1);
    client.clear();
    expect(client.getAccessToken()).toMatchObject({ status: 'consent-required' });
  });

  it('flags invalid_grant and exposes an identity-specific sign-in action', async () => {
    let callback!: (response: GoogleTokenResponse) => void;
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      loginHint: 'google-sub-z',
      identityLabel: 'drive-z@example.test',
      loadOauth2: async () => ({
        initTokenClient(config) {
          callback = config.callback;
          return {
            requestAccessToken: () =>
              callback({ error: 'invalid_grant', error_description: 'grant revoked' }),
          };
        },
      }),
    });

    await expect(client.authorize()).resolves.toEqual({
      status: 'revoked',
      message: 'grant revoked',
    });
    expect(client.state).toBe('revoked');
    expect(client.getAccessToken()).toEqual({
      status: 'revoked',
      message: 'Sign in to Google (drive-z@example.test) to sync.',
    });
  });

  it('captures the stable Drive identity with about.get and returns no capability fields', async () => {
    const tokens = {
      getAccessToken: vi.fn(() => ({
        status: 'ok' as const,
        accessToken: 'fresh-browser-token',
        expiresAt: Date.now() + 60_000,
      })),
      markExpired: vi.fn(),
      markRevoked: vi.fn(),
    };
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            permissionId: 'stable-google-sub',
            emailAddress: 'drive@example.test',
            displayName: 'Drive owner',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const identity = await readGoogleDriveIdentity(tokens, fetch);

    expect(identity).toEqual({
      googleSub: 'stable-google-sub',
      email: 'drive@example.test',
      displayName: 'Drive owner',
    });
    expect(Object.keys(identity).sort()).toEqual(['displayName', 'email', 'googleSub']);
    expect(fetch.mock.calls[0]![0]).toBe('https://www.googleapis.com/drive/v3/about?fields=user');
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('Authorization')).toBe(
      'Bearer fresh-browser-token',
    );
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

  it('recreates the GIS loader after a transient script failure', async () => {
    delete window.google;
    document
      .querySelector<HTMLScriptElement>('script[src="https://accounts.google.com/gsi/client"]')
      ?.remove();
    const client = createGoogleDriveTokenClient({ clientId: 'browser-client-id' });

    const failed = client.authorize();
    const failedScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    expect(failedScript).not.toBeNull();
    failedScript!.dispatchEvent(new Event('error'));
    await expect(failed).resolves.toMatchObject({
      status: 'gesture-required',
      message: 'Google sign-in could not be loaded. Try again.',
    });
    expect(failedScript!.isConnected).toBe(false);

    let callback!: (response: GoogleTokenResponse) => void;
    const retried = client.authorize();
    const retryScript = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    expect(retryScript).not.toBeNull();
    expect(retryScript).not.toBe(failedScript);
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient(config) {
            callback = config.callback;
            return {
              requestAccessToken: () => callback({ access_token: 'recovered', expires_in: 3600 }),
            };
          },
        },
      },
    };
    retryScript!.dispatchEvent(new Event('load'));

    await expect(retried).resolves.toMatchObject({
      status: 'ok',
      accessToken: 'recovered',
    });
  });
});
