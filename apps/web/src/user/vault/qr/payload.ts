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
  // Our own scheme in an obsolete shape: a `btvault1:` body that is JSON (the
  // pre-form-encoding wire format) rather than form-encoded data.
  'legacy-code',
  // The structural residual: the prefix is ours and the version is one we
  // speak, but the body does not obey the grammar. Distinct from the
  // `missing-*` outcomes, which mean a well-formed body is short a key —
  // reporting a grammar break as a missing key makes the answer depend on
  // which key the parser happened to read first. Now that `duplicate-key`
  // and `legacy-code` are split out, this is rare.
  'malformed',
  'missing-mnemonic',
  'missing-vault-id',
  // A repeat of ANY known key (`m`, `v`, `n`, `f`) — the payload is
  // untrustworthy as a whole, so this wins over every other outcome,
  // including `missing-*`. Unknown keys stay ignored no matter how often
  // they repeat.
  'duplicate-key',
  'invalid-mnemonic',
  'invalid-vault-id',
  'invalid-fingerprint',
  'name-too-long',
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
 * The version token is a CANONICAL decimal integer — `^[1-9][0-9]*$`, no
 * leading zeros, no zero. `btvault1:` is ours; a canonical token above 1 is a
 * newer BetterTrack; `btvault0:`, `btvault01:`, `btvault007:` and `btvault02:`
 * are simply not BetterTrack codes. Pinning the SHAPE is what keeps every
 * client's answer identical: a parser that runs its integer conversion first
 * (JS `Number`, Kotlin `toInt`) silently accepts the padded forms.
 */
const VAULT_TRANSFER_VERSION_TOKEN = /^btvault([1-9][0-9]*):$/;

/**
 * The one E7 wire parser. Everything after the first colon is deliberately
 * parsed as application/x-www-form-urlencoded data, never as a URL authority.
 * Unknown keys are additive extensions and therefore ignored.
 */
export function parseVaultTransferPayload(payload: string): VaultTransferPayload {
  const separator = payload.indexOf(':');
  const version =
    separator < 0
      ? undefined
      : VAULT_TRANSFER_VERSION_TOKEN.exec(payload.slice(0, separator + 1))?.[1];
  // Shape BEFORE value. A token that is not a canonical decimal integer is not
  // a version we ever minted, so it is not our code — never an "update the app"
  // prompt for a code no BetterTrack client can emit. Comparing `Number(token)`
  // instead would read `btvault02:` as 2 and send this user to the app store
  // while `btvault01:` read as foreign, which is the inconsistency this fixes.
  if (version === undefined) {
    throw new VaultTransferPayloadError('not-a-bettertrack-code');
  }
  if (version !== '1') {
    throw new VaultTransferPayloadError('update-required');
  }

  const body = payload.slice(separator + 1);
  // A leading `{` (after optional whitespace) is our OWN pre-form-encoding
  // wire shape, not foreign input — mirrors the Android heuristic (#83) so
  // both clients agree on which bodies are `legacy-code` versus `malformed`.
  if (/^\s*\{/.test(body)) {
    throw new VaultTransferPayloadError('legacy-code');
  }
  if (body.startsWith('?')) {
    // URLSearchParams strips one leading '?', which would silently accept a
    // URL-shaped body; the query delimiter is never form-encoded data. This is
    // a break in the body GRAMMAR, so it is `malformed` — answering with the
    // first key that then came up missing made the outcome depend on whether
    // the sender wrote `?m=…&v=…` or `?v=…&m=…`.
    throw new VaultTransferPayloadError('malformed');
  }
  const query = new URLSearchParams(body);
  // A repeat of any KNOWN key makes the whole payload untrustworthy, so this
  // runs before every other check — including the missing-key checks below —
  // and wins regardless of what else is wrong with the payload. Unknown keys
  // are additive extensions and stay ignored no matter how often they repeat.
  for (const knownKey of ['m', 'v', 'n', 'f']) {
    if (query.getAll(knownKey).length > 1) {
      throw new VaultTransferPayloadError('duplicate-key');
    }
  }
  const rawMnemonic = query.get('m');
  if (rawMnemonic == null || isBlankTransferToken(rawMnemonic)) {
    throw new VaultTransferPayloadError('missing-mnemonic');
  }
  const rawVaultId = query.get('v');
  if (rawVaultId == null || isBlankTransferToken(rawVaultId)) {
    throw new VaultTransferPayloadError('missing-vault-id');
  }

  const mnemonic = validatedMnemonic(rawMnemonic);
  const vaultId = validatedVaultId(rawVaultId);
  // Trim FIRST, then cap: a name already at the 64-code-point limit must
  // survive being padded on the wire, not fail the whole transfer.
  const name = trimTransferName(query.get('n') ?? '');
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
      if (!(cause instanceof VaultTransferPayloadError) || cause.outcome !== 'name-too-long') {
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

/**
 * The normative trim set for the optional `n` display hint: Unicode
 * White_Space ∪ the C0/C1 controls ∪ U+FEFF.
 *
 * Deliberately NOT `String.prototype.trim`. ECMAScript's trim strips U+FEFF
 * but leaves U+001C–U+001F standing; Kotlin's `trim()`/`Char.isWhitespace()`
 * does the exact opposite. Either host's built-in therefore makes the two
 * clients disagree about whether a scanned code carries a name at all, so the
 * wire names the set explicitly and every client implements it. This set is a
 * strict superset of both built-ins, so nothing either runtime already trims
 * survives it.
 *
 * U+FEFF is listed by hand: it is category Cf with White_Space=No, so no
 * Unicode property covers it — it is in the set because it is what ECMAScript
 * trims, and because a zero-width no-break space is never legitimate name
 * content at the boundary (the same reasoning as the render sanitizer).
 */
const VAULT_TRANSFER_NAME_TRIM_CODE_POINT = /^[\p{White_Space}\p{Cc}\uFEFF]$/u;

/** Explicit membership test, so the wire rule is one greppable predicate. */
function isNameTrimCodePoint(codePoint: string): boolean {
  return VAULT_TRANSFER_NAME_TRIM_CODE_POINT.test(codePoint);
}

/**
 * Same blank-is-absent principle as the `n` trim, applied to the two REQUIRED
 * values: a whitespace-only `m` or `v` (e.g. `m=+`) is a missing key, not an
 * invalid one — the sender wrote nothing meaningful, so the answer should
 * name what is absent rather than what failed to validate.
 */
function isBlankTransferToken(value: string): boolean {
  return [...value].every(isNameTrimCodePoint);
}

/**
 * Trim only the EDGES, counted in CODE POINTS (the same unit as the 64-code-
 * point cap). Interior code points are preserved verbatim — the wire carries
 * what the sender wrote, and stripping controls out of the middle is the
 * render sanitizer's job, not the parser's. A name made only of trim-set code
 * points comes back empty and is therefore ABSENT.
 */
function trimTransferName(value: string): string {
  const codePoints = [...value];
  let start = 0;
  let end = codePoints.length;
  while (start < end && isNameTrimCodePoint(codePoints[start] as string)) start += 1;
  while (end > start && isNameTrimCodePoint(codePoints[end - 1] as string)) end -= 1;
  return codePoints.slice(start, end).join('');
}

function validatedName(value: string): string {
  if ([...value].length > VAULT_TRANSFER_NAME_MAX_CHARS) {
    throw new VaultTransferPayloadError('name-too-long');
  }
  return value;
}

function validatedFingerprint(value: string): string {
  if (!vaultKeyFingerprintSchema.safeParse(value).success) {
    throw new VaultTransferPayloadError('invalid-fingerprint');
  }
  return value;
}
