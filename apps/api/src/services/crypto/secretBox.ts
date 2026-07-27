import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated symmetric encryption for small secrets stored at rest
 * (PROJECTPLAN.md §6.1, §10). AES-256-GCM with a random 96-bit IV per message.
 *
 * Current envelopes are
 * `v2.<keyId>.<iv>.<authTag>.<ciphertext>` (binary fields are base64url). The
 * non-secret key id is authenticated as GCM additional data so it cannot be
 * swapped independently of the ciphertext. The original
 * `v1.<iv>.<authTag>.<ciphertext>` form remains readable during migration.
 */
const LEGACY_VERSION = 'v1';
const VERSION = 'v2';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface SecretBoxKey {
  /** Public identifier serialized into v2 envelopes; never key material. */
  id: string;
  /** Raw 32-byte AES key. */
  key: Buffer;
}

export interface SecretBoxKeyring {
  /** Key used for every new write. */
  active: SecretBoxKey;
  /** Active + transition keys indexed by their public ids. */
  keys: ReadonlyMap<string, Buffer>;
  /** Ordered candidates for identifier-free v1 envelopes. */
  legacyKeys: readonly Buffer[];
}

export interface CreateSecretBoxKeyringInput {
  active: SecretBoxKey;
  previous?: readonly SecretBoxKey[];
  legacyKeys?: readonly Buffer[];
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`secretBox key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

function assertKeyId(keyId: string): void {
  if (!KEY_ID.test(keyId)) {
    throw new Error('secretBox: invalid key id');
  }
}

/**
 * Build an immutable-by-convention keyring. Duplicate ids are rejected instead
 * of silently selecting one key during a rotation.
 */
export function createSecretBoxKeyring(input: CreateSecretBoxKeyringInput): SecretBoxKeyring {
  assertKeyId(input.active.id);
  assertKey(input.active.key);

  const keys = new Map<string, Buffer>();
  for (const entry of [input.active, ...(input.previous ?? [])]) {
    assertKeyId(entry.id);
    assertKey(entry.key);
    if (keys.has(entry.id)) {
      throw new Error('secretBox: duplicate key id');
    }
    keys.set(entry.id, entry.key);
  }

  const legacyKeys: Buffer[] = [];
  for (const key of [...keys.values(), ...(input.legacyKeys ?? [])]) {
    assertKey(key);
    if (!legacyKeys.some((candidate) => candidate.equals(key))) {
      legacyKeys.push(key);
    }
  }

  return {
    active: input.active,
    keys,
    legacyKeys,
  };
}

function decodeEnvelopePart(value: string, expectedBytes?: number): Buffer {
  if (!BASE64URL.test(value)) {
    throw new Error('secretBox: malformed envelope');
  }

  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    throw new Error('secretBox: malformed envelope');
  }

  return decoded;
}

function isKeyring(value: Buffer | SecretBoxKeyring): value is SecretBoxKeyring {
  return !Buffer.isBuffer(value);
}

function seal(
  plaintext: string,
  key: Buffer,
  prefix: readonly string[],
  authenticatedHeader?: string,
): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (authenticatedHeader) {
    cipher.setAAD(Buffer.from(authenticatedHeader, 'utf8'));
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    ...prefix,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Encrypt a secret. Passing a keyring writes the current v2 envelope; the Buffer
 * overload intentionally retains the v1 writer for compatibility with
 * out-of-scope callers and for migration fixtures.
 */
export function encryptSecret(plaintext: string, key: Buffer): string;
export function encryptSecret(plaintext: string, keyring: SecretBoxKeyring): string;
export function encryptSecret(plaintext: string, keyOrKeyring: Buffer | SecretBoxKeyring): string {
  if (!isKeyring(keyOrKeyring)) {
    return seal(plaintext, keyOrKeyring, [LEGACY_VERSION]);
  }

  const { id, key } = keyOrKeyring.active;
  assertKeyId(id);
  return seal(plaintext, key, [VERSION, id], `${VERSION}.${id}`);
}

function open(
  ivB64: string,
  tagB64: string,
  dataB64: string,
  key: Buffer,
  authenticatedHeader?: string,
): string {
  assertKey(key);
  const iv = decodeEnvelopePart(ivB64, IV_BYTES);
  const authTag = decodeEnvelopePart(tagB64, AUTH_TAG_BYTES);
  const ciphertext = decodeEnvelopePart(dataB64);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    if (authenticatedHeader) {
      decipher.setAAD(Buffer.from(authenticatedHeader, 'utf8'));
    }
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error('secretBox: authentication failed');
  }
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}. Throws on a malformed
 * envelope, a wrong key, or tampering (GCM auth-tag mismatch) — callers treat a
 * throw as "no usable secret".
 */
export function decryptSecret(envelope: string, key: Buffer): string;
export function decryptSecret(envelope: string, keyring: SecretBoxKeyring): string;
export function decryptSecret(envelope: string, keyOrKeyring: Buffer | SecretBoxKeyring): string {
  const parts = envelope.split('.');

  if (parts[0] === VERSION) {
    if (parts.length !== 5) {
      throw new Error('secretBox: malformed envelope');
    }
    const [, keyId, ivB64, tagB64, dataB64] = parts as [string, string, string, string, string];
    assertKeyId(keyId);
    if (!isKeyring(keyOrKeyring)) {
      throw new Error('secretBox: unknown key');
    }
    const key = keyOrKeyring.keys.get(keyId);
    if (!key) {
      throw new Error('secretBox: unknown key');
    }
    return open(ivB64, tagB64, dataB64, key, `${VERSION}.${keyId}`);
  }

  if (parts.length !== 4 || parts[0] !== LEGACY_VERSION) {
    throw new Error('secretBox: malformed envelope');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  // Validate structural fields once, outside the candidate loop. Malformed
  // envelopes and invalid direct keys remain distinguishable from a valid
  // envelope that simply authenticates under none of the configured keys.
  decodeEnvelopePart(ivB64, IV_BYTES);
  decodeEnvelopePart(tagB64, AUTH_TAG_BYTES);
  decodeEnvelopePart(dataB64);
  if (!isKeyring(keyOrKeyring)) {
    assertKey(keyOrKeyring);
  }
  const candidates = isKeyring(keyOrKeyring) ? keyOrKeyring.legacyKeys : [keyOrKeyring];
  for (const key of candidates) {
    try {
      return open(ivB64, tagB64, dataB64, key);
    } catch {
      // Identifier-free v1 records require trying the ordered legacy candidates.
    }
  }
  throw new Error('secretBox: authentication failed');
}

/**
 * Return a v2 envelope's key id, or null for a structurally valid legacy v1
 * envelope. This only inspects the non-secret header; callers must still decrypt
 * before trusting or replacing the record.
 */
export function secretEnvelopeKeyId(envelope: string): string | null {
  const parts = envelope.split('.');
  if (parts[0] === VERSION && parts.length === 5) {
    const keyId = parts[1]!;
    assertKeyId(keyId);
    return keyId;
  }
  if (parts[0] === LEGACY_VERSION && parts.length === 4) {
    return null;
  }
  throw new Error('secretBox: malformed envelope');
}
