/**
 * Temporary, reviewed production-dependency audit waivers.
 *
 * Every entry needs a specific GHSA, a short expiry, and a reason. The audit
 * verifier rejects unknown, expired, malformed, and no-longer-needed waivers.
 * See docs/SECURITY_CI_POLICY.md before adding or renewing one.
 */
export const dependencyAuditWaivers = {
  // Direct runtime packages need a separately reviewed compatibility update.
  'GHSA-gpj5-g38j-94v9': {
    expires: '2026-08-30',
    reason:
      'Drizzle 0.x minor upgrades can require migration compatibility changes; update in a dedicated, tested Dependabot PR.',
  },
  'GHSA-p6gq-j5cr-w38f': {
    expires: '2026-08-30',
    reason:
      'Existing Nodemailer lockfile entry needs an SMTP regression check before its dedicated Dependabot update can merge.',
  },
  // React Router remediation spans a compatible minor update plus a later
  // major-only advisory, so it needs the user-flow regression suite.
  'GHSA-wrjc-x8rr-h8h6': {
    expires: '2026-08-30',
    reason:
      'React Router upgrade needs user-flow regression coverage before the coordinated dependency update.',
  },
  'GHSA-h8fp-f39c-q6mh': {
    expires: '2026-08-30',
    reason:
      'React Router upgrade needs user-flow regression coverage before the coordinated dependency update.',
  },
  'GHSA-337j-9hxr-rhxg': {
    expires: '2026-08-30',
    reason:
      'React Router upgrade needs user-flow regression coverage before the coordinated dependency update.',
  },
  'GHSA-chx6-hx7r-mcp5': {
    expires: '2026-08-30',
    reason:
      'React Router upgrade needs user-flow regression coverage before the coordinated dependency update.',
  },
  'GHSA-qwww-vcr4-c8h2': {
    expires: '2026-08-30',
    reason:
      'The only published remediation is a React Router major upgrade, which needs a separately reviewed migration.',
  },
  // Provider/tooling transitive updates are kept out of the CI-gate change so
  // their upstream compatibility can be reviewed independently.
  'GHSA-v422-hmwv-36x6': {
    expires: '2026-08-30',
    reason:
      'Body-parser is transitive through Express; upgrade with the API HTTP regression suite in a dedicated update.',
  },
  'GHSA-frvp-7c67-39w9': {
    expires: '2026-08-30',
    reason:
      'The vulnerable Hono server is transitive through the market-data SDK and needs an upstream compatibility update.',
  },
  'GHSA-v2hh-gcrm-f6hx': {
    expires: '2026-08-30',
    reason:
      'Fast-uri is transitive through the market-data SDK; remediate with its reviewed upstream dependency update.',
  },
  'GHSA-4c8g-83qw-93j6': {
    expires: '2026-08-30',
    reason:
      'Fast-uri is transitive through the market-data SDK; remediate with its reviewed upstream dependency update.',
  },
  'GHSA-3jxr-9vmj-r5cp': {
    expires: '2026-08-30',
    reason:
      'Brace-expansion is transitive through the lint toolchain and needs a coordinated ESLint update.',
  },
  'GHSA-mh99-v99m-4gvg': {
    expires: '2026-08-30',
    reason:
      'Brace-expansion is transitive through the lint toolchain and needs a coordinated ESLint update.',
  },
  'GHSA-52cp-r559-cp3m': {
    expires: '2026-08-30',
    reason:
      'Js-yaml is transitive through the lint toolchain and needs a coordinated ESLint update.',
  },
};
