import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateDependencyAudit } from './audit-production-dependencies.mjs';

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
