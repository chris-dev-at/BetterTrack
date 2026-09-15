import { describe, expect, it, vi } from 'vitest';

import type { DriveAccessTokenResult } from './gisTokenClient';
import { revokeDriveGrant } from './revokeGrant';

function tokens(current: DriveAccessTokenResult) {
  return { getAccessToken: vi.fn(() => current), markRevoked: vi.fn() };
}

function grant(): DriveAccessTokenResult {
  return { status: 'ok', accessToken: 'granted-token', expiresAt: Date.now() };
}

describe('revokeDriveGrant', () => {
  it('hands a held grant back to Google and drops the local capability', async () => {
    const held = tokens(grant());
    const revoke = vi.fn(async () => undefined);

    await revokeDriveGrant(held, { revoke });

    expect(revoke).toHaveBeenCalledWith('granted-token');
    expect(held.markRevoked).toHaveBeenCalledOnce();
  });

  it('does nothing when no grant was taken', async () => {
    const none = tokens({ status: 'consent-required', message: 'consent' });
    const revoke = vi.fn(async () => undefined);

    await revokeDriveGrant(none, { revoke });

    expect(revoke).not.toHaveBeenCalled();
    expect(none.markRevoked).not.toHaveBeenCalled();
  });

  it('still releases the local capability when Google refuses the round trip', async () => {
    const held = tokens(grant());
    const revoke = vi.fn(() => Promise.reject(new Error('network down')));

    await expect(revokeDriveGrant(held, { revoke })).resolves.toBeUndefined();
    expect(held.markRevoked).toHaveBeenCalledOnce();
  });

  // The GIS revoke is grant-level: it would drop every scope the app holds for
  // the account, killing the token client of an already-bound Drive connection.
  it('keeps a shared grant and releases only the local capability', async () => {
    const held = tokens(grant());
    const revoke = vi.fn(async () => undefined);

    await revokeDriveGrant(held, { revoke, grantIsShared: async () => true });

    expect(revoke).not.toHaveBeenCalled();
    expect(held.markRevoked).toHaveBeenCalledOnce();
  });

  it('revokes at Google when nothing else holds the grant', async () => {
    const held = tokens(grant());
    const revoke = vi.fn(async () => undefined);

    await revokeDriveGrant(held, { revoke, grantIsShared: async () => false });

    expect(revoke).toHaveBeenCalledWith('granted-token');
  });

  it('keeps the grant when the sharing check cannot answer', async () => {
    const held = tokens(grant());
    const revoke = vi.fn(async () => undefined);

    await revokeDriveGrant(held, {
      revoke,
      grantIsShared: () => Promise.reject(new Error('offline')),
    });

    expect(revoke).not.toHaveBeenCalled();
    expect(held.markRevoked).toHaveBeenCalledOnce();
  });
});
