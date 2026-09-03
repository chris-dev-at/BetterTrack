import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EndpointUnlockResult } from './types';

const ACCOUNT_A = '018f6a3e-0000-7000-8000-00000000aaaa';
const ACCOUNT_B = '018f6a3e-0000-7000-8000-00000000bbbb';
const VAULT_1 = '018f6a3e-1111-7000-8000-000000000001';

const keystore = vi.hoisted(() => {
  const sessionEndListeners = new Set<() => void>();
  let bound: string | null = null;
  return {
    resumeSessionFromOpenTabs: vi.fn(
      async (): Promise<EndpointUnlockResult> => ({ unlockedVaultIds: [] }),
    ),
    bindAccount: vi.fn((accountId: string | null) => {
      const next = accountId?.trim() || null;
      if (bound === next) return;
      const had = bound !== null;
      bound = next;
      if (had) keystore.endSession();
    }),
    boundAccountId: vi.fn((): string | null => bound),
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

import {
  bindEndpointKeystoreAccount,
  endpointKeystoreAccountId,
  endpointVaultKeystore,
  resumeEndpointSessionOnce,
} from './runtime';

beforeEach(() => {
  bindEndpointKeystoreAccount(null);
  keystore.resumeSessionFromOpenTabs.mockClear();
  keystore.endSession.mockClear();
  keystore.bindAccount.mockClear();
  keystore.resumeSessionFromOpenTabs.mockResolvedValue({ unlockedVaultIds: [] });
});

afterEach(() => {
  bindEndpointKeystoreAccount(null);
});

describe('endpoint session runtime', () => {
  it('binds the shared lock signal for the app singleton', () => {
    // The gap this closes: before this arc, NOTHING wired the per-portfolio
    // keystore to sign-out, the PIN idle lock or a manual lock.
    expect(keystore.bindToVaultLockSignal).toHaveBeenCalled();
    expect(endpointVaultKeystore).toBe(keystore);
  });

  it('never asks another tab for a session before an account is bound', async () => {
    await expect(resumeEndpointSessionOnce()).resolves.toEqual({ unlockedVaultIds: [] });
    expect(keystore.resumeSessionFromOpenTabs).not.toHaveBeenCalled();
  });

  it('asks exactly once per tab, however many surfaces read state', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.resumeSessionFromOpenTabs.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });

    await Promise.all([
      resumeEndpointSessionOnce(),
      resumeEndpointSessionOnce(),
      resumeEndpointSessionOnce(),
    ]);
    await resumeEndpointSessionOnce();

    expect(keystore.resumeSessionFromOpenTabs).toHaveBeenCalledTimes(1);
  });

  it('re-asks after a consistency teardown that no lock caused', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.resumeSessionFromOpenTabs.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });
    await resumeEndpointSessionOnce();
    expect(keystore.resumeSessionFromOpenTabs).toHaveBeenCalledTimes(1);

    // What a SECOND TAB writing a phrase entry does to this one: the revision
    // moved, so `reconcileSessionRevision` ends the session. That is not a lock.
    keystore.endSession();
    await resumeEndpointSessionOnce();
    expect(keystore.resumeSessionFromOpenTabs).toHaveBeenCalledTimes(2);
  });

  it('asks again exactly once per session end, and never between ends', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.resumeSessionFromOpenTabs.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });
    await resumeEndpointSessionOnce();

    // Since §12's 2026-09-03 amendment a session can also come back from the
    // device's persisted record, so EVERY session end — a real lock included —
    // earns one re-attempt. A real lock has already written the §12 marker, so
    // that attempt finds a locked device and resumes nothing; what must never
    // happen is a second attempt without a new end in between (a poll).
    keystore.resumeSessionFromOpenTabs.mockResolvedValue({ unlockedVaultIds: [] });
    keystore.endSession();
    await resumeEndpointSessionOnce();
    await resumeEndpointSessionOnce();
    await resumeEndpointSessionOnce();
    expect(keystore.resumeSessionFromOpenTabs).toHaveBeenCalledTimes(2);

    keystore.endSession();
    await resumeEndpointSessionOnce();
    await resumeEndpointSessionOnce();
    expect(keystore.resumeSessionFromOpenTabs).toHaveBeenCalledTimes(3);
  });

  it('rebinds the keystore and forgets the memo when the account changes', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.resumeSessionFromOpenTabs.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });
    await resumeEndpointSessionOnce();
    keystore.endSession.mockClear();

    bindEndpointKeystoreAccount(ACCOUNT_B);

    expect(keystore.bindAccount).toHaveBeenCalledWith(ACCOUNT_B);
    expect(keystore.endSession).toHaveBeenCalledTimes(1);
    expect(endpointKeystoreAccountId()).toBe(ACCOUNT_B);
    await resumeEndpointSessionOnce();
    expect(keystore.resumeSessionFromOpenTabs).toHaveBeenCalledTimes(2);
  });

  it('does not re-bind, or end a session, when the same account is set again', async () => {
    bindEndpointKeystoreAccount(ACCOUNT_A);
    keystore.resumeSessionFromOpenTabs.mockResolvedValue({ unlockedVaultIds: [VAULT_1] });
    await resumeEndpointSessionOnce();
    keystore.bindAccount.mockClear();
    keystore.endSession.mockClear();

    // Every mount of the shell calls this. Treating a re-bind as a change would
    // end the live session on every navigation.
    bindEndpointKeystoreAccount(ACCOUNT_A);

    expect(keystore.bindAccount).not.toHaveBeenCalled();
    expect(keystore.endSession).not.toHaveBeenCalled();
    await resumeEndpointSessionOnce();
    expect(keystore.resumeSessionFromOpenTabs).toHaveBeenCalledTimes(1);
  });
});
