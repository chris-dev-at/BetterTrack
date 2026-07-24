import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  USAGE_HISTORY_MAX_ENTRIES,
  USAGE_HISTORY_RETENTION_MS,
  appendUsageHistory,
  compactUsageHistory,
  parseUsageHistoryHours,
  queryUsageHistory,
  sanitizeUsageHistoryEntry,
  usageSnapshotToHistoryEntry,
} from './usage-history.mjs';

test('history range is restricted to the three dashboard windows', () => {
  assert.equal(parseUsageHistoryHours('24'), 24);
  assert.equal(parseUsageHistoryHours('168'), 168);
  assert.equal(parseUsageHistoryHours('720'), 720);
  assert.equal(parseUsageHistoryHours('2160'), 168);
  assert.equal(parseUsageHistoryHours('anything'), 168);
});

test('history entries include only real percentages, reset times and safe model meters', () => {
  const clean = sanitizeUsageHistoryEntry({
    at: 1_700_000_000_000,
    f5: null,
    d7: 85,
    r5: 'not-a-date',
    r7: '2026-07-31T12:00:00Z',
    sc: [
      { n: 'Opus 4.8', p: 20 },
      { n: 'secret\nmodel', p: 10 },
      { n: 'No meter', p: null },
    ],
    oauthToken: 'secret',
  });
  assert.deepEqual(clean, {
    at: 1_700_000_000_000,
    d7: 85,
    r7: '2026-07-31T12:00:00.000Z',
    sc: [{ n: 'Opus 4.8', p: 20 }],
  });
  assert.doesNotMatch(JSON.stringify(clean), /secret|oauthToken/);
  assert.equal(sanitizeUsageHistoryEntry({ at: 1, f5: null, d7: null }), null);
  assert.equal(sanitizeUsageHistoryEntry({ at: true, f5: 1 }), null);
  assert.deepEqual(compactUsageHistory({ not: 'an array' }), []);
});

test('stale/error readings never create false samples', () => {
  assert.equal(usageSnapshotToHistoryEntry({ error: 'no token' }), null);
  assert.equal(usageSnapshotToHistoryEntry({ stale: true, fiveHour: { pct: 40 } }), null);
  assert.equal(usageSnapshotToHistoryEntry({ fiveHour: null, sevenDay: null, scoped: [] }), null);
});

test('compaction enforces retention, ordering, de-duplication and the hard cap', () => {
  const now = 2_000_000_000_000;
  const rows = Array.from({ length: USAGE_HISTORY_MAX_ENTRIES + 5 }, (_, index) => ({
    at: now - (USAGE_HISTORY_MAX_ENTRIES + 4 - index) * 1000,
    f5: index % 100,
  }));
  rows.unshift({ at: now - USAGE_HISTORY_RETENTION_MS - 1, f5: 1 });
  rows.push({ at: now, f5: 20 }, { at: now, f5: 21 });
  const compacted = compactUsageHistory(rows, now);
  assert.equal(compacted.length, USAGE_HISTORY_MAX_ENTRIES);
  assert.equal(compacted.at(-1).f5, 21);
  assert.ok(compacted.every((entry, index) => index === 0 || entry.at > compacted[index - 1].at));
});

test('history persistence is atomic, sampled and query-bounded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mf-usage-history-'));
  const file = join(dir, 'history.json');
  const now = Date.parse('2026-07-24T12:00:00Z');
  try {
    const usage = {
      fiveHour: { pct: 20, resetsAt: '2026-07-24T15:00:00Z' },
      sevenDay: { pct: 85, resetsAt: '2026-07-28T10:00:00Z' },
      scoped: [{ name: 'Opus 4.8', pct: 40 }],
    };
    assert.equal(await appendUsageHistory(file, usage, now - 25 * 60 * 60 * 1000), true);
    assert.equal(await appendUsageHistory(file, usage, now), true);
    assert.equal(await appendUsageHistory(file, usage, now + 1000), false);

    const result = await queryUsageHistory(file, '24', now);
    assert.equal(result.hours, 24);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].f5, 20);
    assert.equal(result.entries[0].d7, 85);
    assert.deepEqual(result.entries[0].sc, [{ n: 'Opus 4.8', p: 40 }]);

    const disk = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(disk.version, 1);
    assert.equal(disk.entries.length, 2);
    assert.ok((await readdir(dir)).every((name) => !name.includes('.tmp-')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('control server exposes only the bounded history query helper', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /url\.pathname === '\/api\/usage\/history'/);
  assert.match(source, /queryUsageHistory\(USAGE_HISTORY_FILE/);
});
