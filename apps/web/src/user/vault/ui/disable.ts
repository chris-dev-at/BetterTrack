import {
  VAULT_DOCUMENT_V1_VERSION,
  vaultStrictDocumentV1Schema,
  type ParanoidDisableResponse,
  type VaultDocument,
  type VaultStrictDocumentV1,
} from '@bettertrack/contracts';

import { disableParanoidMode } from '../../../lib/userApi';
import { toStrictRestoreDocument } from '../paranoidDisable';

const REHYDRATION_ID_PREFIX = 'bettertrack:vault-rehydration:';

/**
 * The non-destructive exit: hand the decrypted document back and continue as a
 * NORMAL account.
 *
 * The restore-boundary conversion is deliberately NOT restated here. It is
 * `../paranoidDisable`'s {@link toStrictRestoreDocument} — the single copy that
 * the enable wizard's pre-commit proof also runs (`ui/enable.ts`), which is the
 * only thing that makes that proof cover the code this path actually ships.
 *
 * A second copy briefly lived in this module and omitted one line —
 * `mirrorProvenance` (§7.1). The strict schema declares that field
 * `.default([])`, so the omission was not a type error, not a parse error and
 * not a test failure: the payload simply shipped an empty carriage. Server
 * side, `proveForkProvenance` short-circuits on an empty map, so a sanctioned
 * MIRRORCHAIN chain-correction movement then trips `validateLedgerSolvency`
 * ("would overdraw its cash source") and the disable is refused — identically
 * on every retry, leaving only the IRREVERSIBLE discard. One converter, one
 * home.
 */
export async function disableUnlockedVault(
  document: VaultDocument,
  accountId: string,
): Promise<ParanoidDisableResponse> {
  return rehydrateAndDisable(accountId, toStrictRestoreDocument(document), null);
}

/**
 * Re-auth for the destruction exit: the typed username plus ONE credential
 * (account password, or a fresh TOTP code on a 2FA account). The server
 * verifies both — this type only carries them there.
 */
export interface ParanoidDiscardCredential {
  confirmUsername: string;
  password?: string;
  code?: string;
  recoveryCode?: string;
}

/**
 * The locked-vault exit (docs/paranoid-design.md §3, verbatim: "lost key ⇒ lost
 * data … The only server-side 'recovery' is destruction"). A client that cannot
 * decrypt has nothing to hand back, so it restores NOTHING and says so
 * explicitly: `discard` is a separate flag rather than an inference from an
 * empty graph, so a client bug that loses its rows still trips the ordinary
 * restore invariants instead of silently wiping the account.
 *
 * The server purges the ciphertext, retires the retained custom-asset identity
 * claims no document can account for, and the account continues as an empty
 * NORMAL account — the outcome the enable wizard's strong acknowledgment
 * describes. Everything outside the vault (auth, friends, chat, alerts,
 * watchlists, settings) is untouched: none of it was ever in the blob, and the
 * default portfolio is provisioned lazily exactly as it is at registration.
 *
 * It shares {@link disableUnlockedVault}'s rehydration id on purpose: if an
 * interrupted real rehydration already committed, the server answers that
 * receipt idempotently instead of wiping what it just restored.
 *
 * Unlike the restoring disable it is IRREVERSIBLE, so it carries the
 * account-deletion rung: the typed username and a re-verified credential, both
 * checked on the server (`paranoidDiscardReauth`).
 */
export async function discardLockedVault(
  accountId: string,
  credential: ParanoidDiscardCredential,
): Promise<ParanoidDisableResponse> {
  const document = vaultStrictDocumentV1Schema.parse({
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities: [],
    mergeLog: [],
  });
  return rehydrateAndDisable(accountId, document, credential);
}

async function rehydrateAndDisable(
  accountId: string,
  document: VaultStrictDocumentV1,
  credential: ParanoidDiscardCredential | null,
): Promise<ParanoidDisableResponse> {
  const storageKey = `${REHYDRATION_ID_PREFIX}${accountId}`;
  const rehydrationId = storedRehydrationId(storageKey) ?? globalThis.crypto.randomUUID();
  rememberRehydrationId(storageKey, rehydrationId);
  const result = await disableParanoidMode({
    rehydrationId,
    document,
    confirm: true,
    ...(credential === null ? {} : { discard: true, ...credential }),
  });
  forgetRehydrationId(storageKey);
  return result;
}

function storedRehydrationId(key: string): string | null {
  try {
    const value = globalThis.sessionStorage?.getItem(key);
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

function rememberRehydrationId(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // A same-tab retry still remains safe server-side if storage is blocked.
  }
}

function forgetRehydrationId(key: string): void {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    // No persisted retry marker to remove.
  }
}
