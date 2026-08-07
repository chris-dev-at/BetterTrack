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
    expires: '2026-08-08',
    moduleName: 'body-parser',
    reason:
      'Body-parser is transitive through Express; upgrade with the API HTTP regression suite in a dedicated update.',
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
  // re2 advisories published 2026-07-31, moderate (DoS only — crash / infinite
  // loop; no data exposure). The exact re2@1.22.3 is already what production
  // runs; the safe-regex engine backs user-supplied cash rules, so its
  // upgrade needs the rule-matching regression suite in a dedicated
  // Dependabot PR. OWNER REVIEW REQUESTED (issue #1018 wrap-up): waived
  // in-flight to land the verified redesign merge, not silently.
  'GHSA-6hxr-mr5r-9836': {
    expires: '2026-08-14',
    moduleName: 're2',
    reason:
      'Moderate DoS in the safe-regex engine behind user cash rules; upgrade needs the rule-matching regression suite in its own tested PR.',
  },
  'GHSA-ff84-5f28-78qj': {
    expires: '2026-08-14',
    moduleName: 're2',
    reason:
      'Moderate DoS in the safe-regex engine behind user cash rules; upgrade needs the rule-matching regression suite in its own tested PR.',
  },
  // Two further re2 sibling advisories (same 2026-07/08 wave, same moderate
  // DoS class, no data exposure); covered by the same dedicated-upgrade plan
  // and the same expiry as their siblings above.
  'GHSA-8hcv-x26h-mcgp': {
    expires: '2026-08-14',
    moduleName: 're2',
    reason:
      'Moderate DoS in the safe-regex engine behind user cash rules; upgrade needs the rule-matching regression suite in its own tested PR (same plan as GHSA-6hxr-mr5r-9836).',
  },
  'GHSA-j4r3-hg7j-8chg': {
    expires: '2026-08-14',
    moduleName: 're2',
    reason:
      'Moderate DoS in the safe-regex engine behind user cash rules; upgrade needs the rule-matching regression suite in its own tested PR (same plan as GHSA-6hxr-mr5r-9836).',
  },
};
