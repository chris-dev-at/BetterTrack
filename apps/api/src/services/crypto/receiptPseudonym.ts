import { createHmac, hkdfSync } from 'node:crypto';

import type { SecretBoxKey } from './secretBox';

/**
 * The pseudonym an acknowledged announcement receipt keeps after its account is
 * deleted (PROJECTPLAN §6.19.5, contract §7.5; Chief rulings 2026-10-29 and
 * 2026-10-30 — the keyed HMAC, not a random token).
 *
 * Exact construction, pinned by a published test vector in
 * `__tests__/receiptPseudonym.test.ts` so any other implementation can check
 * itself against this one:
 *
 *   key   = HKDF-SHA256(
 *             IKM  = the 32-byte ACTIVE stored-record encryption key
 *                    (`config.recordEncryption.active.key`, i.e. the key
 *                    `BT_DATA_ENCRYPTION_KEY` derives, #879),
 *             salt = empty (RFC 5869 §2.2: HashLen zero bytes),
 *             info = UTF-8 "bt-announcement-receipt-pseudonym-v1",
 *             L    = 32)
 *   token = lowercase hex of HMAC-SHA256(key, UTF-8 of the user id in its
 *           canonical form: 36 characters, lowercase, hyphenated)
 *
 * `keyId` is the record key's public id, stored as `subject_key_id`, so a
 * token can be re-confirmed after a rotation by whoever still holds that key.
 *
 * Properties the design relies on:
 *  • irreversible — HMAC under a secret key; the token reveals nothing about
 *    the user id without the key;
 *  • stable — one former account's rows all carry the same token;
 *  • confirmable only by the key holder — given a former user id (a dispute,
 *    a backup inside its retention window) the operator can recompute and
 *    compare; once a rotated-out key is discarded its tokens are unlinkable;
 *  • no new secret ships — the key is derived, domain-separated by `info`, so
 *    it can never collide with the record-encryption use of the same IKM.
 */
export const RECEIPT_PSEUDONYM_HKDF_INFO = 'bt-announcement-receipt-pseudonym-v1';
export const RECEIPT_PSEUDONYM_HKDF_SALT: Buffer = Buffer.alloc(0);

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ReceiptPseudonymizer {
  /** Written to `subject_key_id`. */
  readonly keyId: string;
  /** The 64-hex `subject_token` for a user id. */
  token(userId: string): string;
}

export function createReceiptPseudonymizer(active: SecretBoxKey): ReceiptPseudonymizer {
  const key = Buffer.from(
    hkdfSync(
      'sha256',
      active.key,
      RECEIPT_PSEUDONYM_HKDF_SALT,
      Buffer.from(RECEIPT_PSEUDONYM_HKDF_INFO, 'utf8'),
      32,
    ),
  );
  return {
    keyId: active.id,
    token(userId: string): string {
      const canonical = userId.toLowerCase();
      // Fail closed: a token over anything but the canonical id could never be
      // re-confirmed by recomputing it from the id on file.
      if (!CANONICAL_UUID.test(canonical)) {
        throw new Error('receipt pseudonym: user id is not a canonical UUID');
      }
      return createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
    },
  };
}
