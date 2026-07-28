import type { VaultDocument, VaultEnvelopeHeader } from '@bettertrack/contracts';

import { decryptVaultDocument, type VaultKeyMaterial } from '../crypto';

export interface AuthenticatedVaultCopy {
  envelope: Uint8Array;
  header: VaultEnvelopeHeader;
  document: VaultDocument;
  vaultVersion: number;
  writeId: string;
  envelopeSha256: string;
}

export type VaultEnvelopeAuthenticator = (envelope: Uint8Array) => Promise<AuthenticatedVaultCopy>;

/** Authenticate/decrypt first, then fingerprint the exact opaque wire bytes. */
export function createVaultEnvelopeAuthenticator(
  vaultKey: VaultKeyMaterial,
): VaultEnvelopeAuthenticator {
  return async (envelope) => {
    const decrypted = await decryptVaultDocument(envelope, vaultKey);
    return {
      envelope: envelope.slice(),
      header: decrypted.header,
      document: decrypted.document,
      vaultVersion: decrypted.header.vaultVersion,
      writeId: decrypted.header.writeId,
      envelopeSha256: await sha256Hex(envelope),
    };
  };
}

export function copiesMatch(left: AuthenticatedVaultCopy, right: AuthenticatedVaultCopy): boolean {
  return (
    left.vaultVersion === right.vaultVersion &&
    left.writeId === right.writeId &&
    left.envelopeSha256 === right.envelopeSha256
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
