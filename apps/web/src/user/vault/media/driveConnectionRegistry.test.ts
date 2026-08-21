import { describe, expect, it, vi } from 'vitest';

import type { DriveConnection } from '@bettertrack/contracts';

import type { DriveAccessTokenResult, GoogleDriveTokenClient } from '../drive/gisTokenClient';
import { createDriveConnectionRegistry } from './driveConnectionRegistry';

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
    authorize: vi.fn(async () => {
      state = 'connected';
      current = { status: 'ok', accessToken: token, expiresAt: Date.now() + 60_000 };
      return current;
    }),
    subscribe: vi.fn(() => () => undefined),
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
    const clients = [tokenClient('token-y'), tokenClient('token-z')];
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

  it('re-mints a restored connection with its googleSub hint and rejects the wrong principal', async () => {
    const y = connection('018f0000-0000-7000-8000-000000000403', 'sub-y', 'y@example.test');
    const hinted = tokenClient('hinted-y-token');
    const hints: Array<string | undefined> = [];
    const verify = vi.fn(async () => y);
    const registry = createDriveConnectionRegistry({
      clientId: 'browser-client-id',
      api: { create: vi.fn(), verify, delete: vi.fn() },
      tokenClient: (existing) => {
        hints.push(existing?.googleSub);
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
    expect(hints).toEqual(['sub-y']);
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
    expect(registry.tokens(y.id)).toBe(second);
    expect(registry.tokens(y.id)?.getAccessToken()).toMatchObject({
      status: 'ok',
      accessToken: 'second-y-token',
    });
  });

  it('re-mints Y and Z independently with each registered subject as login hint', async () => {
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
        hints.push(existing?.googleSub);
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

    expect(hints).toEqual(['sub-y', 'sub-z']);
    expect(registry.tokens(y.id)?.getAccessToken()).toMatchObject({
      status: 'ok',
      accessToken: 'renewed-token-y',
    });
    expect(registry.tokens(z.id)?.getAccessToken()).toMatchObject({
      status: 'ok',
      accessToken: 'renewed-token-z',
    });
  });
});
