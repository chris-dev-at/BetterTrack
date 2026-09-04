import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateDependencyAudit, interpretAuditOutput } from './audit-production-dependencies.mjs';

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

test('reads an advisory report as a report', () => {
  const audit = auditFor(advisory('GHSA-ab12-cd34-ef56'));
  const interpreted = interpretAuditOutput({ stdout: JSON.stringify(audit), status: 0 });

  assert.equal(interpreted.kind, 'report');
  assert.deepEqual(interpreted.audit, audit);
});

test('reads an empty advisory map as a report rather than a registry failure', () => {
  const interpreted = interpretAuditOutput({ stdout: '{"advisories":{}}', status: 0 });

  assert.equal(interpreted.kind, 'report');
  assert.deepEqual(evaluateDependencyAudit(interpreted.audit, {}, NOW), {
    issues: [],
    waived: [],
  });
});

test('reports an unreachable registry as a registry error, naming the cause', () => {
  const interpreted = interpretAuditOutput({
    stdout: JSON.stringify({
      error: {
        code: 'ERR_SOCKET_TIMEOUT',
        message: 'request to https://registry.npmjs.org/... failed, reason: Socket timeout',
      },
    }),
    status: 1,
  });

  assert.equal(interpreted.kind, 'registry-error');
  assert.match(interpreted.detail, /ERR_SOCKET_TIMEOUT/);
  assert.match(interpreted.detail, /Socket timeout/);
});

test('reports a registry error even when it carries no code or message', () => {
  const interpreted = interpretAuditOutput({ stdout: '{"error":{}}', status: 1 });

  assert.equal(interpreted.kind, 'registry-error');
  assert.match(interpreted.detail, /unknown error/);
});

test('treats empty and unparseable output as unusable, not as a registry error', () => {
  const empty = interpretAuditOutput({ stdout: '   ', stderr: 'pnpm exploded', status: 2 });
  assert.equal(empty.kind, 'unusable');
  assert.match(empty.detail, /exit code 2/);
  assert.match(empty.detail, /pnpm exploded/);

  const garbage = interpretAuditOutput({ stdout: 'not json at all', status: 0 });
  assert.equal(garbage.kind, 'unusable');
  assert.match(garbage.detail, /invalid JSON/);
});

test('a registry error is never mistaken for a passing audit', () => {
  const envelope = { error: { code: 'ERR_SOCKET_TIMEOUT' } };
  const interpreted = interpretAuditOutput({ stdout: JSON.stringify(envelope), status: 1 });

  // Before the hardening this envelope was passed on to evaluateDependencyAudit,
  // which blamed a malformed advisory map and hid the real cause. It must not be
  // classified as a report — and had it been, it would still have to fail closed.
  assert.equal(interpreted.kind, 'registry-error');
  assert.deepEqual(evaluateDependencyAudit(envelope, {}, NOW), {
    issues: ['pnpm audit did not return an advisory map.'],
    waived: [],
  });
});
