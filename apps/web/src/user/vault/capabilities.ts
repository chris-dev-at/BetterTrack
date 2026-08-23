/**
 * Build-level capability flags for the per-portfolio vault surfaces (E8).
 *
 * A vault affordance is only offered when the code behind it exists. This is
 * the single source of truth for "does this build have it", read both by the
 * module that would perform the work and by the UI that would offer it — so a
 * surface can never invite a user into a step that refuses at the end (the
 * recorded v2 anti-pattern of an action without a next step).
 *
 * A plain constant, not an env or feature flag: nothing an operator can turn on
 * brings the missing epic's code with it.
 *
 * The other deferred capabilities are expressed as seams rather than flags —
 * the nullable `resolvePortfolioVaultMoveCapture()` in `portfolioVaultMove.ts`
 * (E6, #1416) and the optional members of `VaultManagerOperations` (rotation
 * and "start fresh" need E5's per-medium round trip, #1415; the QR reader is
 * E7, #1417). The epic that lands one supplies the function; until then each
 * surface states the exact missing piece.
 */

/**
 * Provisioning a NEW vault onto Google Drive. Drive document creation is owned
 * by E5's per-connection data home (#1415); until it lands, the creation
 * ceremony offers only the server medium instead of letting a user write down
 * twelve words for a vault `provisionVault` would refuse.
 */
export const PER_VAULT_DRIVE_PROVISIONING_AVAILABLE = false;
