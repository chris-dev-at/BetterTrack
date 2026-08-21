export const VAULT_LOCK_REQUEST_EVENT = 'bettertrack:vault-lock-request';
export const VAULT_LOCK_SIGNAL_STORAGE_PREFIX = 'bettertrack:vault-lock:';

export function vaultLockSignalStorageKey(userId: string): string {
  return `${VAULT_LOCK_SIGNAL_STORAGE_PREFIX}${userId}`;
}

/**
 * Best-effort account-scoped cross-tab lock. The process-local event below is
 * still the synchronous boundary for this tab; storage carries the same lock
 * to normal-account tabs that deliberately mount no legacy vault provider.
 */
export function broadcastVaultLock(userId: string): void {
  try {
    globalThis.localStorage?.setItem(
      vaultLockSignalStorageKey(userId),
      `${Date.now()}:${globalThis.crypto.randomUUID()}`,
    );
  } catch {
    // This tab is already synchronously locked. Cross-tab delivery is best effort.
  }
}

/**
 * Synchronous, process-local revocation signal. Logout emits this before its
 * network request so a slow or unreachable server can never leave plaintext
 * mounted while the session is being closed.
 */
export function requestVaultLock(userId?: string | null): void {
  globalThis.dispatchEvent(new Event(VAULT_LOCK_REQUEST_EVENT));
  if (userId) broadcastVaultLock(userId);
}
