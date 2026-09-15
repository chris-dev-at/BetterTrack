import { EndpointVaultKeystore } from './core';
import type { EndpointUnlockResult } from './types';

const NOTHING_RESUMED: EndpointUnlockResult = { unlockedVaultIds: [] };

let resumeOnce: Promise<EndpointUnlockResult> | null = null;

/** One endpoint-scoped E3 keystore shared by the directory, chip and stubs. */
export const endpointVaultKeystore = new EndpointVaultKeystore();

/**
 * Bind (or release) the account this endpoint session belongs to.
 *
 * A module singleton outlives every sign-in, so the account cannot be captured
 * at construction. The keystore owns the boundary itself (`bindAccount`): it
 * opens the account's session channel, refuses grants stamped with any other
 * account, and treats a CHANGE of account as a revocation.
 */
export function bindEndpointKeystoreAccount(accountId: string | null): void {
  if (endpointVaultKeystore.boundAccountId() === (accountId?.trim() || null)) return;
  endpointVaultKeystore.bindAccount(accountId);
  resumeOnce = null;
}

/** The account currently bound, for surfaces that must not guess it. */
export function endpointKeystoreAccountId(): string | null {
  return endpointVaultKeystore.boundAccountId();
}

/**
 * ONE cross-tab session request per tab per account, awaited by every first
 * state read.
 *
 * Without the memo, `useVaultEndpointState` would broadcast a request on every
 * refetch of every vault. Without the account guard, a state query that beat the
 * shell's binding effect would cache "nothing resumed" for the rest of the tab's
 * life — the exact shape of race that leaves a user staring at a locked
 * portfolio they never locked.
 */
export function resumeEndpointSessionOnce(): Promise<EndpointUnlockResult> {
  if (endpointVaultKeystore.boundAccountId() === null) return Promise.resolve(NOTHING_RESUMED);
  resumeOnce ??= endpointVaultKeystore.resumeSessionFromOpenTabs();
  return resumeOnce;
}

/**
 * A session may be re-requested after a teardown no lock caused.
 *
 * `endSession()` is raised by consistency teardowns as well as by locks — a
 * SECOND TAB writing a phrase entry bumps the keystore revision, and
 * `reconcileSessionRevision` ends this tab's session over it. Without this
 * retry, one tab unlocking would silently lock the other, which is precisely
 * the "it locks itself again" this work exists to end. Since the 2026-09-03
 * amendment the session also lives on the device (`sessionPersistence.ts`), so
 * the retry is worth it for a PASSWORD-established session too, not only for
 * one a sibling tab granted.
 *
 * It cannot resurrect a real lock: manual lock, sign-out and the PIN idle lock
 * all go through `lockDevice()`, which writes the §12 marker BEFORE the session
 * end this listener sees — so the retry runs, finds a locked device, and
 * settles at "nothing resumed". And it is never a poll: the memo is dropped
 * once per session end, and only the next state READ asks again.
 */
endpointVaultKeystore.subscribeToSessionEnd(() => {
  resumeOnce = null;
});

/**
 * Sign-out, the PIN idle lock, an account switch and a manual lock all dispatch
 * `VAULT_LOCK_REQUEST_EVENT` (and its account-scoped cross-tab twin). Before
 * this binding the per-portfolio keystore listened to NONE of them — it was
 * per-tab memory-only, so a reload hid the gap. With one session shared across
 * the device's tabs, an unbound keystore would let a sign-out in one tab leave
 * the others unlocked, so this is load-bearing.
 */
export const releaseEndpointKeystoreLockSignal =
  typeof globalThis.addEventListener === 'function'
    ? endpointVaultKeystore.bindToVaultLockSignal()
    : () => undefined;
