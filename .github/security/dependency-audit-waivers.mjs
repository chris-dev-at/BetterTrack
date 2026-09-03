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
    expires: '2026-09-18',
    moduleName: 'drizzle-orm',
    reason:
      'Renewed 2026-09-03 (fourth renewal; #1170, #1215, #1243 before it) as a 14-day bridge: #1651 (2026-09-02) landed the schema baseline as migration 0108 with a regenerated drizzle/meta/0108_snapshot.json, so the dedicated 0.38→0.45 upgrade (#1217) is UNBLOCKED and re-armed for the factory — it bumps drizzle-orm to ≥0.45.2, proves db:generate no-ops against the 0108 snapshot, and deletes this entry. Reachability today: the advisory needs untrusted input in sql.identifier()/alias construction; every such site in apps/api is a literal or a closed whitelist (audited 2026-09-03 in PR #1668).',
  },
};
