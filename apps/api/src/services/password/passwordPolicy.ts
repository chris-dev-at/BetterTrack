import { MIN_PASSWORD_LENGTH } from '@bettertrack/contracts';

import { COMMON_PASSWORDS } from './commonPasswords';

export type PasswordPolicyResult = { ok: true } | { ok: false; reason: string };

/**
 * Password policy (PROJECTPLAN.md §6.1): ≥ 10 chars, no composition rules,
 * common-password blocklist.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return {
      ok: false,
      reason: 'This password is too common. Please choose a less predictable one.',
    };
  }
  return { ok: true };
}
