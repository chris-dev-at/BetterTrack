import { EndpointVaultKeystore } from './core';
import { createIndexedDbEndpointDeviceCustody } from './deviceCustody';
import type { EndpointUnlockResult } from './types';

const NOTHING_RESTORED: EndpointUnlockResult = { unlockedVaultIds: [] };

/**
 * The account device custody is scoped to.
 *
 * A module singleton outlives every sign-in, so the account cannot be captured
 * at construction: it is read at call time and kept here, set by
 * `useEndpointVaultCustody` from the authenticated shell.
 */
let custodyAccountId: string | null = null;
let restoreOnce: Promise<EndpointUnlockResult> | null = null;
/** What the last custody restore actually established; see the listener below. */
let restoredVaultIds: readonly string[] = [];

/** One endpoint-scoped E3 keystore shared by the directory, chip and stubs. */
export const endpointVaultKeystore = new EndpointVaultKeystore({
  custody: createIndexedDbEndpointDeviceCustody(),
  custodyAccount: () => custodyAccountId,
});

/**
 * Bind (or release) the account the endpoint session and its device custody
 * belong to.
 *
 * A CHANGE of account is a revocation, exactly as `qr/runtime.ts` treats it: the
 * live session was proven by the previous account's password and must not carry
 * into the next one. The first bind of a tab is not a change — nothing is live —
 * so it must not fire a spurious session end at every mount.
 *
 * The previous account's PERSISTED custody is revoked separately and earlier, by
 * `AuthContext`'s `requestVaultLock(previousUserId)`, which reaches
 * `lockDevice()` through the bound lock signal while this id still names the
 * outgoing account.
 */
export function bindEndpointKeystoreAccount(accountId: string | null): void {
  const next = accountId?.trim() || null;
  if (custodyAccountId === next) return;
  const hadAccount = custodyAccountId !== null;
  custodyAccountId = next;
  restoreOnce = null;
  restoredVaultIds = [];
  if (hadAccount) endpointVaultKeystore.endSession();
}

/** The account currently bound, for surfaces that must not guess it. */
export function endpointKeystoreAccountId(): string | null {
  return custodyAccountId;
}

/**
 * ONE custody restore per tab per account, awaited by every first state read.
 *
 * Without the memo, `useVaultEndpointState` would re-check IndexedDB custody on
 * every refetch of every vault. Without the account guard, a state query that
 * beat the shell's binding effect would cache "nothing restored" for the rest of
 * the tab's life — the exact shape of race that leaves a user staring at a
 * locked portfolio they never locked.
 */
export function restoreEndpointCustodyOnce(): Promise<EndpointUnlockResult> {
  if (custodyAccountId === null) return Promise.resolve(NOTHING_RESTORED);
  restoreOnce ??= endpointVaultKeystore.restoreFromDeviceCustody().then((result) => {
    restoredVaultIds = result.unlockedVaultIds;
    return result;
  });
  return restoreOnce;
}

/**
 * A session that custody established may be re-established after a teardown
 * custody did not cause.
 *
 * `endSession()` is raised by consistency teardowns as well as by locks — a
 * SECOND TAB writing a phrase entry bumps the keystore revision, and
 * `reconcileSessionRevision` ends this tab's session over it. Without this
 * retry, one tab unlocking would silently lock the other, which is precisely
 * the "it locks itself again" the custody work exists to end.
 *
 * It cannot resurrect a real lock: manual lock, sign-out and the PIN idle lock
 * all go through `lockDevice()`, which writes the §12 marker and deletes the
 * record BEFORE the session end this listener sees — so the retry runs, finds a
 * locked device, and settles at "nothing restored". Which also disarms the
 * retry, because `restoredVaultIds` is then empty: at most one re-attempt per
 * genuinely restored session, never a poll.
 */
endpointVaultKeystore.subscribeToSessionEnd(() => {
  if (restoredVaultIds.length === 0) return;
  restoredVaultIds = [];
  restoreOnce = null;
});

/**
 * Sign-out, the PIN idle lock, an account switch and a manual lock all dispatch
 * `VAULT_LOCK_REQUEST_EVENT` (and its account-scoped cross-tab twin). Before
 * this binding the per-portfolio keystore listened to NONE of them — it was
 * memory-only, so a reload hid the gap. With custody on disk, an unbound
 * keystore would survive a sign-out, so this is load-bearing.
 */
export const releaseEndpointKeystoreLockSignal =
  typeof globalThis.addEventListener === 'function'
    ? endpointVaultKeystore.bindToVaultLockSignal(globalThis, () => custodyAccountId)
    : () => undefined;
