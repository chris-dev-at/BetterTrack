import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_ATTEMPTS,
  AUDIT_RETRY_DELAYS_MS,
  auditLooksComplete,
  evaluateDependencyAudit,
} from './audit-production-dependencies.mjs';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const TEST_MODULE = 'test-package';

function advisory(id, moduleName = TEST_MODULE) {
  return { id, moduleName };
}

function auditFor(...advisories) {
  return {
    advisories: Object.fromEntries(
      advisories.map(({ id, moduleName }, index) => [
        String(index),
        { github_advisory_id: id, module_name: moduleName },
      ]),
    ),
  };
}

test('accepts an active waiver for every production advisory', () => {
  const result = evaluateDependencyAudit(
    auditFor(advisory('GHSA-ab12-cd34-ef56')),
    {
      'GHSA-ab12-cd34-ef56': {
        expires: '2026-08-01',
        moduleName: TEST_MODULE,
        reason: 'A dedicated compatibility update is under review.',
      },
    },
    NOW,
  );

  assert.deepEqual(result, {
    issues: [],
    waived: ['GHSA-ab12-cd34-ef56'],
  });
});

test('rejects new, expired, and stale waivers', () => {
  const result = evaluateDependencyAudit(
    auditFor(advisory('GHSA-ab12-cd34-ef56'), advisory('GHSA-1234-5678-9abc')),
    {
      'GHSA-ab12-cd34-ef56': {
        expires: '2026-07-29',
        moduleName: TEST_MODULE,
        reason: 'Expired on purpose for this test.',
      },
      'GHSA-dead-beef-cafe': {
        expires: '2026-08-01',
        moduleName: TEST_MODULE,
        reason: 'No longer appears in the audit report.',
      },
    },
    NOW,
  );

  assert.deepEqual(result.issues, [
    'Production dependency advisory GHSA-1234-5678-9abc has no active waiver.',
    'Production dependency advisory GHSA-ab12-cd34-ef56 has no active waiver.',
    'Waiver GHSA-ab12-cd34-ef56 expired on 2026-07-29.',
    'Waiver GHSA-dead-beef-cafe is no longer needed and must be removed.',
  ]);
  assert.deepEqual(result.waived, []);
});

test('rejects a waiver when the advisory reaches a different package', () => {
  const result = evaluateDependencyAudit(
    auditFor(advisory('GHSA-ab12-cd34-ef56', 'new-direct-package')),
    {
      'GHSA-ab12-cd34-ef56': {
        expires: '2026-08-01',
        moduleName: 'fast-uri',
        reason: 'This waiver applies only to the existing transitive package.',
      },
    },
    NOW,
  );

  assert.deepEqual(result, {
    issues: [
      'Production dependency advisory GHSA-ab12-cd34-ef56 has no active waiver.',
      'Waiver GHSA-ab12-cd34-ef56 is for fast-uri, but pnpm audit reports new-direct-package.',
    ],
    waived: [],
  });
});

test('an audit document without an advisory map is a transient to retry, not a pass', () => {
  // The registry's audit endpoint answered these shapes on 2026-09-03/04 while
  // the same lockfile audited clean minutes later.
  assert.equal(auditLooksComplete(undefined), false);
  assert.equal(auditLooksComplete(null), false);
  assert.equal(auditLooksComplete({}), false);
  assert.equal(auditLooksComplete({ error: { code: 'E503' } }), false);
  assert.equal(auditLooksComplete({ advisories: null }), false);
  assert.equal(auditLooksComplete({ advisories: 'nope' }), false);
  // A clean audit still carries an (empty) map — that is a pass, not a retry.
  assert.equal(auditLooksComplete({ advisories: {} }), true);
  assert.equal(auditLooksComplete(auditFor(advisory('GHSA-ab12-cd34-ef56'))), true);
  // Bounded and spaced: never an unbounded loop, never a hot one.
  assert.ok(AUDIT_ATTEMPTS >= 2 && AUDIT_ATTEMPTS <= 5);
  assert.ok(AUDIT_RETRY_DELAYS_MS.every((delay) => delay >= 5_000 && delay <= 60_000));
});
