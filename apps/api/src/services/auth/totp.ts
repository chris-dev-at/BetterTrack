import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Pure TOTP + recovery-code primitives (RFC 6238 / RFC 4226), no I/O — the
 * two-factor keystone for §6.1 (§13.2 V2-P5). Kept side-effect-free and
 * deterministic (every time-dependent function takes an explicit `now`) so the
 * skew window, code generation and verification are exhaustively unit-testable.
 */

// Standard authenticator defaults: 6 digits, 30-second step, SHA-1.
export const TOTP_DIGITS = 6;
export const TOTP_STEP_SECONDS = 30;
// Accept the code from one step on either side of "now" (±30 s) so a code typed
// as it rolls over, or minor client/server clock drift, still verifies.
export const TOTP_SKEW_STEPS = 1;
// 20 bytes = 160 bits, the RFC 4226 recommended SHA-1 secret size.
const SECRET_BYTES = 20;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 encode (no padding) — the encoding authenticator apps expect. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** RFC 4648 base32 decode. Case-insensitive; padding and stray chars ignored. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generate a fresh base32 TOTP secret (160-bit). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The `otpauth://totp/...` provisioning URI an authenticator app scans as a QR. */
export function buildOtpauthUri(params: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const { secret, accountName, issuer } = params;
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** The HOTP value for a given counter (RFC 4226 dynamic truncation). */
function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  // Counters comfortably fit 53-bit safe integers for any realistic time; write
  // the high/low 32-bit halves so the full 64-bit counter is represented.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const digest = createHmac('sha1', secret).update(buf).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte selects a
  // 4-byte offset; mask the high bit for a positive 31-bit integer.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

/** The current TOTP code for a base32 secret at time `nowMs` (defaults to now). */
export function generateTotpCode(secret: string, nowMs: number = Date.now()): string {
  const counter = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  return hotp(base32Decode(secret), counter, TOTP_DIGITS);
}

/**
 * Verify a user-supplied code against the secret, accepting ±{@link TOTP_SKEW_STEPS}
 * time steps. Constant-time per candidate; a non-numeric / wrong-length code is
 * rejected outright.
 */
export function verifyTotp(secret: string, code: string, nowMs: number = Date.now()): boolean {
  const trimmed = code.trim();
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(trimmed)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset += 1) {
    const candidate = hotp(key, counter + offset, TOTP_DIGITS);
    const a = Buffer.from(candidate);
    const b = Buffer.from(trimmed);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

// ── Recovery codes ──────────────────────────────────────────────────────────

export const RECOVERY_CODE_COUNT = 10;
// 10 random bytes → 16 base32 chars → 80 bits of entropy per code, plenty for a
// single-use, SHA-256-hashed secret; formatted in dashed groups for legibility.
const RECOVERY_CODE_BYTES = 10;

/** A single formatted recovery code, e.g. `abcd-efgh-ijkl-mnop`. */
export function generateRecoveryCode(): string {
  const raw = base32Encode(randomBytes(RECOVERY_CODE_BYTES)).toLowerCase();
  return (raw.match(/.{1,4}/g) ?? [raw]).join('-');
}

/** A fresh batch of {@link RECOVERY_CODE_COUNT} recovery codes. */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, generateRecoveryCode);
}

/** Canonical form for hashing/compare: lowercase, dashes and spaces stripped. */
export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[\s-]/g, '');
}
