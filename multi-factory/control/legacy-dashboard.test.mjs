import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const currentHtml = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const legacyHtml = await readFile(new URL('./legacy.html', import.meta.url), 'utf8');
const server = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
const legacyScript = legacyHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';

test('legacy dashboard remains a distinct, parseable control surface', () => {
  assert.match(legacyHtml, /<title>BetterTrack Multi-Factory — Control<\/title>/);
  assert.notEqual(legacyHtml, currentHtml);
  assert.ok(legacyScript);
  assert.doesNotThrow(() => new Function(legacyScript));
  assert.match(legacyScript, /new EventSource\('\/api\/events'\)/);
  assert.match(legacyScript, /fetch\('\/api\/action'/);
  assert.match(legacyScript, /claudex: 'ClaudeX \(Claude Code \+ Codex OAuth\)'/);
  assert.match(legacyScript, /renderCodexUsage\(d\.openai \|\| d\.codex \|\| \{\}\)/);
  assert.match(legacyScript, /x\.claude \?\? x\.multi \?\? 0/);
  assert.match(legacyScript, /x\.codex \?\? x\.single \?\? 0/);
});

test('control server exposes the legacy dashboard at both URL spellings', () => {
  assert.match(server, /url\.pathname === '\/legacy'/);
  assert.match(server, /url\.pathname === '\/legacy\/'/);
  assert.match(server, /readFileSync\(join\(__dirname, 'legacy\.html'\)\)/);
  assert.match(server, /'cache-control': 'no-store'/);
});
