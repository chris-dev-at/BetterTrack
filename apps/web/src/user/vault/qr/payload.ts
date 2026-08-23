import {
  VAULT_QR_SCHEME_PREFIX,
  vaultIdParamSchema,
  vaultKeyFingerprintSchema,
} from '@bettertrack/contracts';

import { mnemonicToEntropy, normalizeMnemonic } from '../bip39/mnemonic';

/** Keep E7's parser/serializer on E0's binding version marker. */
export const VAULT_TRANSFER_SCHEME = VAULT_QR_SCHEME_PREFIX;
export const VAULT_TRANSFER_NAME_MAX_CHARS = 64;

/**
 * §13's scannable ceiling, in WIRE BYTES rather than code points ("~150–220
 * chars … a comfortably scannable version-7-ish code"). The wire still accepts
 * any 64-code-point `n` hint — a receiver must parse what another client sent —
 * but a sender must not emit one: vault names are cleartext free-form (§21 Q4),
 * so 64 emoji percent-encode to a ~933-byte payload, which at the fixed 280 px
 * render is ~2.2 px per module and realistically unscannable.
 */
export const VAULT_TRANSFER_PAYLOAD_MAX_BYTES = 220;

export const VAULT_TRANSFER_PAYLOAD_ERROR_OUTCOMES = [
  'not-a-bettertrack-code',
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
  const version =
    separator < 0 ? undefined : /^btvault(\d+):$/.exec(payload.slice(0, separator + 1))?.[1];
  if (version === undefined) {
    throw new VaultTransferPayloadError('not-a-bettertrack-code');
  }
  if (Number(version) > 1) {
    throw new VaultTransferPayloadError('update-required');
  }
  if (version !== '1') {
    throw new VaultTransferPayloadError('not-a-bettertrack-code');
  }

  const body = payload.slice(separator + 1);
  if (body.startsWith('?')) {
    // URLSearchParams strips one leading '?', which would silently accept a
    // URL-shaped body; the query delimiter is never form-encoded data.
    throw new VaultTransferPayloadError('missing-mnemonic');
  }
  const query = new URLSearchParams(body);
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
  const name = query.get('n')?.trim();
  const fingerprint = query.get('f');

  return {
    mnemonic,
    vaultId,
    ...(name ? { name: validatedName(name) } : {}),
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

/** Wire length of a serialized payload; the QR encodes it in UTF-8 byte mode. */
export function vaultTransferPayloadByteLength(payload: string): number {
  return new TextEncoder().encode(payload).length;
}

/**
 * The sender's serializer. `n` is a display convenience, so it is dropped —
 * never the required members, and never as a hard failure — whenever keeping it
 * would push the code past {@link VAULT_TRANSFER_PAYLOAD_MAX_BYTES} or past the
 * wire's 64-code-point name limit. A legal vault name must never be able to
 * produce a code the receiving phone cannot read.
 */
export function serializeVaultTransferPayloadWithinBudget(input: VaultTransferPayload): string {
  if (input.name !== undefined) {
    try {
      const withHint = serializeVaultTransferPayload(input);
      if (vaultTransferPayloadByteLength(withHint) <= VAULT_TRANSFER_PAYLOAD_MAX_BYTES) {
        return withHint;
      }
    } catch (cause) {
      if (!(cause instanceof VaultTransferPayloadError) || cause.outcome !== 'invalid-name') {
        throw cause;
      }
    }
  }
  const { name: _droppedHint, ...required } = input;
  return serializeVaultTransferPayload(required);
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
