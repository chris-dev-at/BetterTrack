import { describe, expect, it, vi } from 'vitest';

import type { DriveAccessTokenResult } from './gisTokenClient';
import { revokeDriveGrant } from './revokeGrant';

function tokens(current: DriveAccessTokenResult) {
  return { getAccessToken: vi.fn(() => current), markRevoked: vi.fn() };
}

describe('revokeDriveGrant', () => {
  it('hands a held grant back to Google and drops the local capability', async () => {
    const held = tokens({ status: 'ok', accessToken: 'granted-token', expiresAt: Date.now() });
    const revoke = vi.fn(async () => undefined);

    await revokeDriveGrant(held, revoke);

    expect(revoke).toHaveBeenCalledWith('granted-token');
    expect(held.markRevoked).toHaveBeenCalledOnce();
  });

  it('does nothing when no grant was taken', async () => {
    const none = tokens({ status: 'consent-required', message: 'consent' });
    const revoke = vi.fn(async () => undefined);

    await revokeDriveGrant(none, revoke);

    expect(revoke).not.toHaveBeenCalled();
    expect(none.markRevoked).not.toHaveBeenCalled();
  });

  it('still releases the local capability when Google refuses the round trip', async () => {
    const held = tokens({ status: 'ok', accessToken: 'granted-token', expiresAt: Date.now() });
    const revoke = vi.fn(() => Promise.reject(new Error('network down')));

    await expect(revokeDriveGrant(held, revoke)).resolves.toBeUndefined();
    expect(held.markRevoked).toHaveBeenCalledOnce();
  });
});
