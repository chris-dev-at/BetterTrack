import { createHash, randomBytes } from 'node:crypto';

/**
 * Invite/share token helper (PROJECTPLAN.md §10): 256-bit CSPRNG, url-safe.
 * Only the SHA-256 hash is persisted; the raw token is shown once and never logged.
 */
export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * SHA-256 of a value, base64url-encoded — the PKCE `S256` transform (RFC 7636):
 * `code_challenge == base64url(sha256(code_verifier))`.
 */
export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
