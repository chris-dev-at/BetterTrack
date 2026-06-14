import { randomInt } from 'node:crypto';

// Unambiguous alphabet (no 0/O/1/l/I) so the one-time temp password is easy to
// read off and type.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** 16-char CSPRNG temp password, shown to the admin exactly once (§6.1). */
export function generateTempPassword(length = 16): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[randomInt(ALPHABET.length)];
  }
  return out;
}
