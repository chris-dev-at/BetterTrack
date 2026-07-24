import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

function lifecycleHarness() {
  return new Function(`
    class FakeElement {
      constructor(id = '') {
        this.id = id;
        this.disabled = false;
        this.style = { display: '' };
        this.attributes = new Map();
        this.className = '';
        this.textContent = '';
        this._innerHTML = '';
        this.classList = {
          add: (...names) => names.forEach((name) => this.attributes.set('class:' + name, true)),
          remove: (...names) => names.forEach((name) => this.attributes.delete('class:' + name)),
          toggle: (name, force) => {
            const enabled = force ?? !this.attributes.has('class:' + name);
            if (enabled) this.attributes.set('class:' + name, true);
            else this.attributes.delete('class:' + name);
            return enabled;
          },
        };
      }
      set innerHTML(value) { this._innerHTML = String(value); }
      get innerHTML() { return this._innerHTML; }
      setAttribute(name, value) { this.attributes.set(name, String(value)); }
      removeAttribute(name) { this.attributes.delete(name); }
      querySelector(selector) {
        return selector === 'button' ? getElement('b-single-stop') : null;
      }
    }

    const elements = new Map();
    const dynamicButtons = [];
    const providerButtons = [];
    const getElement = (id) => {
      if (!elements.has(id)) elements.set(id, new FakeElement(id));
      return elements.get(id);
    };
    const $ = getElement;
    const document = {
      getElementById: getElement,
      querySelectorAll(selector) {
        if (selector === '#triggers button, #provs button')
          return [...dynamicButtons, ...providerButtons];
        if (selector === '#triggers button') return dynamicButtons;
        if (selector === '#provs button') return providerButtons;
        return [];
      },
    };
    const esc = (value) => String(value ?? '');
    const ago = (value) => value == null ? '–' : String(value);
    const tago = () => 'now';
    const tuntil = () => 'later';
    const REPO = 'https://example.test';
    const PHASE_ICON = {};
    let S = null;
    let controlFresh = false;
    let renderingFresh = false;
    let activeTab = 'overview';
    let rcExpanded = false;
    let wkDesired = null;
    let forceRenderFailure = false;
    let postCount = 0;
    let eventSource = null;

    const syncProviderDefs = () => {};
    const captureLocalUsage = () => {};
    const renderSubscriptionUsage = () => {};
    const renderAttention = () => {};
    const renderEvents = () => {};
    const renderFlow = () => {};
    const renderDetail = () => {};
    const renderModels = () => {};
    const joinIssues = () => [];
    const diffChip = () => '';
    const renderHead = (snapshot) => {
      if (forceRenderFailure) {
        forceRenderFailure = false;
        throw new Error('forced render failure');
      }
      $('head-factory').textContent = snapshot.protocol.mode;
    };
    const renderTriggers = (list) => {
      dynamicButtons.length = 0;
      for (const trigger of list || []) {
        const button = new FakeElement('trigger-' + trigger.id);
        button.disabled = !controlPlaneState(S).available;
        dynamicButtons.push(button);
      }
    };
    const toast = () => {};
    const fetch = async () => {
      postCount += 1;
      return { json: async () => ({ ok: true }) };
    };
    class EventSource {
      constructor() { eventSource = this; }
      close() {}
      emit(payload) { this.onmessage({ data: JSON.stringify(payload) }); }
    }

    ${between(script, 'const armed = new Map();', 'function toast')}
    ${between(script, 'const finiteNumber =', 'function renderHead')}
    ${between(script, 'function render(s) {', '/* ---- FLOW view ---- */')}
    ${between(script, 'function restoreReadOnlySnapshot', 'setInterval(() =>')}

    for (const id of MUTATING_CONTROL_IDS) $(id);
    disableMutationControls();
    connect();

    return {
      emit(payload) { eventSource.emit(payload); },
      failNextRender() { forceRenderFailure = true; },
      async requestStart() { await act('start', $('b-start')); },
      allDisabled() {
        return MUTATING_CONTROL_IDS.every((id) => $(id).disabled) &&
          [...dynamicButtons, ...providerButtons].every((button) => button.disabled);
      },
      controlDisabled(id) { return $(id).disabled; },
      dynamicDisabled() { return dynamicButtons.every((button) => button.disabled); },
      dynamicCount() { return dynamicButtons.length; },
      liveText() { return $('livetxt').textContent; },
      modeText() { return $('mode').textContent; },
      snapshotWorkersAreArray() { return Array.isArray(S?.protocol?.workers); },
      committedFresh() { return controlFresh; },
      posts() { return postCount; },
      hasSnapshot() { return S !== null; },
    };
  `)();
}

const goodSnapshot = {
  protocol: {
    mode: 'run',
    phase: 'stopped',
    masterHeartbeatAge: null,
    workers: [],
    queue: [],
    events: [],
  },
  docker: {
    multi: { containers: [] },
    single: { containers: [] },
  },
  github: {
    issues: [],
    prs: [],
    merged: [],
    needsHuman: [],
  },
  ledger: { records: 0, multiByIssue: {} },
  usage: {},
  triggers: [
    {
      id: 'proof-trigger',
      type: 'timer',
      fireAt: '2099-01-01T00:00:00.000Z',
      action: 'mode-close-down',
      armed: true,
    },
  ],
  workers: { desired: 2, visible: 0 },
  inflight: [],
  models: { difficulties: {}, roles: {} },
  providers: {},
};

const malformedSnapshot = structuredClone(goodSnapshot);
malformedSnapshot.protocol.workers = {};

test('SSE snapshots commit transactionally and every failed render stays read-only', async () => {
  const firstMalformed = lifecycleHarness();
  firstMalformed.emit(malformedSnapshot);
  assert.equal(firstMalformed.liveText(), 'invalid snapshot');
  assert.equal(firstMalformed.committedFresh(), false);
  assert.equal(firstMalformed.hasSnapshot(), false);
  assert.equal(firstMalformed.allDisabled(), true);
  await firstMalformed.requestStart();
  assert.equal(firstMalformed.posts(), 0);

  firstMalformed.emit(goodSnapshot);
  assert.equal(firstMalformed.liveText(), 'live');
  assert.equal(firstMalformed.committedFresh(), true);
  assert.equal(firstMalformed.controlDisabled('b-start'), false);
  assert.equal(firstMalformed.dynamicCount(), 1);
  assert.equal(firstMalformed.dynamicDisabled(), false);

  firstMalformed.emit(malformedSnapshot);
  assert.equal(firstMalformed.liveText(), 'invalid snapshot');
  assert.equal(firstMalformed.committedFresh(), false);
  assert.equal(firstMalformed.modeText(), 'run');
  assert.equal(firstMalformed.snapshotWorkersAreArray(), true);
  assert.equal(firstMalformed.allDisabled(), true);
  await firstMalformed.requestStart();
  assert.equal(firstMalformed.posts(), 0);

  const firstRenderThrows = lifecycleHarness();
  firstRenderThrows.failNextRender();
  firstRenderThrows.emit(goodSnapshot);
  assert.equal(firstRenderThrows.liveText(), 'invalid snapshot');
  assert.equal(firstRenderThrows.committedFresh(), false);
  assert.equal(firstRenderThrows.hasSnapshot(), false);
  assert.equal(firstRenderThrows.allDisabled(), true);
  await firstRenderThrows.requestStart();
  assert.equal(firstRenderThrows.posts(), 0);
});
