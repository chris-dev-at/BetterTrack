import {
  VAULT_DOCUMENT_VERSION,
  vaultDocumentSchema,
  type VaultDocument,
} from '@bettertrack/contracts';

import { VaultCryptoError } from './errors';

export type VaultDocumentMigration = (document: unknown) => unknown;

/**
 * A pure, in-memory migration seam. Versions add `n -> n + 1` functions here
 * and no migration runs for newer data. The v1 -> v2 security upgrade is
 * intentionally performed by the retirement-proof manager because it requires
 * fresh client-held key material.
 */
export function migrateVaultDocument(
  document: unknown,
  fromVersion: number,
  migrations: ReadonlyMap<number, VaultDocumentMigration> = new Map(),
): VaultDocument {
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

  const parsed = vaultDocumentSchema.safeParse(current);
  if (!parsed.success || parsed.data.schemaVersion !== VAULT_DOCUMENT_VERSION) {
    throw new VaultCryptoError(
      'document-invalid',
      'Vault document migration did not produce the current schema.',
    );
  }
  return parsed.data;
}
