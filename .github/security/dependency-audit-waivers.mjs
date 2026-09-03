/**
 * Temporary, reviewed production-dependency audit waivers.
 *
 * Every entry needs a specific GHSA, audited package name, short expiry, and
 * reason. The audit verifier rejects unknown, expired, malformed, package
 * mismatched, and no-longer-needed waivers. See docs/SECURITY_CI_POLICY.md
 * before adding or renewing one.
 */
export const dependencyAuditWaivers = {
  // Direct runtime packages need a separately reviewed compatibility update.
  'GHSA-gpj5-g38j-94v9': {
    expires: '2026-10-04',
    moduleName: 'drizzle-orm',
    reason:
      'Renewed 2026-09-03 (second renewal, first 2026-08-14 in #1243): the dedicated 0.38→0.45 upgrade (#1217) is still needs-human-blocked — drizzle/meta snapshots end at 0022 while the journal now runs past 0108, so the upgraded kit cannot no-op db:generate; awaiting the owner’s snapshot-baseline decision. The advisory (SQL injection via improperly escaped identifiers) needs attacker-controlled identifier names, which the API never passes to drizzle — all table/column identifiers are static schema references.',
  },
};
