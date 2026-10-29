/**
 * Temporary, reviewed production-dependency audit waivers.
 *
 * Every entry needs a specific GHSA, audited package name, short expiry, and
 * reason. The audit verifier rejects unknown, expired, malformed, package
 * mismatched, and no-longer-needed waivers. See docs/SECURITY_CI_POLICY.md
 * before adding or renewing one.
 *
 * Empty is the goal state, and reaching it removed the only record of two
 * hand-tracked supply-chain decisions (the drizzle 0.x-minor Dependabot fence
 * and the `shell-quote` production pin). Both now live in
 * docs/SECURITY_CI_POLICY.md, "tracked by hand" — read that before assuming an
 * override or an ignore rule is stale.
 */
export const dependencyAuditWaivers = {
  // Direct runtime package whose only fix is a deliberate major migration.
  'GHSA-mrhx-c7xc-m3w5': {
    expires: '2026-11-12',
    moduleName: 'zod',
    reason:
      'Added 2026-10-29 as a 14-day bridge. The advisory (unbounded issue accumulation when an array schema rejects many elements) is fixed only in zod 4.6.6; the 3.x line ends at 3.25.76 with no backport, and the v3 → v4 + zod-to-openapi 7 → 9 move is the deliberate migration parked behind #1031 (Dependabot ignores the zod major on purpose). The zod 4 copy that yahoo-finance2 / @modelcontextprotocol/sdk pull in is already at 4.6.7 in this lockfile, so only our own zod 3.25.76 (apps/api, packages/contracts, zod-to-openapi 7) is reported. Reachability: every JSON body is capped at 100 KiB (GLOBAL_JSON_BODY_LIMIT) before any schema runs, and CSV uploads by csvUploadLimits; the one wide body is the session-gated, vault-rate-limited paranoid restore/disable route (paranoidRestoreJsonLimitBytes), where the buffered-body memory cost is already accepted. Retire this entry by landing #1031 (or a 3.x backport, if one ships).',
  },
};
