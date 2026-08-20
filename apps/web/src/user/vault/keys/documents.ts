import { deflateSync, inflateSync } from 'fflate';

import {
  VAULT_CONTENT_CIPHER,
  VAULT_DOC_FORMAT_VERSION,
  encodeVaultDocEnvelope,
  inspectVaultDocEnvelope,
  serializeVaultDocHeader,
  vaultHeaderDocSchema,
  type VaultDocEnvelopeHeader,
  type VaultDocKind,
  type VaultHeaderDoc,
  type VaultKeyFingerprint,
} from '@bettertrack/contracts';

import { zeroBytes } from '../bytes';
import {
  VAULT_IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  secureRandomBytes,
  type RandomBytes,
} from '../crypto';
import { decodeBase64Url, encodeBase64Url } from './base64url';
import { VaultKeyCoreError, asVaultKeyCoreError } from './errors';
import { openVaultKey, selectActiveSeedKeySlot } from './keyCore';

export type VaultDocHeaderInput = Omit<VaultDocEnvelopeHeader, 'formatVersion' | 'cipher' | 'iv'>;

export interface EncryptVaultDocInput {
  plaintext: Uint8Array;
  contentKey: Uint8Array;
  header: VaultDocHeaderInput;
  randomBytes?: RandomBytes;
}

export interface EncryptedVaultDoc {
  envelope: Uint8Array;
  header: VaultDocEnvelopeHeader;
}

export interface ExpectedVaultDocHeader {
  vaultId?: string;
  docId?: string;
  docKind?: VaultDocKind;
  accountBinding?: string;
  docVersion?: number;
  keyId?: string;
}

export interface DecryptedVaultDoc {
  plaintext: Uint8Array;
  header: VaultDocEnvelopeHeader;
}

export interface VerifiedVaultHeaderOpen extends DecryptedVaultDoc {
  document: VaultHeaderDoc;
  vaultId: string;
  keyId: string;
  keyFingerprint: VaultKeyFingerprint;
  /** Ownership transfers to the caller/session and must be zeroed on lock. */
  contentKey: Uint8Array;
}

export async function encryptVaultDoc(input: EncryptVaultDocInput): Promise<EncryptedVaultDoc> {
  selectActiveSeedKeySlot(input.header.keySlots, input.header.keyId);
  const iv = (input.randomBytes ?? secureRandomBytes)(VAULT_IV_BYTES);
  let compressed: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  let headerBytes: Uint8Array | undefined;
  try {
    if (!(iv instanceof Uint8Array) || iv.length !== VAULT_IV_BYTES) {
      throw new VaultKeyCoreError('envelope-invalid', 'Vault document IV must be 96 bits.');
    }
    const header: VaultDocEnvelopeHeader = {
      ...input.header,
      formatVersion: VAULT_DOC_FORMAT_VERSION,
      cipher: VAULT_CONTENT_CIPHER,
      iv: encodeBase64Url(iv),
    };
    // Writer AAD is exactly the contract serializer's canonical byte output.
    headerBytes = serializeVaultDocHeader(header);
    compressed = deflateSync(input.plaintext);
    ciphertext = await aesGcmEncrypt(input.contentKey, iv, compressed, headerBytes);
    return { header, envelope: encodeVaultDocEnvelope(header, ciphertext) };
  } catch (cause) {
    throw asVaultKeyCoreError(
      'authentication-failed',
      'Could not encrypt the vault document.',
      cause,
    );
  } finally {
    if (iv instanceof Uint8Array) zeroBytes(iv);
    if (compressed != null) zeroBytes(compressed);
    if (ciphertext != null) zeroBytes(ciphertext);
    if (headerBytes != null) zeroBytes(headerBytes);
  }
}

export async function decryptVaultDoc(input: {
  envelope: Uint8Array;
  contentKey: Uint8Array;
  expected?: ExpectedVaultDocHeader;
}): Promise<DecryptedVaultDoc> {
  let inspected: ReturnType<typeof inspectVaultDocEnvelope>;
  try {
    inspected = inspectVaultDocEnvelope(input.envelope);
  } catch (cause) {
    throw asVaultKeyCoreError('envelope-invalid', 'Vault document envelope is invalid.', cause);
  }
  if (inspected.status === 'update-required') {
    throw new VaultKeyCoreError(
      'update-required',
      'This vault document was written by a newer app version.',
    );
  }

  const iv = decodeBase64Url(inspected.header.iv);
  let compressed: Uint8Array | undefined;
  try {
    if (iv.length !== VAULT_IV_BYTES) {
      throw new VaultKeyCoreError('envelope-invalid', 'Vault document IV must be 96 bits.');
    }
    try {
      // Binding rule: authenticate the untouched wire bytes returned by the
      // inspector. A parsed-header reserialization is never used on reads.
      compressed = await aesGcmDecrypt(
        input.contentKey,
        iv,
        inspected.ciphertext,
        inspected.headerBytes,
      );
    } catch (cause) {
      throw asVaultKeyCoreError(
        'authentication-failed',
        'Could not authenticate the vault document.',
        cause,
      );
    }
    selectActiveSeedKeySlot(inspected.header.keySlots, inspected.header.keyId);
    assertExpectedHeader(inspected.header, input.expected);
    let inflated: Uint8Array | undefined;
    try {
      inflated = inflateSync(compressed);
      // fflate may reuse an input allocation for some DEFLATE block shapes.
      // Transfer an independent buffer before the compressed input is wiped.
      return { header: inspected.header, plaintext: inflated.slice() };
    } catch (cause) {
      throw new VaultKeyCoreError('document-invalid', 'Vault document compression is invalid.', {
        cause,
      });
    } finally {
      if (inflated != null) zeroBytes(inflated);
    }
  } finally {
    zeroBytes(iv);
    if (compressed != null) zeroBytes(compressed);
  }
}

/**
 * Proves words open the authenticated header document. E7/E8 must call this
 * before handing the result to endpoint-keystore persistence.
 */
export async function openVaultHeaderWithMnemonic(input: {
  envelope: Uint8Array;
  mnemonic: string;
  expectedVaultId: string;
  expectedFingerprint?: VaultKeyFingerprint;
}): Promise<VerifiedVaultHeaderOpen> {
  let inspected: ReturnType<typeof inspectVaultDocEnvelope>;
  try {
    inspected = inspectVaultDocEnvelope(input.envelope);
  } catch (cause) {
    throw asVaultKeyCoreError('envelope-invalid', 'Vault header envelope is invalid.', cause);
  }
  if (inspected.status === 'update-required') {
    throw new VaultKeyCoreError('update-required', 'The vault header needs a newer app version.');
  }
  if (inspected.header.vaultId !== input.expectedVaultId || inspected.header.docKind !== 'header') {
    throw new VaultKeyCoreError(
      'envelope-invalid',
      'Envelope is not the requested vault header document.',
    );
  }

  const opened = await openVaultKey({
    mnemonic: input.mnemonic,
    vaultId: inspected.header.vaultId,
    keyId: inspected.header.keyId,
    keySlots: inspected.header.keySlots,
    expectedFingerprint: input.expectedFingerprint,
  });
  let decrypted: DecryptedVaultDoc | undefined;
  try {
    decrypted = await decryptVaultDoc({
      envelope: input.envelope,
      contentKey: opened.contentKey,
      expected: {
        vaultId: input.expectedVaultId,
        docKind: 'header',
        keyId: inspected.header.keyId,
      },
    });
    const document = parseHeaderDocument(decrypted.plaintext);
    selectActiveSeedKeySlot(document.keySlots, inspected.header.keyId);
    if (!equalKeySlots(inspected.header.keySlots, document.keySlots)) {
      throw new VaultKeyCoreError(
        'document-invalid',
        'Vault header key-slot echo does not exactly match its envelope.',
      );
    }
    return {
      ...decrypted,
      document,
      vaultId: inspected.header.vaultId,
      keyId: inspected.header.keyId,
      keyFingerprint: opened.keyFingerprint,
      contentKey: opened.contentKey,
    };
  } catch (cause) {
    if (decrypted != null) zeroBytes(decrypted.plaintext);
    zeroBytes(opened.contentKey);
    throw cause;
  }
}

function equalKeySlots(
  left: readonly { keyId: string; slot: string; wrappedKc: string }[],
  right: readonly { keyId: string; slot: string; wrappedKc: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (slot, index) =>
        slot.keyId === right[index]?.keyId &&
        slot.slot === right[index]?.slot &&
        slot.wrappedKc === right[index]?.wrappedKc,
    )
  );
}

function parseHeaderDocument(plaintext: Uint8Array): VaultHeaderDoc {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch (cause) {
    throw new VaultKeyCoreError('document-invalid', 'Vault header is not valid UTF-8 JSON.', {
      cause,
    });
  }
  const parsed = vaultHeaderDocSchema.safeParse(value);
  if (!parsed.success) {
    throw new VaultKeyCoreError(
      'document-invalid',
      'Vault header document does not match the current schema.',
    );
  }
  return parsed.data;
}

function assertExpectedHeader(
  header: VaultDocEnvelopeHeader,
  expected: ExpectedVaultDocHeader | undefined,
): void {
  if (expected == null) return;
  for (const key of [
    'vaultId',
    'docId',
    'docKind',
    'accountBinding',
    'docVersion',
    'keyId',
  ] as const) {
    if (expected[key] !== undefined && expected[key] !== header[key]) {
      throw new VaultKeyCoreError(
        'envelope-invalid',
        `Vault document ${key} does not match the expected value.`,
      );
    }
  }
}
