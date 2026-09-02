import { useCallback, useMemo } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { useOptionalAuth } from '../../AuthContext';
import type { EndpointVaultState } from '../keystore';
import { requestVaultLock } from '../lockSignal';
import { VAULT_ENDPOINT_STATE_QUERY_PREFIX } from './useVaultEndpointState';

export interface EndpointVaultLock {
  /** Whether any vault on this endpoint currently has a session to lock. */
  canLock: boolean;
  lock: () => void;
}

/**
 * The manual lock for per-portfolio vaults — §12's explicit "Lock vaults"
 * action, and the door the user can close without waiting for a tab to die.
 *
 * The account-level gate has always offered one (the shield menu's "Lock vault",
 * `privacyMode === 'paranoid'`); the endpoint keystore had none, which was
 * survivable only while its session died with the tab that held it. Now that one
 * session is shared across every tab of the device (`keystore/sessionChannel`),
 * it is load-bearing: closing one tab no longer ends the session, so the user
 * needs a way to end it on purpose.
 *
 * It locks through `requestVaultLock`, NOT through the keystore directly, so it
 * raises exactly the signal sign-out and the PIN idle lock raise — one
 * revocation path with one set of listeners, reaching this tab synchronously and
 * the account's other tabs through the session channel and the storage twin.
 *
 * The states are passed IN rather than queried here: the shell has already read
 * them for the shield chip, and a hook that fetched its own would put a query
 * client on the critical path of the account menu, which renders for every
 * account whether or not it owns a vault.
 */
export function useEndpointVaultLock(
  states: readonly (EndpointVaultState | undefined)[],
): EndpointVaultLock {
  const auth = useOptionalAuth();
  const accountId = auth?.status === 'authenticated' ? (auth.user?.id ?? null) : null;
  const queryClient = useQueryClient();

  // Only a WRAPPED session can be locked. `stored+plain` custody is openable by
  // construction, and offering "Lock" for it would promise something no lock can
  // deliver.
  const canLock = useMemo(
    () =>
      states.some((state) => state?.status === 'stored+wrapped' && state.session === 'unlocked'),
    [states],
  );

  const lock = useCallback(() => {
    requestVaultLock(accountId);
    void queryClient.invalidateQueries({ queryKey: VAULT_ENDPOINT_STATE_QUERY_PREFIX });
  }, [accountId, queryClient]);

  return { canLock, lock };
}
