import { describe, expect, it, vi } from 'vitest';

import type { DriveConnection } from '@bettertrack/contracts';

import {
  createGoogleDriveTokenClient,
  type DriveAccessTokenResult,
  type GoogleDriveTokenClient,
  type GoogleTokenResponse,
} from '../drive/gisTokenClient';
import { createDriveConnectionRegistry, driveTokenClientIdentity } from './driveConnectionRegistry';

function connection(id: string, sub: string, email: string): DriveConnection {
  return {
    id,
    googleSub: sub,
    email,
    displayName: email,
    createdAt: '2026-08-20T12:00:00.000Z',
    lastVerifiedAt: '2026-08-20T12:00:00.000Z',
  };
}

function tokenClient(token: string): GoogleDriveTokenClient {
  let state: GoogleDriveTokenClient['state'] = 'consent-required';
  let current: DriveAccessTokenResult = { status: 'consent-required', message: 'consent' };
  return {
    get state() {
      return state;
    },
    getAccessToken: vi.fn(() => current),
    prepare: vi.fn(async () => undefined),
    authorize: vi.fn(async () => {
      state = 'connected';
      current = { status: 'ok', accessToken: token, expiresAt: Date.now() + 60_000 };
      return current;
    }),
    subscribe: vi.fn(() => () => undefined),
    identify: vi.fn(),
    clear: vi.fn(() => {
      state = 'consent-required';
      current = { status: 'consent-required', message: 'consent' };
    }),
    markExpired: vi.fn(() => {
      state = 'token-expired';
      current = { status: 'token-expired', message: 'expired' };
    }),
    markRevoked: vi.fn(() => {
      state = 'revoked';
      current = { status: 'revoked', message: 'revoked' };
    }),
  };
}

describe('per-connection Drive registry', () => {
  it('keeps Y and Z capabilities separate and sends only identity to BetterTrack', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000401', 'sub-y', 'y@example.test');
    const z = connection('018f0000-0000-7000-8000-000000000402', 'sub-z', 'z@example.test');
    const yClient = tokenClient('token-y');
    const zClient = tokenClient('token-z');
    const clients = [yClient, zClient];
    const hints: Array<string | undefined> = [];
    const create = vi.fn().mockResolvedValueOnce(y).mockResolvedValueOnce(z);
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      api: {
        create,
        verify: vi.fn(async (id) => (id === y.id ? y : z)),
        delete: vi.fn(async () => undefined),
      },
      tokenClient: (existing) => {
        hints.push(existing?.googleSub);
        return clients.shift()!;
      },
      identify: vi
        .fn()
        .mockResolvedValueOnce({ googleSub: y.googleSub, email: y.email, displayName: 'Y' })
        .mockResolvedValueOnce({ googleSub: z.googleSub, email: z.email, displayName: 'Z' }),
    });

    await expect(registry.connect()).resolves.toMatchObject({ status: 'ok', connection: y });
    await expect(registry.connect()).resolves.toMatchObject({ status: 'ok', connection: z });

    expect(hints).toEqual([undefined, undefined]);
    // A bootstrap client is minted before the row exists, so it carries no
    // hint. The registry pins it to the resolved identity instead of leaving
    // every re-mint of this page session hint-less and generically worded.
    expect(yClient.identify).toHaveBeenCalledWith({
      loginHint: y.email,
      identityLabel: y.email,
    });
    expect(zClient.identify).toHaveBeenCalledWith({
      loginHint: z.email,
      identityLabel: z.email,
    });
    expect(registry.tokens(y.id)?.getAccessToken()).toMatchObject({
      status: 'ok',
      accessToken: 'token-y',
    });
    expect(registry.tokens(z.id)?.getAccessToken()).toMatchObject({
      status: 'ok',
      accessToken: 'token-z',
    });
    expect(create).toHaveBeenNthCalledWith(1, {
      googleSub: 'sub-y',
      email: 'y@example.test',
      displayName: 'Y',
    });
    expect(create).toHaveBeenNthCalledWith(2, {
      googleSub: 'sub-z',
      email: 'z@example.test',
      displayName: 'Z',
    });
    expect(JSON.stringify(create.mock.calls)).not.toMatch(/token-y|token-z/);
  });

  it('re-mints a restored connection with the documented email hint and rejects the wrong principal', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000403', 'sub-y', 'y@example.test');
    const hinted = tokenClient('hinted-y-token');
    const hints: Array<string | undefined> = [];
    const verify = vi.fn(async () => y);
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      api: { create: vi.fn(), verify, delete: vi.fn() },
      tokenClient: (existing) => {
        hints.push(driveTokenClientIdentity(existing).loginHint);
        return hinted;
      },
      identify: vi.fn(async () => ({
        googleSub: 'wrong-sub',
        email: 'wrong@example.test',
        displayName: null,
      })),
    });

    await expect(registry.authorize(y)).resolves.toEqual({
      status: 'identity-mismatch',
      connection: y,
      message: 'Sign in to Google (y@example.test) to sync.',
    });
    // The hint Google documents is the email; the stored permissionId is an
    // equality token for `proveIdentity`, never a hint.
    expect(hints).toEqual(['y@example.test']);
    expect(hints).not.toContain(y.googleSub);
    expect(hinted.clear).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it('releases the client it replaces when re-consenting an already-registered account', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000406', 'sub-y', 'y@example.test');
    const first = tokenClient('first-y-token');
    const second = tokenClient('second-y-token');
    const clients = [first, second];
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      // The upsert is keyed on (user, googleSub), so a second consent to the
      // same Google account returns the SAME connection id.
      api: { create: vi.fn(async () => y), verify: vi.fn(async () => y), delete: vi.fn() },
      tokenClient: () => clients.shift()!,
      identify: vi.fn(async () => ({
        googleSub: y.googleSub,
        email: y.email,
        displayName: y.displayName,
      })),
    });

    await expect(registry.connect()).resolves.toMatchObject({ status: 'ok', connection: y });
    await expect(registry.connect()).resolves.toMatchObject({ status: 'ok', connection: y });

    // The superseded client is cleared, so its token and expiry timer die with
    // the last reference to it; the live one keeps the fresh capability.
    expect(first.clear).toHaveBeenCalledTimes(1);
    expect(second.clear).not.toHaveBeenCalled();
    // Consumers receive the principal-checking facade, never the raw GIS
    // capability that could re-mint without repeating about.get.
    expect(registry.tokens(y.id)).not.toBe(second);
    expect(registry.tokens(y.id)?.getAccessToken()).toMatchObject({
      status: 'ok',
      accessToken: 'second-y-token',
    });
  });

  it('re-mints Y and Z independently with each registered email as login hint', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000404', 'sub-y', 'y@example.test');
    const z = connection('018f0000-0000-7000-8000-000000000405', 'sub-z', 'z@example.test');
    const yClient = tokenClient('renewed-token-y');
    const zClient = tokenClient('renewed-token-z');
    const hints: Array<string | undefined> = [];
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      api: {
        create: vi.fn(),
        verify: vi.fn(async (id) => (id === y.id ? y : z)),
        delete: vi.fn(),
      },
      tokenClient: (existing) => {
        hints.push(driveTokenClientIdentity(existing).loginHint);
        return existing?.id === y.id ? yClient : zClient;
      },
      identify: vi.fn(async (client) =>
        client === yClient
          ? { googleSub: y.googleSub, email: y.email, displayName: y.displayName }
          : { googleSub: z.googleSub, email: z.email, displayName: z.displayName },
      ),
    });

    await expect(registry.authorize(y)).resolves.toMatchObject({ status: 'ok', connection: y });
    await expect(registry.authorize(z)).resolves.toMatchObject({ status: 'ok', connection: z });

    expect(hints).toEqual(['y@example.test', 'z@example.test']);
    expect(registry.tokens(y.id)?.getAccessToken()).toMatchObject({
      status: 'ok',
      accessToken: 'renewed-token-y',
    });
    expect(registry.tokens(z.id)?.getAccessToken()).toMatchObject({
      status: 'ok',
      accessToken: 'renewed-token-z',
    });
  });

  it('fails closed when the chooser switches Google accounts between capability mints', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000407', 'sub-y', 'y@example.test');
    const raw = tokenClient('y-token');
    const identify = vi
      .fn()
      .mockResolvedValueOnce({
        googleSub: y.googleSub,
        email: y.email,
        displayName: y.displayName,
      })
      .mockResolvedValueOnce({
        googleSub: 'chooser-switched-to-z',
        email: 'z@example.test',
        displayName: 'Z',
      });
    const verify = vi.fn(async () => y);
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      api: { create: vi.fn(async () => y), verify, delete: vi.fn() },
      tokenClient: () => raw,
      identify,
    });

    await expect(registry.connect()).resolves.toMatchObject({ status: 'ok', connection: y });
    const capability = registry.tokens(y.id);
    expect(capability).not.toBeNull();
    capability!.markExpired();

    await expect(capability!.authorize()).resolves.toEqual({
      status: 'identity-mismatch',
      message: 'Sign in to Google (y@example.test) to sync.',
    });
    expect(identify).toHaveBeenCalledTimes(2);
    expect(raw.authorize).toHaveBeenCalledTimes(2);
    expect(raw.clear).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
    expect(capability!.getAccessToken()).toEqual({
      status: 'identity-mismatch',
      message: 'Sign in to Google (y@example.test) to sync.',
    });
    expect(registry.authorization(y)).toBe('identity-mismatch');
  });

  // Every other test in this file injects `tokenClient`, so none of them can
  // see the DEFAULT factory. #1337 makes `authorize()` refuse to defer its
  // popup past a script load, and the registry mints a brand-new client per
  // connection without ever preparing it — so the E5 connect gesture is exactly
  // the caller that would silently stop opening a popup. Pin it here.
  it('opens the consent popup on the first connect gesture with its own token client', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000408', 'sub-y', 'y@example.test');
    let callback!: (response: GoogleTokenResponse) => void;
    const requestAccessToken = vi.fn(() => {
      callback({ access_token: 'first-gesture-token', expires_in: 3600 });
    });
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      api: { create: vi.fn(async () => y), verify: vi.fn(async () => y), delete: vi.fn() },
      // The real `createGoogleDriveTokenClient`, with only the GIS script load
      // stubbed — this is the code path production uses.
      tokenClient: (existing) =>
        createGoogleDriveTokenClient({
          clientId: 'browser-client-id',
          ...driveTokenClientIdentity(existing),
          loadOauth2: async () => ({
            initTokenClient(config) {
              callback = config.callback;
              return { requestAccessToken };
            },
          }),
        }),
      identify: vi.fn(async () => ({
        googleSub: y.googleSub,
        email: y.email,
        displayName: y.displayName,
      })),
    });

    await expect(registry.connect()).resolves.toMatchObject({ status: 'ok', connection: y });
    expect(requestAccessToken).toHaveBeenCalledOnce();
  });

  it('opens the consent popup on the first re-authorization of a registered connection', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000409', 'sub-y', 'y@example.test');
    let callback!: (response: GoogleTokenResponse) => void;
    const requestAccessToken = vi.fn(() => {
      callback({ access_token: 'renewed-token', expires_in: 3600 });
    });
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      api: { create: vi.fn(async () => y), verify: vi.fn(async () => y), delete: vi.fn() },
      tokenClient: (existing) =>
        createGoogleDriveTokenClient({
          clientId: 'browser-client-id',
          ...driveTokenClientIdentity(existing),
          loadOauth2: async () => ({
            initTokenClient(config) {
              callback = config.callback;
              return { requestAccessToken };
            },
          }),
        }),
      identify: vi.fn(async () => ({
        googleSub: y.googleSub,
        email: y.email,
        displayName: y.displayName,
      })),
    });

    // No prior `connect()`: this is a reload landing on a stored connection row.
    await expect(registry.authorize(y)).resolves.toMatchObject({ status: 'ok', connection: y });
    expect(requestAccessToken).toHaveBeenCalledOnce();
  });

  // #1518: the two tests above pin the FALLBACK path (an unprepared client that
  // loads GIS from inside `authorize()`). The four below pin the prepared one —
  // preparation is what makes "the popup opens synchronously from the click"
  // true by construction rather than by convention, so it is driven through the
  // real `createGoogleDriveTokenClient` too.
  function preparedRegistryHarness(y: DriveConnection) {
    let callback!: (response: GoogleTokenResponse) => void;
    const loads: string[] = [];
    const requestAccessToken = vi.fn(() => {
      callback({ access_token: 'prepared-token', expires_in: 3600 });
    });
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      api: { create: vi.fn(async () => y), verify: vi.fn(async () => y), delete: vi.fn() },
      tokenClient: (existing) =>
        createGoogleDriveTokenClient({
          clientId: 'browser-client-id',
          ...driveTokenClientIdentity(existing),
          loadOauth2: async () => {
            loads.push(existing?.email ?? 'bootstrap');
            return {
              initTokenClient(config) {
                callback = config.callback;
                return { requestAccessToken };
              },
            };
          },
        }),
      identify: vi.fn(async () => ({
        googleSub: y.googleSub,
        email: y.email,
        displayName: y.displayName,
      })),
    });
    return { loads, registry, requestAccessToken };
  }

  it('prepares the very client the connect gesture will use, so no load precedes its popup', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000410', 'sub-y', 'y@example.test');
    const { loads, registry, requestAccessToken } = preparedRegistryHarness(y);

    await registry.prepare();
    expect(loads).toEqual(['bootstrap']);

    // Nothing may be awaited between the gesture and the popup: `connect()`
    // must reach `requestAccessToken` before its own promise is inspected.
    const connecting = registry.connect();
    expect(requestAccessToken).toHaveBeenCalledOnce();
    await expect(connecting).resolves.toMatchObject({ status: 'ok', connection: y });
    // The registered client is the prepared one — no second GIS load happened.
    expect(loads).toEqual(['bootstrap']);
  });

  it('prepares a registered identity so its re-authorization popup opens from the click', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000411', 'sub-y', 'y@example.test');
    const { loads, registry, requestAccessToken } = preparedRegistryHarness(y);

    await registry.prepare(y);
    expect(loads).toEqual([y.email]);

    const authorizing = registry.authorize(y);
    expect(requestAccessToken).toHaveBeenCalledOnce();
    await expect(authorizing).resolves.toMatchObject({ status: 'ok', connection: y });
  });

  it('prepares every already-registered identity alongside the next connect client', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000412', 'sub-y', 'y@example.test');
    const { loads, registry } = preparedRegistryHarness(y);

    // Rendering a connection row registers its client through `authorization`.
    expect(registry.authorization(y)).toBe('consent-required');
    await registry.prepare();

    expect(loads).toEqual(expect.arrayContaining(['bootstrap', y.email]));
    expect(loads).toHaveLength(2);
  });

  it('gives the account registered by a connect gesture back its own next client', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000413', 'sub-y', 'y@example.test');
    const { loads, registry, requestAccessToken } = preparedRegistryHarness(y);

    await registry.prepare();
    await expect(registry.connect()).resolves.toMatchObject({ status: 'ok' });
    requestAccessToken.mockClear();

    // The prepared client is now pinned to `y`; reusing it for "add another
    // account" would re-register the same identity without a popup. The next
    // preparation therefore mints — and loads — a fresh bootstrap, while the
    // registered client keeps the GIS it already has.
    await registry.prepare();
    expect(loads).toEqual(['bootstrap', 'bootstrap']);
    expect(requestAccessToken).not.toHaveBeenCalled();
  });
});
