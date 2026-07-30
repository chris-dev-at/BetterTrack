import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateDependencyAudit } from './audit-production-dependencies.mjs';

const NOW = new Date('2026-07-30T12:00:00.000Z');

function auditFor(...advisoryIds) {
  return {
    advisories: Object.fromEntries(
      advisoryIds.map((advisoryId, index) => [String(index), { github_advisory_id: advisoryId }]),
    ),
  };
}

test('accepts an active waiver for every production advisory', () => {
  const result = evaluateDependencyAudit(
    auditFor('GHSA-ab12-cd34-ef56'),
    {
      'GHSA-ab12-cd34-ef56': {
        expires: '2026-08-01',
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
    auditFor('GHSA-ab12-cd34-ef56', 'GHSA-1234-5678-9abc'),
    {
      'GHSA-ab12-cd34-ef56': {
        expires: '2026-07-29',
        reason: 'Expired on purpose for this test.',
      },
      'GHSA-dead-beef-cafe': {
        expires: '2026-08-01',
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
