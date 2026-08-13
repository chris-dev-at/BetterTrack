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
    expires: '2026-08-14',
    moduleName: 'drizzle-orm',
    reason:
      'Renewed 2026-08-07: the 0.38→0.45 upgrade spans schema-layer changes and two in-flight migration PRs; dedicated tested upgrade PR scheduled right after the board-#68 package wave lands.',
  },
  'GHSA-p6gq-j5cr-w38f': {
    expires: '2026-08-13',
    moduleName: 'nodemailer',
    reason:
      'Existing Nodemailer lockfile entry needs an SMTP regression check before its dedicated Dependabot update can merge.',
  },
  // React Router remediation spans a compatible minor update plus a later
  // major-only advisory, so it needs the user-flow regression suite.
  'GHSA-wrjc-x8rr-h8h6': {
    expires: '2026-08-20',
    moduleName: 'react-router',
    reason:
      'React Router upgrade needs user-flow regression coverage before the coordinated dependency update.',
  },
  'GHSA-h8fp-f39c-q6mh': {
    expires: '2026-08-20',
    moduleName: 'react-router',
    reason:
      'React Router upgrade needs user-flow regression coverage before the coordinated dependency update.',
  },
  'GHSA-337j-9hxr-rhxg': {
    expires: '2026-08-20',
    moduleName: 'react-router',
    reason:
      'React Router upgrade needs user-flow regression coverage before the coordinated dependency update.',
  },
  'GHSA-chx6-hx7r-mcp5': {
    expires: '2026-08-20',
    moduleName: 'react-router',
    reason:
      'React Router upgrade needs user-flow regression coverage before the coordinated dependency update.',
  },
  'GHSA-qwww-vcr4-c8h2': {
    expires: '2026-08-20',
    moduleName: 'react-router',
    reason:
      'The only published remediation is a React Router major upgrade, which needs a separately reviewed migration.',
  },
  // Provider/tooling transitive updates are kept out of the CI-gate change so
  // their upstream compatibility can be reviewed independently.
  'GHSA-v422-hmwv-36x6': {
    expires: '2026-08-16',
    moduleName: 'body-parser',
    reason:
      'Renewed 2026-08-10: body-parser is transitive through Express; the fix is an Express bump that needs the API HTTP regression suite in a dedicated update, scheduled with the pending dependency wave.',
  },
  'GHSA-frvp-7c67-39w9': {
    expires: '2026-08-15',
    moduleName: '@hono/node-server',
    reason:
      'The vulnerable Hono server is transitive through the market-data SDK and needs an upstream compatibility update.',
  },
  'GHSA-52cp-r559-cp3m': {
    expires: '2026-08-30',
    moduleName: 'js-yaml',
    reason:
      'Js-yaml is transitive through the lint toolchain and needs a coordinated ESLint update.',
  },
  // Sibling advisory to GHSA-52cp-r559-cp3m (published after the wave above);
  // identical exposure and identical remediation path.
  'GHSA-5p4m-2wfm-xmqj': {
    expires: '2026-08-30',
    moduleName: 'js-yaml',
    reason:
      'Js-yaml is transitive through the lint toolchain and needs a coordinated ESLint update (same remediation as GHSA-52cp-r559-cp3m).',
  },
};
