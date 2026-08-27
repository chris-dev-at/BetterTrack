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
  it('contains no retired hidden-folder scope in shipped web source or operator files', () => {
    // `infra` is in scope deliberately (E5 review F5): the source moved to
    // drive.file while four operator files still told a deployer to create an
    // app-data credential, and a pin that walked only `src` could not see it. A
    // wrong Google credential is a real deployment failure, not a typo.
    const roots = [resolve(process.cwd(), 'src'), resolve(process.cwd(), '..', '..', 'infra')];
    const scanned: string[] = [];
    const visit = (directory: string) => {
      for (const name of readdirSync(directory)) {
        if (name === 'node_modules') continue;
        const path = resolve(directory, name);
        if (statSync(path).isDirectory()) visit(path);
        else if (!/\.(test|spec)\.[cm]?[jt]sx?$/u.test(name))
          scanned.push(readFileSync(path, 'utf8'));
      }
    };
    for (const root of roots) visit(root);
    const corpus = scanned.join('\n');
    // Proof the infra walk actually landed: without it this assertion would
    // pass on an empty corpus if the relative path ever drifted.
    expect(corpus).toContain('BT_GOOGLE_DRIVE_CLIENT_ID');
    expect(corpus).not.toContain('drive.appdata');
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

    await client.prepare();
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

  it('keeps the first popup synchronous after a fresh client finishes preloading GIS', async () => {
    let completeLoad!: (oauth2: GoogleOauth2) => void;
    let callback!: (response: GoogleTokenResponse) => void;
    const loadOauth2 = vi.fn(
      () =>
        new Promise<GoogleOauth2>((resolve) => {
          completeLoad = resolve;
        }),
    );
    const requestAccessToken = vi.fn(() => {
      callback({ access_token: 'fresh-token', expires_in: 3600 });
    });
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      loadOauth2,
    });

    const preparation = client.prepare();
    expect(loadOauth2).toHaveBeenCalledOnce();
    expect(requestAccessToken).not.toHaveBeenCalled();

    completeLoad({
      initTokenClient(config) {
        callback = config.callback;
        return { requestAccessToken };
      },
    });
    await preparation;

    const authorization = client.authorize();
    // No await happens between the click-facing call above and GIS opening its
    // popup. This is the fresh-browser contract the Drive controls rely on.
    expect(requestAccessToken).toHaveBeenCalledOnce();
    await expect(authorization).resolves.toMatchObject({
      status: 'ok',
      accessToken: 'fresh-token',
    });
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

    await client.prepare();
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

  it('adopts a resolved identity without dropping the capability it already holds', async () => {
    const hints: Array<string | undefined> = [];
    let callback!: (response: GoogleTokenResponse) => void;
    let clock = 1_000;
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      now: () => clock,
      loadOauth2: async () => ({
        initTokenClient(config) {
          hints.push(config.login_hint);
          callback = config.callback;
          return {
            requestAccessToken: () =>
              callback({ access_token: `token-${hints.length}`, expires_in: 60 }),
          };
        },
      }),
    });

    // A bootstrap mint: the connection row does not exist yet, so no hint.
    await client.prepare();
    await expect(client.authorize()).resolves.toMatchObject({ accessToken: 'token-1' });

    client.identify({ loginHint: 'drive-z@example.test', identityLabel: 'drive-z@example.test' });
    // The fresh capability survives the pin — re-creating the client instead
    // would have thrown the consent the user just gave away.
    expect(client.getAccessToken()).toMatchObject({ status: 'ok', accessToken: 'token-1' });

    clock += 61_000;
    expect(client.getAccessToken()).toEqual({
      status: 'token-expired',
      message: 'Sign in to Google (drive-z@example.test) to sync.',
    });
    await client.authorize();
    expect(hints).toEqual([undefined, 'drive-z@example.test']);
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

  // The E5 per-connection registry mints a client per identity AT gesture time
  // and cannot preload it, so `authorize()` must still work unprepared. It
  // loads GIS first — which is what risks the popup block that `prepare()`
  // exists to avoid — rather than refusing and turning the click into a no-op.
  it('still reaches the popup for a caller that never prepared', async () => {
    let completeLoad!: (oauth2: GoogleOauth2) => void;
    let callback!: (response: GoogleTokenResponse) => void;
    const loadOauth2 = vi.fn(
      () =>
        new Promise<GoogleOauth2>((resolve) => {
          completeLoad = resolve;
        }),
    );
    const requestAccessToken = vi.fn(() => {
      callback({ access_token: 'deferred-token', expires_in: 3600 });
    });
    const client = createGoogleDriveTokenClient({ clientId: 'browser-client-id', loadOauth2 });

    const authorization = client.authorize();
    expect(loadOauth2).toHaveBeenCalledOnce();
    expect(requestAccessToken).not.toHaveBeenCalled();

    completeLoad({
      initTokenClient(config) {
        callback = config.callback;
        return { requestAccessToken };
      },
    });

    await expect(authorization).resolves.toMatchObject({
      status: 'ok',
      accessToken: 'deferred-token',
    });
    expect(requestAccessToken).toHaveBeenCalledOnce();
  });

  it('reports an unloadable GIS to an unprepared caller instead of hanging', async () => {
    const client = createGoogleDriveTokenClient({
      clientId: 'browser-client-id',
      loadOauth2: () => Promise.reject(new Error('offline')),
    });

    await expect(client.authorize()).resolves.toEqual({
      status: 'gesture-required',
      message: 'Google sign-in could not be loaded. Try again.',
    });
    expect(client.state).toBe('gesture-required');
  });

  it('recreates GIS after a failed preload and keeps the retried popup synchronous', async () => {
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

    // The failure is not sticky: the retry the UI offers mounts a NEW script.
    const retried = client.prepare();
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

    await retried;
    expect(requestAccessToken).not.toHaveBeenCalled();

    const authorized = client.authorize();
    // No await between the click-facing call above and GIS opening its popup.
    expect(requestAccessToken).toHaveBeenCalledOnce();

    await expect(authorized).resolves.toMatchObject({
      status: 'ok',
      accessToken: 'fresh',
    });
    client.clear();
  });
});
