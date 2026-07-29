/**
 * Literal secret placeholders published in BetterTrack examples and setup
 * guidance. Keep this list centralized so every production bootstrap boundary
 * rejects the same known values without ever echoing them back to an operator.
 */
export const KNOWN_SECRET_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'change_me_immediately_after_first_login',
  'change_me_strong_password',
  'change_me_64_random_hex_bytes',
  'change-me-to-64-random-bytes',
  'change_me_before_first_boot',
  'replace-with-at-least-32-random-characters',
  'your-16-char-app-password',
]);

/** Case-insensitive, whitespace-tolerant known-placeholder check. */
export function isKnownSecretPlaceholder(value: string): boolean {
  return KNOWN_SECRET_PLACEHOLDERS.has(value.trim().toLowerCase());
}
