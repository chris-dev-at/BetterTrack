import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RECEIPT_PSEUDONYM_HKDF_INFO, createReceiptPseudonymizer } from '../receiptPseudonym';

/**
 * The published test vector of the receipt pseudonym (§6.19.5, contract §7.5;
 * CEO addendum 2026-10-30: "pin the HKDF salt and the byte encoding with a
 * fixed vector so T2-B/UI and the mobile team can verify it").
 *
 *   IKM   = 00 01 02 … 1f (32 bytes)
 *   salt  = empty
 *   info  = "bt-announcement-receipt-pseudonym-v1"
 *   key   = 7c5ecb143644a467b966721d77062a4978bab1a3f2eb70373c117a2420e1f80f
 *   token("01975600-0000-7000-8000-000000000001")
 *         = b956943dbe26de51bc71d0ec0e770f153cd2e8ac95f829af6189523d271da95a
 *
 * The expected values were computed once with node:crypto and cross-checked
 * against an independent RFC 5869 implementation (Python hmac/hashlib, salt =
 * 32 zero bytes, one expand block). They are literals here on purpose: a test
 * that recomputed them with the code under test would pass any construction.
 */
const IKM = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const DERIVED_KEY = '7c5ecb143644a467b966721d77062a4978bab1a3f2eb70373c117a2420e1f80f';
const USER_1 = '01975600-0000-7000-8000-000000000001';
const USER_2 = '01975600-0000-7000-8000-000000000002';
const TOKEN_1 = 'b956943dbe26de51bc71d0ec0e770f153cd2e8ac95f829af6189523d271da95a';
const TOKEN_2 = '6f99cd04d6f40abda5a17f2e02cf7a491d846c26668c30d000e1165bd28e4f0a';

describe('receipt pseudonym (HKDF-SHA256 → HMAC-SHA256)', () => {
  const pseudonymizer = createReceiptPseudonymizer({ id: 'vector-v1', key: IKM });

  it('matches the published vector byte for byte', () => {
    expect(pseudonymizer.token(USER_1)).toBe(TOKEN_1);
    expect(pseudonymizer.token(USER_2)).toBe(TOKEN_2);
    expect(pseudonymizer.keyId).toBe('vector-v1');
  });

  it('the vector key is the HKDF output: HMAC under it reproduces the token', () => {
    expect(RECEIPT_PSEUDONYM_HKDF_INFO).toBe('bt-announcement-receipt-pseudonym-v1');
    const recomputed = createHmac('sha256', Buffer.from(DERIVED_KEY, 'hex'))
      .update(USER_1, 'utf8')
      .digest('hex');
    expect(recomputed).toBe(TOKEN_1);
  });

  it('is stable per user, canonicalises case, and differs between users', () => {
    expect(pseudonymizer.token(USER_1.toUpperCase())).toBe(TOKEN_1);
    expect(pseudonymizer.token(USER_1)).toBe(pseudonymizer.token(USER_1));
    expect(TOKEN_1).not.toBe(TOKEN_2);
    expect(TOKEN_1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a different record key yields an unrelated token (rotation unlinks)', () => {
    const rotated = createReceiptPseudonymizer({ id: 'vector-v2', key: Buffer.alloc(32, 0xff) });
    expect(rotated.token(USER_1)).not.toBe(TOKEN_1);
    expect(rotated.keyId).toBe('vector-v2');
  });

  it('is domain-separated from the raw key: it is not a plain HMAC under the IKM', () => {
    const naive = createHmac('sha256', IKM).update(USER_1, 'utf8').digest('hex');
    expect(naive).not.toBe(TOKEN_1);
  });

  it('refuses anything that is not a canonical UUID', () => {
    expect(() => pseudonymizer.token('not-a-uuid')).toThrow(/canonical UUID/);
    expect(() => pseudonymizer.token(` ${USER_1}`)).toThrow(/canonical UUID/);
    expect(() => pseudonymizer.token('01975600000070008000000000000001')).toThrow(/canonical UUID/);
  });
});
