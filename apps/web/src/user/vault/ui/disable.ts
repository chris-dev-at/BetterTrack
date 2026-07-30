import {
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_SCHEMAS,
  vaultStrictDocumentV1Schema,
  type ParanoidDisableResponse,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type VaultStrictDocumentV1,
  type VaultStrictEntity,
} from '@bettertrack/contracts';

import { disableParanoidMode } from '../../../lib/userApi';

const REHYDRATION_ID_PREFIX = 'bettertrack:vault-rehydration:';

/** Strip v2 client-only security material and validate every restore row. */
export function toStrictRestoreDocument(document: VaultDocument): VaultStrictDocumentV1 {
  const entities: VaultStrictEntity[] = [];
  for (const kind of VAULT_ENTITY_KINDS) {
    const rows = document.entities[kind] ?? [];
    for (const row of rows) {
      entities.push(parseStrictEntity(kind, row));
    }
  }
  return vaultStrictDocumentV1Schema.parse({
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities,
    mergeLog: document.mergeLog,
  });
}

export async function disableUnlockedVault(
  document: VaultDocument,
  accountId: string,
): Promise<ParanoidDisableResponse> {
  return rehydrateAndDisable(accountId, toStrictRestoreDocument(document), false);
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
 */
export async function discardLockedVault(accountId: string): Promise<ParanoidDisableResponse> {
  const document = vaultStrictDocumentV1Schema.parse({
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities: [],
    mergeLog: [],
  });
  return rehydrateAndDisable(accountId, document, true);
}

async function rehydrateAndDisable(
  accountId: string,
  document: VaultStrictDocumentV1,
  discard: boolean,
): Promise<ParanoidDisableResponse> {
  const storageKey = `${REHYDRATION_ID_PREFIX}${accountId}`;
  const rehydrationId = storedRehydrationId(storageKey) ?? globalThis.crypto.randomUUID();
  rememberRehydrationId(storageKey, rehydrationId);
  const result = await disableParanoidMode({
    rehydrationId,
    document,
    confirm: true,
    ...(discard ? { discard: true } : {}),
  });
  forgetRehydrationId(storageKey);
  return result;
}

function parseStrictEntity(kind: VaultEntityKind, row: VaultEntity): VaultStrictEntity {
  // The keyed schema keeps the kind/payload relationship exact at runtime. The
  // union return is re-parsed by the strict document before it crosses the API.
  return VAULT_ENTITY_SCHEMAS[kind].parse({ ...row, kind }) as VaultStrictEntity;
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
