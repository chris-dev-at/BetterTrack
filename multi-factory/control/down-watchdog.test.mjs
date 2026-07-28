import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-contract tests over server.mjs (same style as usage-history.test.mjs):
// the factory-down watchdog must exist with its safety properties intact.
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'server.mjs'), 'utf8');
const block = src.slice(
  src.indexOf('// ---- factory-down watchdog'),
  src.indexOf('// ---- http'),
);

test('down watchdog exists and only fires for owner-intended running states', () => {
  assert.ok(block.length > 0, 'watchdog block present');
  assert.match(block, /mode === 'run' && \(phase === 'running' \|\| phase === 'draining'\)/);
  // any running or paused container clears the episode
  assert.match(block, /running\|paused/);
});

test('down watchdog debounces with a bounded grace period and fires once per episode', () => {
  assert.match(block, /MF_DOWN_WATCHDOG_GRACE_MS \|\| 300000/);
  assert.match(block, /downNotified \|\| Date\.now\(\) - downSince < WATCHDOG_GRACE_MS/);
  // recovery re-arms: every early-return path resets both episode fields
  const resets = block.match(/downSince = 0;\s*\n\s*downNotified = false;/g) || [];
  assert.ok(resets.length >= 2, 'both the not-should-run and recovered paths re-arm');
});

test('down watchdog reads the webhook from factory/.env read-only and never throws outward', () => {
  assert.match(block, /FACTORY_WEBHOOK_URL/);
  assert.match(block, /join\(REPO_ROOT, 'factory', '\.env'\)/);
  // absence of a webhook only logs; the fetch is guarded and error-swallowed
  assert.match(block, /no webhook configured/);
  assert.match(block, /\.catch\(\(\) => \{\}\)/);
  assert.match(block, /catch \{\s*\n\s*\/\* watchdog must survive/);
  // the URL is never exposed through an API payload
  assert.equal(/factoryWebhookUrl/.test(src.slice(src.indexOf('const handleRequest'))), false);
});
