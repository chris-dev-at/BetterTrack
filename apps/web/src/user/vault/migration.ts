import { VAULT_DOCUMENT_VERSION, type VaultDocumentV1 } from '@bettertrack/contracts';

import { VaultCryptoError } from './errors';

export type VaultDocumentMigration = (document: unknown) => unknown;

/**
 * A pure, in-memory migration seam. PD4 currently knows document v1 only; later
 * versions add `n -> n + 1` functions here and no migration runs for newer data.
 */
export function migrateVaultDocument(
  document: unknown,
  fromVersion: number,
  migrations: ReadonlyMap<number, VaultDocumentMigration> = new Map(),
): VaultDocumentV1 {
  if (fromVersion > VAULT_DOCUMENT_VERSION) {
    throw new VaultCryptoError(
      'update-required',
      'This vault document requires a newer app version.',
    );
  }

  let current = document;
  for (let version = fromVersion; version < VAULT_DOCUMENT_VERSION; version += 1) {
    const migrate = migrations.get(version);
    if (migrate == null) {
      throw new VaultCryptoError(
        'document-invalid',
        'No safe migration exists for this vault document.',
      );
    }
    current = migrate(current);
  }

  if (
    typeof current !== 'object' ||
    current == null ||
    (current as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new VaultCryptoError(
      'document-invalid',
      'Vault document migration did not produce the current schema.',
    );
  }
  return current as VaultDocumentV1;
}
