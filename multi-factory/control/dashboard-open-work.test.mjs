import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

function harness() {
  return new Function(`
    const elements = new Map();
    const $ = (id) => {
      if (!elements.has(id))
        elements.set(id, {
          innerHTML: '',
          textContent: '',
          attributes: new Map(),
          setAttribute(name, value) { this.attributes.set(name, String(value)); },
        });
      return elements.get(id);
    };
    const REPO = 'https://example.test/repo';
    const esc = (value) => String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
    ${between(script, 'function claimPrefix', 'const PHASE_ICON')}
    return {
      model(snapshot, health = { available: true, detail: '' }) {
        return openWorkModel(snapshot, health);
      },
      prStatus(item) {
        return openWorkPrStatus(item);
      },
      render(snapshot, health = { available: true, detail: '' }) {
        renderOpenWork(snapshot, health);
        return {
          html: $('open-work').innerHTML,
          count: $('open-work-count').textContent,
          busy: $('open-work').attributes.get('aria-busy'),
        };
      },
    };
  `)();
}

const snapshot = {
  protocol: {
    workers: [
      {
        id: 1,
        assignment: { issue: 1, touches: ['src/active.js'] },
        status: { issue: 1, phase: 'writing' },
      },
    ],
    queue: [{ issue: 2, pr: 102, touches: ['src/queue.js'] }],
    masterActivity: { activity: 'idle' },
  },
  github: {
    issues: [
      {
        number: 1,
        title: '<script>active</script>',
        labels: ['autopilot'],
        meta: { touches: ['src/active.js'] },
      },
      {
        number: 2,
        title: 'Approved work',
        labels: ['autopilot'],
        meta: { touches: ['src/queue.js'] },
      },
      {
        number: 3,
        title: 'Runnable work',
        labels: ['autopilot'],
        meta: { touches: ['docs/runnable.md'] },
      },
      {
        number: 4,
        title: 'Dependency blocked',
        labels: ['autopilot'],
        meta: { dependsOn: [5], touches: ['docs/dependent.md'] },
      },
      {
        number: 5,
        title: 'Blocking issue',
        labels: ['autopilot'],
        meta: { touches: ['docs/blocker.md'] },
      },
    ],
    prs: [
      {
        number: 102,
        title: 'Approved PR',
        branch: 'task/2',
        checks: 'passing',
        mergeState: 'clean',
      },
      {
        number: 108,
        title: 'Broken CI',
        branch: 'task/8',
        checks: 'failing',
        mergeState: 'blocked',
      },
      {
        number: 109,
        title: 'Branch behind',
        branch: 'task/9',
        checks: 'passing',
        mergeState: 'behind',
      },
    ],
    merged: [],
    needsHuman: [{ number: 6, title: 'Manual intervention' }],
    awaitingOwner: [{ number: 7, title: 'Owner decision' }],
    sources: {
      needsHuman: { available: true },
      awaitingOwner: { available: true },
    },
  },
};

test('Open Work classifies active, runnable, queued, PR and decision states', () => {
  const model = harness().model(snapshot);
  assert.equal(model.state, 'ready');
  const lanes = Object.fromEntries(model.lanes.map((lane) => [lane.id, lane.rows]));
  assert.deepEqual(
    lanes.active.map((row) => [row.number, row.worker, row.phase]),
    [[1, 1, 'writing']],
  );
  assert.equal(lanes.ready.find((row) => row.number === 2).queuePos, 1);
  assert.ok(lanes.ready.some((row) => row.number === 3 && !row.queuePos));
  assert.ok(!lanes.ready.some((row) => [6, 7].includes(row.number)));
  assert.deepEqual(
    lanes.prs.map((row) => [row.number, row.checks, row.mergeState, row.queuePos]),
    [
      [108, 'failing', 'blocked', null],
      [109, 'passing', 'behind', null],
      [102, 'passing', 'clean', 1],
    ],
  );
  assert.ok(
    lanes.decisions.some(
      (row) => row.number === 4 && row.signals.some((signal) => signal.kind === 'blocked'),
    ),
  );
  assert.ok(
    lanes.decisions.some(
      (row) => row.number === 6 && row.signals.some((signal) => signal.kind === 'needs human'),
    ),
  );
  assert.ok(
    lanes.decisions.some(
      (row) => row.number === 7 && row.signals.some((signal) => signal.kind === 'awaiting owner'),
    ),
  );
});

test('Open Work rendering is compact, escaped, linked, and progressively summarized', () => {
  const expanded = structuredClone(snapshot);
  for (let number = 9; number <= 12; number += 1)
    expanded.github.issues.push({
      number,
      title: `Ready ${number}`,
      labels: ['autopilot'],
      meta: { touches: [`tests/ready-${number}.js`] },
    });
  const rendered = harness().render(expanded);
  assert.match(rendered.count, /^\d+ tracked$/);
  assert.equal(rendered.busy, 'false');
  assert.match(rendered.html, /Active workers/);
  assert.match(rendered.html, /Ready &amp; queued/);
  assert.match(rendered.html, /Pull requests/);
  assert.match(rendered.html, /Decisions/);
  assert.match(rendered.html, /merge behind/);
  assert.match(rendered.html, /href="https:\/\/example\.test\/repo\/issues\/1"/);
  assert.match(rendered.html, /&lt;script&gt;active&lt;\/script&gt;/);
  assert.doesNotMatch(rendered.html, /<script>active<\/script>/);
  assert.match(rendered.html, /\+\d+ more · view full work/);
});

test('Open Work has explicit empty, partial-source, loading, and error states', () => {
  assert.match(html, /Loading open work/);

  const empty = {
    protocol: { workers: [], queue: [] },
    github: {
      issues: [],
      prs: [],
      merged: [],
      needsHuman: [],
      awaitingOwner: [],
      sources: {
        needsHuman: { available: true },
        awaitingOwner: { available: true },
      },
    },
  };
  assert.match(harness().render(empty).html, /No open work/);

  const partial = structuredClone(empty);
  delete partial.github.awaitingOwner;
  partial.github.sources.awaitingOwner = { available: false, error: 'label query failed' };
  const partialRendered = harness().render(partial);
  assert.doesNotMatch(partialRendered.html, /No open work/);
  assert.match(partialRendered.html, /awaiting-owner unavailable/);

  const errored = harness().render(empty, {
    available: false,
    detail: 'GitHub CLI unavailable',
  });
  assert.equal(errored.count, 'unavailable');
  assert.match(errored.html, /Open work unavailable/);
  assert.match(errored.html, /GitHub CLI unavailable/);
});

test('Open Work fails closed from core labels when decision queries are unavailable', () => {
  const partial = {
    protocol: { workers: [], queue: [] },
    github: {
      issues: [
        {
          number: 30,
          title: 'Core needs-human issue',
          labels: ['autopilot', 'needs-human'],
          meta: { touches: ['src/human.js'] },
        },
        {
          number: 31,
          title: 'Core owner issue',
          labels: ['autopilot', 'awaiting-owner'],
          meta: { touches: ['src/owner.js'] },
        },
        {
          number: 32,
          title: 'Core blocked issue',
          labels: ['autopilot', 'blocked-by:#29'],
          meta: { touches: ['src/blocked.js'] },
        },
        {
          number: 33,
          title: 'Actually runnable',
          labels: ['autopilot'],
          meta: { touches: ['src/ready.js'] },
        },
      ],
      prs: [],
      merged: [],
      sources: {
        needsHuman: { available: false, error: 'needs-human query failed' },
        awaitingOwner: { available: false, error: 'awaiting-owner query failed' },
      },
    },
  };
  const model = harness().model(partial);
  const lanes = Object.fromEntries(model.lanes.map((lane) => [lane.id, lane.rows]));
  assert.deepEqual(
    lanes.ready.map((row) => row.number),
    [33],
  );
  assert.ok(
    lanes.decisions.some(
      (row) => row.number === 30 && row.signals.some((signal) => signal.kind === 'needs human'),
    ),
  );
  assert.ok(
    lanes.decisions.some(
      (row) => row.number === 31 && row.signals.some((signal) => signal.kind === 'awaiting owner'),
    ),
  );
  assert.ok(
    lanes.decisions.some(
      (row) => row.number === 32 && row.signals.some((signal) => signal.kind === 'blocked'),
    ),
  );
  const rendered = harness().render(partial);
  assert.doesNotMatch(rendered.html, /Core needs-human issue[\s\S]*scheduler can assign/);
  assert.match(rendered.html, /needs-human unavailable/);
  assert.match(rendered.html, /awaiting-owner unavailable/);
});

test('PR safety and CI states outrank merge-queue activity', () => {
  const queued = {
    protocol: {
      workers: [],
      queue: [
        { issue: 20, pr: 120, touches: ['src/clean.js'] },
        { issue: 21, pr: 121, touches: ['src/dirty.js'] },
        { issue: 22, pr: 122, touches: ['src/pending.js'] },
        { issue: 23, pr: 123, touches: ['src/blocked.js'] },
        { issue: 24, pr: 124, touches: ['src/fixing.js'] },
      ],
      masterActivity: { activity: 'ci-fix', pr: 124 },
    },
    github: {
      issues: [20, 21, 22, 23, 24].map((number) => ({
        number,
        title: `Issue ${number}`,
        labels: ['autopilot'],
        meta: { touches: [`src/${number}.js`] },
      })),
      prs: [
        {
          number: 120,
          title: 'Queued clean',
          branch: 'task/20',
          checks: 'passing',
          mergeState: 'clean',
        },
        {
          number: 121,
          title: 'Queued dirty',
          branch: 'task/21',
          checks: 'passing',
          mergeState: 'dirty',
        },
        {
          number: 122,
          title: 'Queued pending',
          branch: 'task/22',
          checks: 'pending',
          mergeState: 'clean',
        },
        {
          number: 123,
          title: 'Queued blocked',
          branch: 'task/23',
          checks: 'passing',
          mergeState: 'blocked',
        },
        {
          number: 124,
          title: 'CI fixer active',
          branch: 'task/24',
          checks: 'passing',
          mergeState: 'clean',
        },
      ],
      merged: [],
      needsHuman: [],
      awaitingOwner: [],
      sources: {
        needsHuman: { available: true },
        awaitingOwner: { available: true },
      },
    },
  };
  const dashboard = harness();
  const model = dashboard.model(queued);
  const prs = Object.fromEntries(
    model.lanes.find((lane) => lane.id === 'prs').rows.map((row) => [row.number, row]),
  );
  assert.deepEqual(dashboard.prStatus(prs[121]), ['merge dirty', 'bad']);
  assert.deepEqual(dashboard.prStatus(prs[123]), ['merge blocked', 'bad']);
  assert.deepEqual(dashboard.prStatus(prs[122]), ['CI pending', 'warn']);
  assert.equal(prs[124].merging, false);
  assert.equal(prs[124].ciFixing, true);
  assert.deepEqual(dashboard.prStatus(prs[124]), ['CI fixing', 'warn']);
  assert.deepEqual(dashboard.prStatus(prs[120]), ['queue 1', 'warn']);
  assert.deepEqual(
    dashboard.prStatus({
      checks: 'passing',
      mergeState: 'clean',
      merging: true,
      queuePos: 1,
    }),
    ['merging', 'good'],
  );
});

test('Open Work limits live announcements and transfers focus when navigating away', () => {
  assert.doesNotMatch(html, /id="open-work"[^>]*aria-live/);
  assert.match(html, /id="open-work-count"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /onclick="setTab\('flow', true\)">View full work/);
  assert.match(script, /function setTab\(t, moveFocus = false\)/);
  assert.match(script, /if \(moveFocus\) \$\('tab-' \+ t\)\?\.focus\(\)/);
});

test('Open Work remains read-only and server exposes awaiting-owner source truthfully', () => {
  const openWorkScript = between(script, 'const openWorkSource', 'const PHASE_ICON');
  assert.doesNotMatch(openWorkScript, /\bfetch\s*\(/);
  assert.doesNotMatch(openWorkScript, /\bact\s*\(/);
  assert.match(html, /type="button" onclick="setTab\('flow', true\)">View full work/);
  assert.match(server, /'--label',\s*'awaiting-owner'/);
  assert.match(server, /statusCheckRollup,mergeStateStatus,isDraft/);
  assert.match(server, /awaitingOwner:\s*parse\(awaitingOwner, \[\]\)/);
  assert.match(server, /sources:\s*\{[\s\S]*awaitingOwner:\s*\{/);
});
