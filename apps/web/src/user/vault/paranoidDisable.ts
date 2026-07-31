import {
  paranoidDisableRequestSchema,
  VAULT_DOCUMENT_V1_VERSION,
  vaultStrictDocumentV1Schema,
  type ParanoidDisableRequest,
  type VaultDocument,
  type VaultEntity,
  type VaultEntityKind,
  type VaultStrictDocumentV1,
} from '@bettertrack/contracts';

import { VaultCryptoError } from './errors';
import { carriedForkProvenance } from './mirrorProvenance';

/**
 * Disable carriage: the decrypted document → the strict restore payload
 * (`docs/paranoid-design.md` §7 / §7.1). The client owns this conversion because
 * the server never sees the plaintext until the user asks to leave paranoid mode.
 *
 * Two things happen here and nowhere else:
 *
 * 1. The kind-keyed entity record becomes the strict `entities` array the API
 *    validates. Tombstones ride along — restore drops them, and the client keeps
 *    them for merge convergence.
 * 2. §7.1 fork provenance is carried, pruned to the rows the document still keeps
 *    live. An entry naming a deleted row is rejected server-side, so pruning is
 *    what keeps a legitimate local deletion from blocking disable.
 */
export function strictVaultDocumentForDisable(document: VaultDocument): VaultStrictDocumentV1 {
  const entities = (
    Object.entries(document.entities) as [VaultEntityKind, VaultEntity[] | undefined][]
  ).flatMap(([kind, rows]) => (rows ?? []).map((entity) => ({ ...entity, kind })));

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
): ParanoidDisableRequest {
  return paranoidDisableRequestSchema.parse({
    rehydrationId,
    confirm: true,
    document: strictVaultDocumentForDisable(document),
  });
}
