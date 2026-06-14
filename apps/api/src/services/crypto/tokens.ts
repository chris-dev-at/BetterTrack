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
