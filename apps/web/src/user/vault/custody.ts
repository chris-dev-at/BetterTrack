/**
 * The RETIRED v1 "keep unlocked on this device" custody — what is left of it is
 * the ERASER (#1640 residue 3).
 *
 * `docs/paranoid-design.md` §12 has said it since the model was written: *"There
 * is NO 'keep unlocked on this device' checkbox for wrapped custody — v1's
 * persisted-VK convenience (`custody.ts` keep-unlocked) is deliberately
 * retired."* PR #1604 removed the per-portfolio port of that convenience; the v1
 * ACCOUNT-LEVEL original kept shipping, so the note declared a retirement the
 * code had never performed — a documentation drift with a security-shaped claim
 * attached, which is the worst kind: a reader asking "is persisted custody
 * gone?" got *yes* from the note and *no* from the app.
 *
 * It is gone now: the checkbox (`ui/VaultUnlockGate.tsx`), the write path
 * (`lock.ts` keep-unlocked / `setUnlocked`) and the read path
 * (`unlockFromDevice`) were deleted together.
 *
 * ── WHY A FILE REMAINS ────────────────────────────────────────────────────
 *
 * Deleting the writer does not delete what it already wrote. Every device where
 * a v1 user ticked that box still holds a non-extractable AES-GCM `CryptoKey`
 * for the VAULT KEY in `bettertrack-vault-custody`, and orphaning it would leave
 * §12's "the vault key exists only in volatile process memory" false on exactly
 * the devices the retirement was for. So the last thing this module does is
 * remove the database it used to fill, once per authenticated mount
 * (`VaultRuntimeProvider`). That provider mounts exactly where the retired
 * custody could ever have been written — a v1 paranoid account on this device —
 * which is the reach this needs; an account §17 has already wiped mounts no
 * vault runtime, and the orphan key there opens nothing that still exists.
 *
 * The whole file dies with the §19 deletion train at the end of §17, alongside
 * the v1 gate and the recovery-kit flow.
 */

/** The store the retired convenience wrote to. It is also the idempotency key. */
export const RETIRED_CUSTODY_DATABASE = 'bettertrack-vault-custody';

/**
 * The two localStorage keys that existed only to serve it: the per-account
 * custody device id the persisted key was filed under, and the v1 device-locked
 * marker that decided whether that key was still allowed to open the vault.
 * Neither is a secret; both are now write-only litter and go with the key.
 * (The §12 marker the CURRENT keystore uses is a different key entirely —
 * `bettertrack:endpoint-device-locked:` in `keystore/deviceLock.ts` — and is
 * untouched by this.)
 */
const RETIRED_CUSTODY_DEVICE_PREFIX = 'bettertrack:vault-custody-device:';
const RETIRED_DEVICE_LOCKED_PREFIX = 'bettertrack:vault-device-locked:';

/**
 * Remove every trace of the retired v1 device-key custody from this device.
 *
 * IDEMPOTENT by construction — the idempotency key is the database NAME plus
 * the account-scoped storage keys: `deleteDatabase` and `removeItem` on
 * something absent both succeed, so the second and every later call is a no-op
 * and callers need no "already purged" bookkeeping.
 *
 * Best effort, and deliberately not awaited by any caller: a browser with no
 * IndexedDB, a blocked profile, or another tab holding the database open
 * (`onblocked`) must not delay or fail an unlock. A purge that does not land
 * today lands at the next mount, and nothing reads any of it in the meantime
 * because every reader is deleted.
 */
export function purgeRetiredDeviceCustody(accountId: string | null): void {
  try {
    globalThis.indexedDB?.deleteDatabase(RETIRED_CUSTODY_DATABASE);
  } catch {
    // Nothing to recover: the reader is gone either way, and the next mount
    // tries again.
  }
  if (accountId == null) return;
  try {
    globalThis.localStorage?.removeItem(`${RETIRED_CUSTODY_DEVICE_PREFIX}${accountId}`);
    globalThis.localStorage?.removeItem(`${RETIRED_DEVICE_LOCKED_PREFIX}${accountId}`);
  } catch {
    // Same: litter, not a secret, and the next mount tries again.
  }
}
