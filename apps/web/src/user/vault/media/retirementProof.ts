import {
  serializeRetiredServerPurgeTranscript,
  VAULT_DOCUMENT_VERSION,
  vaultClientSecuritySchema,
  type RetiredServerPurgeRequest,
  type VaultClientSecurity,
  type VaultDocument,
} from '@bettertrack/contracts';

import { VaultCryptoError } from '../errors';

const ED25519 = 'Ed25519';
const KEY_PAIR_CHECK = new TextEncoder().encode('bettertrack-retirement-proof-key-check-v1');

export interface VaultRetirementProofManager {
  readonly publicKey: string | null;
  /**
   * Import existing encrypted proof material or provision it once. A changed
   * document must be committed through the normal PD5 sync engine before media
   * transitions continue.
   */
  ensure(document: VaultDocument): Promise<{
    document: VaultDocument;
    changed: boolean;
  }>;
  sign(input: {
    retiredVersion: number;
    observedVersion: number;
    challenge: string;
  }): Promise<RetiredServerPurgeRequest['signature']>;
  clear(): void;
}

/**
 * Owns the in-memory Ed25519 signing capability. Exported private bytes exist
 * only while encrypted inside `VaultDocument.clientSecurity`; the BetterTrack
 * API receives just the public verifier header and signed purge transcript.
 */
export function createVaultRetirementProofManager(
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): VaultRetirementProofManager {
  let privateKey: CryptoKey | null = null;
  let publicKey: CryptoKey | null = null;
  let material: VaultClientSecurity | null = null;

  async function install(next: VaultClientSecurity): Promise<void> {
    const parsed = vaultClientSecuritySchema.parse(next);
    const [importedPrivate, importedPublic] = await Promise.all([
      subtle.importKey(
        'pkcs8',
        fromBase64url(parsed.retirementProof.privateKey),
        { name: ED25519 },
        false,
        ['sign'],
      ),
      subtle.importKey(
        'spki',
        fromBase64url(parsed.retirementProof.publicKey),
        { name: ED25519 },
        false,
        ['verify'],
      ),
    ]);
    const signature = await subtle.sign(ED25519, importedPrivate, KEY_PAIR_CHECK);
    if (!(await subtle.verify(ED25519, importedPublic, signature, KEY_PAIR_CHECK))) {
      throw new VaultCryptoError(
        'document-invalid',
        'Vault retirement proof key pair does not match.',
      );
    }
    privateKey = importedPrivate;
    publicKey = importedPublic;
    material = parsed;
  }

  return {
    get publicKey() {
      return material?.retirementProof.publicKey ?? null;
    },

    async ensure(document) {
      if (document.schemaVersion === VAULT_DOCUMENT_VERSION) {
        await install(document.clientSecurity);
        return { document, changed: false };
      }

      const pair = (await subtle.generateKey({ name: ED25519 }, true, [
        'sign',
        'verify',
      ])) as CryptoKeyPair;
      const [privateDer, publicDer] = await Promise.all([
        subtle.exportKey('pkcs8', pair.privateKey),
        subtle.exportKey('spki', pair.publicKey),
      ]);
      const clientSecurity = vaultClientSecuritySchema.parse({
        retirementProof: {
          privateKey: toBase64url(new Uint8Array(privateDer)),
          publicKey: toBase64url(new Uint8Array(publicDer)),
        },
      });
      await install(clientSecurity);
      return {
        changed: true,
        document: {
          ...document,
          schemaVersion: VAULT_DOCUMENT_VERSION,
          clientSecurity,
        },
      };
    },

    async sign(input) {
      if (privateKey == null || publicKey == null) {
        throw new VaultCryptoError('locked', 'Vault retirement proof key is unavailable.');
      }
      const transcript = serializeRetiredServerPurgeTranscript(input);
      return toBase64url(new Uint8Array(await subtle.sign(ED25519, privateKey, transcript)));
    },

    clear() {
      privateKey = null;
      publicKey = null;
      material = null;
    },
  };
}

function toBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch (cause) {
    throw new VaultCryptoError('document-invalid', 'Vault proof key is not valid base64url.', {
      cause,
    });
  }
}
