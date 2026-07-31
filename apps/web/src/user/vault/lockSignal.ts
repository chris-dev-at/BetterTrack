export const VAULT_LOCK_REQUEST_EVENT = 'bettertrack:vault-lock-request';

/**
 * Synchronous, process-local revocation signal. Logout emits this before its
 * network request so a slow or unreachable server can never leave plaintext
 * mounted while the session is being closed.
 */
export function requestVaultLock(): void {
  globalThis.dispatchEvent(new Event(VAULT_LOCK_REQUEST_EVENT));
}
