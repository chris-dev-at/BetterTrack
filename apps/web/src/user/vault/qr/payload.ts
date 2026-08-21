import {
  VAULT_QR_SCHEME_PREFIX,
  vaultIdParamSchema,
  vaultKeyFingerprintSchema,
} from '@bettertrack/contracts';

import { mnemonicToEntropy, normalizeMnemonic } from '../bip39/mnemonic';

/** Keep E7's parser/serializer on E0's binding version marker. */
export const VAULT_TRANSFER_SCHEME = VAULT_QR_SCHEME_PREFIX;
export const VAULT_TRANSFER_NAME_MAX_CHARS = 64;

export const VAULT_TRANSFER_PAYLOAD_ERROR_OUTCOMES = [
  'update-required',
  'missing-mnemonic',
  'missing-vault-id',
  'invalid-mnemonic',
  'invalid-vault-id',
  'invalid-name',
  'invalid-fingerprint',
] as const;

export type VaultTransferPayloadErrorOutcome =
  (typeof VAULT_TRANSFER_PAYLOAD_ERROR_OUTCOMES)[number];

export class VaultTransferPayloadError extends Error {
  constructor(public readonly outcome: VaultTransferPayloadErrorOutcome) {
    super(`Vault transfer payload rejected: ${outcome}.`);
    this.name = 'VaultTransferPayloadError';
  }
}

export interface VaultTransferPayload {
  mnemonic: string;
  vaultId: string;
  name?: string;
  fingerprint?: string;
}

/**
 * The one E7 wire parser. Everything after the first colon is deliberately
 * parsed as application/x-www-form-urlencoded data, never as a URL authority.
 * Unknown keys are additive extensions and therefore ignored.
 */
export function parseVaultTransferPayload(payload: string): VaultTransferPayload {
  const separator = payload.indexOf(':');
  if (separator < 0 || payload.slice(0, separator + 1) !== VAULT_TRANSFER_SCHEME) {
    throw new VaultTransferPayloadError('update-required');
  }

  const query = new URLSearchParams(payload.slice(separator + 1));
  if (query.getAll('m').length > 1) {
    throw new VaultTransferPayloadError('invalid-mnemonic');
  }
  if (query.getAll('v').length > 1) {
    throw new VaultTransferPayloadError('invalid-vault-id');
  }
  const rawMnemonic = query.get('m');
  if (rawMnemonic == null || rawMnemonic === '') {
    throw new VaultTransferPayloadError('missing-mnemonic');
  }
  const rawVaultId = query.get('v');
  if (rawVaultId == null || rawVaultId === '') {
    throw new VaultTransferPayloadError('missing-vault-id');
  }

  const mnemonic = validatedMnemonic(rawMnemonic);
  const vaultId = validatedVaultId(rawVaultId);
  const name = query.get('n');
  const fingerprint = query.get('f');

  return {
    mnemonic,
    vaultId,
    ...(name == null ? {} : { name: validatedName(name) }),
    ...(fingerprint == null ? {} : { fingerprint: validatedFingerprint(fingerprint) }),
  };
}

/** Fixed-order serializer. URLSearchParams gives the binding form encoding (`+` for spaces). */
export function serializeVaultTransferPayload(input: VaultTransferPayload): string {
  const query = new URLSearchParams();
  query.set('m', validatedMnemonic(input.mnemonic));
  query.set('v', validatedVaultId(input.vaultId));
  if (input.name !== undefined) query.set('n', validatedName(input.name));
  if (input.fingerprint !== undefined) {
    query.set('f', validatedFingerprint(input.fingerprint));
  }
  return VAULT_TRANSFER_SCHEME + query.toString();
}

function validatedMnemonic(value: string): string {
  const normalized = normalizeMnemonic(value);
  let entropy: Uint8Array | undefined;
  try {
    entropy = mnemonicToEntropy(normalized);
    return normalized;
  } catch {
    throw new VaultTransferPayloadError('invalid-mnemonic');
  } finally {
    entropy?.fill(0);
  }
}

function validatedVaultId(value: string): string {
  if (value !== value.toLowerCase() || !vaultIdParamSchema.safeParse({ vaultId: value }).success) {
    throw new VaultTransferPayloadError('invalid-vault-id');
  }
  return value;
}

function validatedName(value: string): string {
  if ([...value].length > VAULT_TRANSFER_NAME_MAX_CHARS) {
    throw new VaultTransferPayloadError('invalid-name');
  }
  return value;
}

function validatedFingerprint(value: string): string {
  if (!vaultKeyFingerprintSchema.safeParse(value).success) {
    throw new VaultTransferPayloadError('invalid-fingerprint');
  }
  return value;
}
