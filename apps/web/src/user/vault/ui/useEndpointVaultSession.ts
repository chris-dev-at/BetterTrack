import { useEffect } from 'react';

import { useQueryClient } from '@tanstack/react-query';

import { useOptionalAuth } from '../../AuthContext';
import {
  bindEndpointKeystoreAccount,
  endpointVaultKeystore,
  resumeEndpointSessionOnce,
} from '../keystore/runtime';
import { VAULT_ENDPOINT_STATE_QUERY_PREFIX } from './useVaultEndpointState';

/**
 * Binds the endpoint keystore to the signed-in account and joins the session the
 * device's other tabs already hold.
 *
 * Mounted once, in the authenticated shell. The request itself is idempotent and
 * account-guarded (`resumeEndpointSessionOnce`); this hook only decides WHEN it
 * is allowed to run and who has to be told.
 *
 * Two consumers have to learn about a resumed session, and they learn about it
 * differently:
 *
 *   • the STATE surfaces (stub, switcher, chip, manager) through this query
 *     invalidation, so a stub painted a moment ago stops offering "Unlock";
 *   • the STORE resolver through the keystore's own vault-opened edge, raised
 *     per resumed vault inside `resumeSessionFromOpenTabs` — the #1531/#1533
 *     machinery, reused rather than duplicated here.
 */
export function useEndpointVaultSession(): void {
  // OPTIONAL auth: the shell renders inside the provider, but tests and
  // storybook-ish harnesses mount pieces of it without one, and "no account" is
  // an answer (no session, no channel), not a crash.
  const auth = useOptionalAuth();
  const accountId = auth?.status === 'authenticated' ? (auth.user?.id ?? null) : null;
  const queryClient = useQueryClient();

  useEffect(() => {
    bindEndpointKeystoreAccount(accountId);
    if (accountId === null) return;
    let cancelled = false;
    void resumeEndpointSessionOnce().then((result) => {
      if (cancelled || result.unlockedVaultIds.length === 0) return;
      void queryClient.invalidateQueries({ queryKey: VAULT_ENDPOINT_STATE_QUERY_PREFIX });
    });
    return () => {
      cancelled = true;
    };
  }, [accountId, queryClient]);

  /**
   * The other direction, and the half a cross-tab lock needs.
   *
   * `lockDevice()` revokes the session synchronously wherever it lands — this
   * tab on a manual lock, every OTHER tab of the account through the session
   * channel and the storage twin — but the keystore has no way to repaint
   * React. Without this, locking in one tab left the second tab's cached
   * endpoint state reading "Ready on this device" for as long as nothing else
   * invalidated it: the revocation had happened, and only the screen disagreed.
   *
   * It converges: an `endSession` triggered from inside `stateFor` (a revision
   * change) cannot fire twice, because the second read finds no session to end.
   */
  useEffect(
    () =>
      endpointVaultKeystore.subscribeToSessionEnd(() => {
        void queryClient.invalidateQueries({ queryKey: VAULT_ENDPOINT_STATE_QUERY_PREFIX });
      }),
    [queryClient],
  );
}
