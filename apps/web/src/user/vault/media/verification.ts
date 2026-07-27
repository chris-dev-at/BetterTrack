import type { VaultMediaVerification } from '@bettertrack/contracts';

import { decryptVaultDocument, type VaultKeyMaterial } from '../crypto';

export interface AuthenticatedVaultCopy {
  envelope: Uint8Array;
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

export function mediaVerification(
  medium: 'server' | 'drive',
  copy: AuthenticatedVaultCopy,
  verifiedAt: string,
): VaultMediaVerification {
  return {
    medium,
    vaultVersion: copy.vaultVersion,
    envelopeSha256: copy.envelopeSha256,
    verifiedAt,
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
