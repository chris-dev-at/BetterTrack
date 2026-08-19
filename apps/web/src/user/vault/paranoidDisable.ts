import {
  paranoidDisableRequestSchema,
  VAULT_DOCUMENT_V1_VERSION,
  VAULT_ENTITY_KINDS,
  VAULT_ENTITY_SCHEMAS,
  vaultStrictDocumentV1Schema,
  type ParanoidDisableRequest,
  type ParanoidTransitionCredential,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type VaultStrictDocumentV1,
  type VaultStrictEntity,
} from '@bettertrack/contracts';

import { VaultCryptoError } from './errors';
import { carriedForkProvenance } from './mirrorProvenance';

/**
 * Disable carriage: the decrypted document → the strict restore payload
 * (`docs/paranoid-design.md` §7 / §7.1). The client owns this conversion because
 * the server never sees the plaintext until the user asks to leave paranoid mode.
 *
 * Three things happen here and nowhere else:
 *
 * 1. The kind-keyed entity record becomes the strict `entities` array the API
 *    validates. Tombstones ride along — restore drops them, and the client keeps
 *    them for merge convergence.
 * 2. §7.1 fork provenance is carried, pruned to the rows the document still keeps
 *    live. An entry naming a deleted row is rejected server-side, so pruning is
 *    what keeps a legitimate local deletion from blocking disable.
 * 3. The client-only market-asset snapshots stop here. The vault's `customAsset`
 *    bucket doubles as the client's LOCAL ASSET TABLE: it also snapshots the
 *    market-catalog assets a transaction, dividend or standing order references,
 *    because the client engine resolves every asset through it
 *    (`engine/session.ts`, `engine/model.ts`). Those snapshots are not vault
 *    data — the global `assets` row survived the enable purge and rehydration
 *    re-resolves it from there (`resolveReferencedAssets`) — and the server
 *    refuses a document that carries them: `validateCustomAssetFacts` requires
 *    EVERY `customAsset` entity, tombstones included, to be this account's own
 *    manual asset. So the market snapshots are dropped, live and tombstoned
 *    alike, and what crosses is exactly the owner's custom assets — which is
 *    also exactly the set `retainedCustomAssetRetireIds` requires the document
 *    to account for.
 *
 * For the rows that do cross, the two identity fields the server derives rather
 * than stores independently (`providerId: 'manual'`, `providerRef: <the asset
 * id>` — see `customAssetRepository.create`) are restated from the entity id
 * instead of passed through. They carry no information of their own for an
 * owned asset, and this is the account's only non-destructive exit: it must not
 * be blockable by a value that is derivable. The owner claim itself is NOT
 * rewritten — unlocking already refuses a vault whose asset rows claim a
 * different owner.
 */
export function toStrictRestoreDocument(document: VaultDocument): VaultStrictDocumentV1 {
  const entities: VaultStrictEntity[] = [];
  for (const kind of VAULT_ENTITY_KINDS) {
    for (const row of document.entities[kind] ?? []) {
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

  const parsed = vaultStrictDocumentV1Schema.safeParse({
    // The restore payload is its own v1 contract, independent of the client
    // document's schema version: browser-only material (`clientSecurity`) is
    // deliberately absent from it.
    schemaVersion: VAULT_DOCUMENT_V1_VERSION,
    entities,
    mergeLog: document.mergeLog,
    mirrorProvenance: carriedForkProvenance(document) ?? [],
  });
  if (!parsed.success) {
    throw new VaultCryptoError(
      'document-invalid',
      'The unlocked vault does not match the restore payload contract.',
    );
  }
  return parsed.data;
}

/** The full `POST /account/paranoid/disable` body for one unlocked document. */
export function paranoidDisableRequestFor(
  rehydrationId: string,
  document: VaultDocument,
  credential: ParanoidTransitionCredential,
): ParanoidDisableRequest {
  return paranoidDisableRequestSchema.parse({
    rehydrationId,
    confirm: true,
    document: toStrictRestoreDocument(document),
    ...credential,
  });
}

function parseStrictEntity(kind: VaultEntityKind, row: VaultEntity): VaultStrictEntity {
  // The keyed schema keeps the kind/payload relationship exact at runtime; the
  // strict document re-validates the union before it crosses the API.
  const parsed = VAULT_ENTITY_SCHEMAS[kind].safeParse({ ...row, kind });
  if (!parsed.success) {
    throw new VaultCryptoError(
      'document-invalid',
      `A vault ${kind} row does not match the restore payload contract.`,
    );
  }
  return parsed.data as VaultStrictEntity;
}
