/**
 * The global JSON body bound every `/api/v1` request rides (PROJECTPLAN.md §10).
 * Declared here rather than inline in `app.ts` because exactly one route defers
 * the global parser to itself (`POST /account/paranoid/disable`, which carries a
 * decrypted vault) and must fall back to this same bound for any caller that has
 * nothing to restore. Two literals would drift; one cannot.
 */
export const GLOBAL_JSON_BODY_LIMIT = '100kb';
