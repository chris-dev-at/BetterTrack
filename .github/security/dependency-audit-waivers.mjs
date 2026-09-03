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
export const dependencyAuditWaivers = {};
