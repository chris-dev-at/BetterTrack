import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EndpointUnlockResult } from './types';

const ACCOUNT_A = '018f6a3e-0000-7000-8000-00000000aaaa';
const ACCOUNT_B = '018f6a3e-0000-7000-8000-00000000bbbb';
const VAULT_1 = '018f6a3e-1111-7000-8000-000000000001';

const keystore = vi.hoisted(() => {
  const sessionEndListeners = new Set<() => void>();
  return {
    restoreFromDeviceCustody: vi.fn(
      async (): Promise<EndpointUnlockResult> => ({ unlockedVaultIds: [] }),
    ),
    endSession: vi.fn(() => {
      for (const listener of [...sessionEndListeners]) listener();
    }),
    subscribeToSessionEnd: vi.fn((listener: () => void) => {
      sessionEndListeners.add(listener);
      return () => sessionEndListeners.delete(listener);
    }),
    bindToVaultLockSignal: vi.fn(() => () => undefined),
    sessionEndListeners,
  };
});

vi.mock('./core', () => ({ EndpointVaultKeystore: vi.fn(() => keystore) }));
vi.mock('./deviceCustody', () => ({ createIndexedDbEndpointDeviceCustody: vi.fn(() => ({})) }));

import {
  bindEndpointKeystoreAccount,
  endpointKeystoreAccountId,
  endpointVaultKeystore,
  restoreEndpointCustodyOnce,
} from './runtime';

beforeEach(() => {
  keystore.restoreFromDeviceCustody.mockClear();
  keystore.endSession.mockClear();
  keystore.restoreFromDeviceCustody.mockResolvedValue({ unlockedVaultIds: [] });
  bindEndpointKeystoreAccount(null);
});

afterEach(() => {
  bindEndpointKeystoreAccount(null);
});

describe('endpoint custody runtime', () => {
  it('binds the shared lock signal for the app singleton', () => {
    // The gap this closes: before device custody, NOTHING wired the
    // per-portfolio keystore to sign-out, the PIN idle lock or a manual lock.
    expect(keystore.bindToVaultLockSignal).toHaveBeenCalled();
    expect(endpointVaultKeystore).toBe(keystore);
  });

  it('never touches custody before an account is bound', async () => {
    await expect(restoreEndpointCustodyOnce()).resolves.toEqual({ unlockedVaultIds: [] });
    expect(keystore.restoreFromDeviceCustody).not.toHaveBeenCalled();
  });

  it('restores exactly once per tab, however many surfaces ask', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.restoreFromDeviceCustody.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });

    await Promise.all([
      restoreEndpointCustodyOnce(),
      restoreEndpointCustodyOnce(),
      restoreEndpointCustodyOnce(),
    ]);
    await restoreEndpointCustodyOnce();

    expect(keystore.restoreFromDeviceCustody).toHaveBeenCalledTimes(1);
  });

  it('re-establishes a restored session after a consistency teardown', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.restoreFromDeviceCustody.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });
    await restoreEndpointCustodyOnce();
    expect(keystore.restoreFromDeviceCustody).toHaveBeenCalledTimes(1);

    // What a SECOND TAB writing a phrase entry does to this one: the revision
    // moved, so `reconcileSessionRevision` ends the session. That is not a lock.
    keystore.endSession();
    await restoreEndpointCustodyOnce();
    expect(keystore.restoreFromDeviceCustody).toHaveBeenCalledTimes(2);
  });

  it('stops retrying as soon as one attempt restores nothing', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.restoreFromDeviceCustody.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });
    await restoreEndpointCustodyOnce();

    // A real lock: `lockDevice` has already set the §12 marker and deleted the
    // record, so the one retry it earns finds a locked device — and disarms.
    keystore.restoreFromDeviceCustody.mockResolvedValue({ unlockedVaultIds: [] });
    keystore.endSession();
    await restoreEndpointCustodyOnce();
    keystore.endSession();
    await restoreEndpointCustodyOnce();
    keystore.endSession();
    await restoreEndpointCustodyOnce();

    expect(keystore.restoreFromDeviceCustody).toHaveBeenCalledTimes(2);
  });

  it('ends the session and forgets the restore when the account changes', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.restoreFromDeviceCustody.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });
    await restoreEndpointCustodyOnce();
    keystore.endSession.mockClear();

    bindEndpointKeystoreAccount(ACCOUNT_B);

    expect(keystore.endSession).toHaveBeenCalledTimes(1);
    expect(endpointKeystoreAccountId()).toBe(ACCOUNT_B);
    await restoreEndpointCustodyOnce();
    expect(keystore.restoreFromDeviceCustody).toHaveBeenCalledTimes(2);
  });

  it('does not end a session on the first bind of a tab', () => {
    keystore.endSession.mockClear();
    bindEndpointKeystoreAccount(ACCOUNT_A);
    expect(keystore.endSession).not.toHaveBeenCalled();
  });
});
