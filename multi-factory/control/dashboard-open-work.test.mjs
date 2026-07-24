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
      [102, 'passing', 'clean', 1],
      [109, 'passing', 'behind', null],
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

test('Open Work remains read-only and server exposes awaiting-owner source truthfully', () => {
  const openWorkScript = between(script, 'const openWorkSource', 'const PHASE_ICON');
  assert.doesNotMatch(openWorkScript, /\bfetch\s*\(/);
  assert.doesNotMatch(openWorkScript, /\bact\s*\(/);
  assert.match(html, /type="button" onclick="setTab\('flow'\)">View full work/);
  assert.match(server, /'--label',\s*'awaiting-owner'/);
  assert.match(server, /statusCheckRollup,mergeStateStatus,isDraft/);
  assert.match(server, /awaitingOwner:\s*parse\(awaitingOwner, \[\]\)/);
  assert.match(server, /sources:\s*\{[\s\S]*awaitingOwner:\s*\{/);
});
