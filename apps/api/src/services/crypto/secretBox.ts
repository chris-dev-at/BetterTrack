import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated symmetric encryption for small secrets stored at rest
 * (PROJECTPLAN.md §6.1, §10) — used to keep a user's TOTP secret out of the
 * database in plaintext. AES-256-GCM with a random 96-bit IV per message; the
 * serialized form is `v1.<iv>.<authTag>.<ciphertext>`, each field base64url.
 * The version prefix leaves room to rotate the scheme later.
 */
const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

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

/** Encrypt `plaintext` with a 32-byte key, returning the serialized envelope. */
export function encryptSecret(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`secretBox key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}. Throws on a malformed
 * envelope, a wrong key, or tampering (GCM auth-tag mismatch) — callers treat a
 * throw as "no usable secret".
 */
export function decryptSecret(envelope: string, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error(`secretBox key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('secretBox: malformed envelope');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const iv = decodeEnvelopePart(ivB64, IV_BYTES);
  const authTag = decodeEnvelopePart(tagB64, AUTH_TAG_BYTES);
  const ciphertext = decodeEnvelopePart(dataB64);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
