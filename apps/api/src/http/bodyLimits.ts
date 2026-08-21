/**
 * The global JSON body bound every `/api/v1` request rides (PROJECTPLAN.md §10).
 * Declared here rather than inline in `app.ts` because the unlocked restore
 * routes defer the global parser until after authentication and rate limiting.
 * The account-disable route must also fall back to this same bound for callers
 * with nothing to restore. Multiple literals would drift; one cannot.
 */
export const GLOBAL_JSON_BODY_LIMIT = '100kb';

/** Bounded plaintext expansion allowance shared by both unlocked restore routes. */
export const PARANOID_RESTORE_PLAINTEXT_FACTOR = 8;

export const paranoidRestoreJsonLimitBytes = (encryptedMaxBytes: number): number =>
  encryptedMaxBytes * PARANOID_RESTORE_PLAINTEXT_FACTOR + 64 * 1024;
