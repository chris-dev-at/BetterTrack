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

/**
 * Strip the client-only rows (v2 security material, market-asset snapshots) and
 * validate every restore row.
 *
 * The vault's `customAsset` bucket doubles as the client's LOCAL ASSET TABLE:
 * it also snapshots the market-catalog assets a transaction, dividend or
 * standing order references, because the client engine resolves every asset
 * through it (`engine/session.ts`, `engine/model.ts`). Those snapshots are not
 * vault data — the global `assets` row survived the enable purge and
 * rehydration re-resolves it from there (`resolveReferencedAssets`) — and the
 * server refuses a document that carries them: `validateCustomAssetFacts`
 * requires EVERY `customAsset` entity, tombstones included, to be this
 * account's own manual asset. So the market snapshots stop here, live and
 * tombstoned alike, and what crosses is exactly the owner's custom assets —
 * which is also exactly the set `retainedCustomAssetRetireIds` requires the
 * document to account for.
 *
 * The two identity fields the server derives rather than stores independently
 * (`providerId: 'manual'`, `providerRef: <the asset id>` — see
 * `customAssetRepository.create`) are restated from the entity id instead of
 * passed through. They carry no information of their own for an owned asset,
 * and this is the account's only non-destructive exit: it must not be blockable
 * by a value that is derivable. The owner claim itself is NOT rewritten —
 * unlocking already refuses a vault whose asset rows claim a different owner.
 */
export function toStrictRestoreDocument(document: VaultDocument): VaultStrictDocumentV1 {
  const entities: VaultStrictEntity[] = [];
  for (const kind of VAULT_ENTITY_KINDS) {
    const rows = document.entities[kind] ?? [];
    for (const row of rows) {
      if (kind !== 'customAsset') {
        entities.push(parseStrictEntity(kind, row));
        continue;
      }
      if (row.data.ownerId == null) continue;
      entities.push(
        parseStrictEntity(kind, {
          ...row,
          data: { ...row.data, providerId: 'manual', providerRef: row.id },
        }),
      );
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
