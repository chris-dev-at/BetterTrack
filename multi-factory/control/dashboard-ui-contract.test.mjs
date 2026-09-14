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

function rgb(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function luminance(hex) {
  const channels = rgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('dashboard JavaScript parses', () => {
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('runtime, GitHub and control failures stay distinct from a healthy stopped state', () => {
  const helpers = new Function(`
    let controlFresh = true;
    let renderingFresh = false;
    ${between(script, 'const finiteNumber =', 'function renderHead')}
    return {
      runtimeState,
      githubState,
      controlPlaneState,
      reportedAmount,
      fmtCliUsd,
      ledgerAmount,
      validSnapshot,
      setControlFresh(value) { controlFresh = value; },
    };
  `)();

  assert.deepEqual(
    {
      available: helpers.runtimeState({ containers: [] }).available,
      running: helpers.runtimeState({ containers: [] }).running,
    },
    { available: true, running: false },
  );
  assert.equal(
    helpers.runtimeState({ containers: [], error: 'Docker socket unavailable' }).available,
    false,
  );
  assert.equal(helpers.runtimeState({ containers: [], available: false }).available, false);

  const githubPayload = { issues: [], prs: [], merged: [], needsHuman: [] };
  assert.equal(helpers.githubState({ github: githubPayload }).available, true);
  assert.equal(
    helpers.githubState({ github: { ...githubPayload, error: 'GitHub CLI failed' } }).available,
    false,
  );
  assert.equal(helpers.githubState({ github: null }).available, false);

  assert.equal(helpers.controlPlaneState({}).available, true);
  helpers.setControlFresh(false);
  assert.equal(helpers.controlPlaneState({}).available, false);
  helpers.setControlFresh(true);
  assert.equal(
    helpers.controlPlaneState({ control: { error: 'snapshot failed' } }).available,
    false,
  );
  assert.equal(
    helpers.validSnapshot({
      protocol: { workers: [], queue: [], events: [] },
      docker: { multi: { containers: [] }, single: { containers: [] } },
      github: { issues: [], prs: [], merged: [], needsHuman: [] },
      credentials: {
        providers: {
          claude: {
            profiles: [
              {
                id: '00000000-0000-4000-8000-000000000001',
                name: 'Factory Claude',
                createdAt: '2026-07-30T12:00:00Z',
                updatedAt: '2026-07-30T12:00:00Z',
              },
            ],
            assignments: { default: 'factory-env', master: null },
            login: { status: 'idle', needsCode: false },
          },
        },
      },
    }),
    true,
  );
  assert.equal(
    helpers.validSnapshot({
      protocol: { workers: [], queue: [], events: [] },
      docker: { multi: { containers: [] }, single: { containers: [] } },
      github: { issues: [], prs: [], merged: [], needsHuman: [] },
      credentials: {
        providers: {
          claude: {
            profiles: [{ id: 'unsafe', name: 'Unsafe', token: 'must-not-render' }],
            assignments: { default: 'factory-env' },
          },
        },
      },
    }),
    false,
  );
  assert.equal(
    helpers.validSnapshot({
      protocol: { workers: {}, queue: [], events: [] },
      docker: { multi: { containers: [] }, single: { containers: [] } },
      github: { issues: [], prs: [], merged: [], needsHuman: [] },
    }),
    false,
  );
  assert.equal(
    helpers.validSnapshot({
      protocol: { workers: [], queue: [], events: [] },
      docker: { multi: { containers: [] }, single: { containers: [] } },
      github: {
        issues: [],
        prs: [],
        merged: [],
        needsHuman: [],
        awaitingOwner: {},
      },
    }),
    false,
  );
  assert.equal(helpers.validSnapshot({ protocol: {}, docker: {}, github: {} }), false);
  assert.equal(helpers.validSnapshot({}), false);

  assert.match(script, /Control plane unavailable/);
  assert.match(script, /Docker runtime status unavailable/);
  assert.match(script, /GitHub status unavailable/);
  assert.match(script, /startupProblems\.length > 0/);
  assert.match(
    script,
    /renderingFresh = true;[\s\S]*?render\(payload\);[\s\S]*?controlFresh = true;/,
  );
  assert.match(script, /announceInvalidSnapshot\(previous\)/);
  assert.match(script, /disableMutationControls\(\)/);
});

test('missing estimates are unreported while a confirmed numeric zero remains zero', () => {
  const helpers = new Function(`
    ${between(script, 'const finiteNumber =', 'const sourceError =')}
    return { reportedAmount, fmtCliUsd, ledgerAmount };
  `)();

  assert.equal(helpers.reportedAmount(undefined), null);
  assert.equal(helpers.reportedAmount(null), null);
  assert.equal(helpers.reportedAmount(0, { records: 0 }), null);
  assert.equal(helpers.reportedAmount(0, { records: 1 }), 0);
  assert.equal(helpers.reportedAmount(0, { records: 1, pricedRecords: 0 }), null);
  assert.equal(helpers.reportedAmount(0, { records: 1, pricedRecords: 1 }), 0);
  assert.equal(helpers.fmtCliUsd(null), 'Not reported');
  assert.equal(helpers.fmtCliUsd(0), '$0.00');
  assert.equal(helpers.ledgerAmount(null, 'multiTotal'), null);
  assert.equal(helpers.ledgerAmount({ records: 0, multiTotal: 0 }, 'multiTotal'), null);
  assert.equal(helpers.ledgerAmount({ records: 1, multiTotal: 0 }, 'multiTotal'), 0);

  assert.doesNotMatch(script, /\$\{t\.cost \?\? 0\}/);
  assert.doesNotMatch(script, /\$\{led\.multi(?:Today|Total) \?\? 0\}/);
  assert.match(script, /\$\('ua-cli-estimate'\)\.textContent = 'Not reported'/);
  assert.match(script, /\$\('ua-api-estimate'\)\.textContent = 'unavailable'/);
});

test('general economics use API-equivalent money split by Claude and Codex', () => {
  assert.match(html, /All-model API-equivalent total/);
  assert.match(html, /API-equivalent estimate per day — last 14 days/);
  assert.match(script, /x\.claude \+ x\.codex \+ \(x\.other \|\| 0\)/);
  assert.match(script, /title>\$\{x\.date\} Claude:/);
  assert.match(script, /title>\$\{x\.date\} Codex:/);
  assert.doesNotMatch(script, /x\.multi \+ x\.single/);
});

test('Claude account controls expose named profiles and lane assignments without secret fields', () => {
  assert.match(html, /id="claude-accounts-card"/);
  assert.match(html, /claude setup-token/);
  assert.match(html, /id="claude-profile-name"/);
  assert.match(html, /id="claude-assignments"/);
  assert.match(script, /claude-profile-assign/);
  assert.match(script, /claudeAssignmentDraft/);
  assert.match(script, /existingAuthorizationCodeInput/);
  assert.match(script, /data-claude-login-message/);
  assert.match(html, /Changes apply to the next Claude role/);
  assert.match(script, /containsPrivateCredentialField/);
  assert.doesNotMatch(html, /id="claude-(?:oauth-)?token"/i);
  assert.doesNotMatch(html, /id="claude-login-code"[^>]*\svalue=/i);
});

test('Claude account drafts and assignment controls survive duplicate live snapshots', async () => {
  const ui = new Function(`
    class FakeNode {
      constructor(id) {
        this.id = id;
        this.value = '';
        this.disabled = false;
        this.className = '';
        this.textContent = '';
        this.dataset = {};
        this.attributes = new Map();
        this.writes = 0;
        this._innerHTML = '';
      }
      set innerHTML(value) {
        this._innerHTML = String(value);
        this.writes += 1;
      }
      get innerHTML() {
        return this._innerHTML;
      }
      focus() {}
      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      }
      removeAttribute(name) {
        this.attributes.delete(name);
      }
      querySelector() {
        return null;
      }
      querySelectorAll() {
        return [];
      }
    }

    const nodes = new Map(
      [
        'claude-profiles',
        'claude-assignments',
        'claude-login-state',
        'claude-profile-name',
        'claude-login-start',
      ].map((id) => [id, new FakeNode(id)]),
    );
    const $ = (id) => nodes.get(id) || null;
    const esc = (value) => String(value ?? '');
    const tago = () => 'now';
    const toast = () => {};
    const mAllRoutes = () => [];
    const act = async () => ({ ok: true });
    let S = null;
    let available = true;
    const controlPlaneState = () => ({ available });

    ${between(script, 'const claudeAssignmentDraft =', '/* ---- models')}

    return {
      render(snapshot) {
        S = snapshot;
        renderClaudeCredentials(snapshot);
      },
      async start(label) {
        $('claude-profile-name').value = label;
        await claudeLoginStart($('claude-login-start'));
      },
      setLabel(value) {
        $('claude-profile-name').value = value;
      },
      label() {
        return $('claude-profile-name').value;
      },
      writes(id) {
        return $(id).writes;
      },
      html(id) {
        return $(id).innerHTML;
      },
      setAvailable(value) {
        available = value;
      },
    };
  `)();

  const profile = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'First account',
    createdAt: '2026-07-30T12:00:00Z',
    updatedAt: '2026-07-30T12:00:00Z',
  };
  const snapshot = {
    now: '2026-07-30T12:00:02Z',
    workers: { desired: 4 },
    credentials: {
      providers: {
        claude: {
          legacyConfigured: true,
          profiles: [profile],
          assignments: {
            default: 'factory-env',
            master: null,
            'worker-1': null,
            'worker-2': null,
            'worker-3': null,
            'worker-4': null,
          },
          login: {
            status: 'completed',
            name: 'First account',
            profileId: profile.id,
            completedAt: '2026-07-30T12:00:01Z',
            needsCode: false,
          },
        },
      },
    },
  };

  await ui.start('First account');
  ui.render(snapshot);
  assert.equal(ui.label(), '', 'the submitted label clears once after its own completion');
  ui.setLabel('Second account');
  const assignmentWrites = ui.writes('claude-assignments');
  const profileWrites = ui.writes('claude-profiles');
  const loginWrites = ui.writes('claude-login-state');

  ui.render({ ...structuredClone(snapshot), now: '2026-07-30T12:00:04Z' });
  assert.equal(ui.label(), 'Second account');
  assert.equal(ui.writes('claude-assignments'), assignmentWrites);
  assert.equal(ui.writes('claude-profiles'), profileWrites);
  assert.equal(ui.writes('claude-login-state'), loginWrites);

  const secondProfile = {
    ...profile,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Second account',
  };
  const changed = structuredClone(snapshot);
  changed.credentials.providers.claude.profiles.push(secondProfile);
  ui.render(changed);
  assert.equal(ui.writes('claude-assignments'), assignmentWrites + 1);
  assert.equal(ui.writes('claude-profiles'), profileWrites + 1);
  assert.match(ui.html('claude-assignments'), /Second account/);

  ui.setAvailable(false);
  ui.render(changed);
  assert.match(ui.html('claude-assignments'), / disabled/);
  ui.setAvailable(true);
  ui.render(changed);
  assert.doesNotMatch(ui.html('claude-assignments'), / disabled/);
});

test('OpenAI estimate labels preserve CLI, derived, mixed, and unavailable provenance', () => {
  const helpers = new Function(`
    ${between(script, 'const finiteNumber =', 'const sourceError =')}
    ${between(script, 'const fmtEstimate =', 'const coverageText =')}
    return { estimateSourceText };
  `)();

  assert.equal(
    helpers.estimateSourceText({
      cliEstimateUsd: 13.377569,
      cliEstimateRecords: 1,
    }),
    'CLI est. $13.38',
  );
  assert.equal(
    helpers.estimateSourceText({
      derivedEstimateUsd: 0.517693,
      derivedEstimateRecords: 2,
    }),
    'derived est. $0.52',
  );
  assert.equal(
    helpers.estimateSourceText({
      cliEstimateUsd: 13.377569,
      cliEstimateRecords: 1,
      derivedEstimateUsd: 0.517693,
      derivedEstimateRecords: 2,
    }),
    'combined $13.90 · CLI $13.38 + derived $0.52',
  );
  assert.equal(
    helpers.estimateSourceText({
      estimatedUsd: 9.99,
      records: 1,
      pricedRecords: 1,
    }),
    'estimate unavailable',
  );
});

test('legacy control APIs cannot offer a new ClaudeX route but preserve an existing one', () => {
  const providers = new Function(`
    let mLast = '';
    ${between(script, 'const OPENAI_MODELS =', 'const mEfforts =')}
    return {
      syncProviderDefs,
      definitions() { return providerDefs.map(({ id, selectable }) => ({ id, selectable })); },
    };
  `)();

  providers.syncProviderDefs({
    models: {
      difficulties: {
        easy: { provider: 'claude' },
        normal: { provider: 'codex' },
        hard: { provider: 'opencode' },
      },
    },
    providers: {},
  });
  assert.deepEqual(
    providers.definitions().map((entry) => entry.id),
    ['claude', 'codex', 'opencode'],
  );

  providers.syncProviderDefs({
    models: {
      difficulties: {
        max: { provider: 'claudex', model: 'gpt-5.6-sol', effort: 'high' },
      },
    },
    providers: { claudex: { configured: true } },
  });
  assert.deepEqual(
    providers.definitions().find((entry) => entry.id === 'claudex'),
    { id: 'claudex', selectable: false },
  );

  providers.syncProviderDefs({
    models: {
      difficulties: {
        max: { provider: 'claudex', model: 'gpt-5.6-sol', effort: 'high' },
      },
    },
    providerRegistry: [{ id: 'claudex', models: ['gpt-5.6-sol'], efforts: ['high'] }],
    providers: { claudex: { configured: true } },
  });
  assert.deepEqual(
    providers.definitions().find((entry) => entry.id === 'claudex'),
    { id: 'claudex', selectable: true },
  );
});

test('models editor understands v2 role slots and caps Opus 5 below max', () => {
  const helpers = new Function(`
    let mLast = '';
    ${between(script, 'const OPENAI_MODELS =', 'let mDirty =')}
    return { SLOT_LIST, mSlotEntry, mRoutesOf, mEfforts };
  `)();

  assert.deepEqual(helpers.SLOT_LIST, ['writer', 'reviewer1', 'completion']);

  const slotted = {
    provider: 'claude',
    model: 'claude-opus-5',
    effort: 'xhigh',
    writer: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' },
    reviewer1: { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
    completion: { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
  };
  assert.deepEqual(helpers.mSlotEntry(slotted, 'writer'), slotted.writer);
  // a flat v1 entry seeds every slot from its legacy route
  const flat = { provider: 'codex', model: 'gpt-5.6-terra', effort: 'max' };
  assert.deepEqual(helpers.mSlotEntry(flat, 'reviewer1'), flat);
  assert.equal(helpers.mRoutesOf(slotted).length, 4);
  assert.equal(helpers.mRoutesOf(flat).length, 1);
  assert.ok(helpers.mRoutesOf(slotted).some((r) => r.provider === 'codex'));

  // Opus 5 hard cap: no effort above xhigh is offered, including dated ids
  assert.deepEqual(helpers.mEfforts('claude', 'claude-opus-5'), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(helpers.mEfforts('claude', 'claude-opus-5-20260514').includes('max'), false);
  assert.ok(helpers.mEfforts('claude', 'claude-fable-5').includes('max'));

  // rendered routing table carries the Slot column and per-slot inputs
  assert.match(html, />Slot<\/span>/);
  assert.match(script, /data-s="\$\{slot\}"/);
  assert.match(script, /SLOT_LIST\.map\(\(slot, index\)/);
});

test('models editor understands role pins and never corrupts unknown role entries', () => {
  const helpers = new Function(`
    let mLast = '';
    ${between(script, 'const OPENAI_MODELS =', 'let mDirty =')}
    return { mRolePin, mRolePins, mAllRoutes };
  `)();

  const pin = { provider: 'claude', model: 'claude-fable-5', effort: 'xhigh' };
  // a difficulty string is not a pin; an object route is
  assert.equal(helpers.mRolePin('hard'), null);
  assert.equal(helpers.mRolePin(null), null);
  assert.deepEqual(helpers.mRolePin(pin), pin);
  const models = {
    difficulties: { easy: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'max' } },
    roles: {
      composer: pin,
      checker: 'hard',
      reviewer: { provider: 'opencode', model: 'openrouter/stealth/ox-alpha' },
      reviewFloor: 'easy',
    },
  };
  // pins are surfaced (reviewFloor never is), so provider scans see pinned-only providers
  assert.deepEqual(helpers.mRolePins(models), [pin, models.roles.reviewer]);
  const providers = helpers.mAllRoutes(models).map((route) => route.provider);
  assert.ok(providers.includes('codex'));
  assert.ok(providers.includes('claude'));
  assert.ok(providers.includes('opencode'));

  // editor wiring: pin mode option, per-role pinned inputs, base-role passthrough on collect
  assert.match(script, /const PIN_VALUE = '__pin__'/);
  assert.match(script, /data-role="\$\{role\}"/);
  assert.match(script, /const roles = \{ \.\.\.mRolesBase \}/);
  assert.match(script, /mode === PIN_VALUE \? mRolePinCollect\(role\)/);
  // the flow diagram resolves a pinned composer to its pin, not a difficulty row
  assert.match(
    script,
    /composerPin \|\| \(composerEntry \? mSlotEntry\(composerEntry, 'writer'\) : null\)/,
  );
  // static markup carries the pin hosts the renderer fills in
  assert.match(html, /id="m-composer-pin"/);
  assert.match(html, /id="m-checker-pin"/);
});

test('OpenAI issue rows identify Sol, Terra and Luna for model or models payloads', () => {
  const { openAIModelLabel, openAIProviderLabel, openAIHarnessLabel } = new Function(`
    ${between(script, 'const openAIModelLabel =', 'function codexIssueRows')}
    return { openAIModelLabel, openAIProviderLabel, openAIHarnessLabel };
  `)();

  assert.equal(openAIModelLabel('gpt-5.6-sol'), 'Sol (gpt-5.6-sol)');
  assert.equal(openAIModelLabel('codex-api/gpt-5.6-terra'), 'Terra (codex-api/gpt-5.6-terra)');
  assert.equal(openAIModelLabel('gpt-5.6-luna'), 'Luna (gpt-5.6-luna)');
  assert.equal(openAIProviderLabel('claudex'), 'ClaudeX');
  assert.equal(openAIProviderLabel('codex'), 'Native Codex');
  assert.equal(openAIHarnessLabel('claude-code'), 'Claude Code + CCR');
  assert.equal(openAIHarnessLabel('codex-cli'), 'Codex CLI');
  assert.match(script, /Array\.isArray\(r\.models\) \? r\.models : r\.model/);
  assert.match(script, /Array\.isArray\(r\.providers\) \? r\.providers : r\.provider/);
  assert.match(script, /Array\.isArray\(r\.harnesses\) \? r\.harnesses : r\.harness/);
  assert.match(script, /\.\.\.models\.map\(openAIModelLabel\)/);
});

test('sparse history has point markers and range controls expose selection state', () => {
  assert.match(script, /entry\.at - lastAt > 1800000/);
  assert.match(script, /markers \+= `<circle/);
  assert.match(script, /graphic \+= markers/);

  for (const [hours, selected] of [
    ['24', 'false'],
    ['168', 'true'],
    ['720', 'false'],
  ])
    assert.match(
      html,
      new RegExp(
        `data-h="${hours}"[^>]*aria-pressed="${selected}"|aria-pressed="${selected}"[^>]*data-h="${hours}"`,
      ),
    );
  assert.match(script, /entry\.setAttribute\('aria-pressed', String\(selected\)\)/);
});

test('usage filters are labelled and event timestamps meet WCAG AA contrast', () => {
  for (const id of ['ua-codex-range', 'ua-openai-provider', 'ua-openai-harness', 'ua-codex-model'])
    assert.match(html, new RegExp(`<label[^>]+for="${id}"`));

  const timeColor = html.match(/\.event-line time\s*{\s*color:\s*(#[0-9a-f]{6})/i)?.[1];
  const logColors = [...html.matchAll(/\.log\s*{[\s\S]*?background:\s*(#[0-9a-f]{6})/gi)].map(
    (match) => match[1],
  );
  assert.ok(timeColor);
  assert.ok(logColors.length);
  assert.ok(
    contrast(timeColor, logColors.at(-1)) >= 4.5,
    `${timeColor} on ${logColors.at(-1)} must meet WCAG AA`,
  );
  assert.match(script, /const selectOptionRevisions = new Map\(\)/);
});

test('each saved Claude account shows its own quota, not only the master lane', () => {
  // Two subscriptions are held so work can move between them; the move is only
  // decidable when both accounts' remaining quota is on screen at once.
  assert.match(script, /state\.accountUsage/);
  assert.match(script, /credential-usage-meter/);
  assert.match(script, /credential-usage-lanes/);
  assert.match(html, /\.credential-usage-meter\s*\{/);
  // A throttled read must name the throttle and when it lifts, never render as
  // a silently missing account or a zeroed meter.
  assert.match(script, /Anthropic is rate-limiting usage reads/);
  assert.match(script, /retry in \$\{tuntil\(new Date\(u\.retryAt\)/);
  // The panel re-renders when the numbers move, not only when profiles change.
  assert.match(script, /accountUsage: \(state\.accountUsage \|\| \[\]\)\.map/);
});

test('the routing view names the Claude account behind its routes and its quota', () => {
  // Routing picks the model; the account decides whether that model can run at
  // all. Seeing one without the other is what made the limit invisible.
  assert.match(html, /id="routing-accounts"/);
  assert.match(script, /function mRenderRoutingAccounts\(s\)/);
  assert.match(script, /mRenderRoutingAccounts\(s\);/);
  assert.match(html, /\.routing-account\s*\{/);
});

test('quota telemetry is offered where it is missing, and never from the inference token', async () => {
  assert.match(script, /claudeUsageLink/);
  assert.match(script, /claude-usage-link/);
  const server = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  // The factory's setup token is inference-only: /api/oauth/usage answers it 403.
  // Sending it anyway would spend a shared rate budget on a call that cannot work.
  assert.match(server, /const telemetry = await usageTelemetryToken\(cacheKey\)/);
  assert.match(server, /const token = telemetry\.token;/);
  assert.doesNotMatch(server, /const token = credential\.token;/);
  // Binding stores an identity, never a credential.
  assert.match(server, /bindings\[profileId\] = \{ email: who\.email/);
  assert.doesNotMatch(server, /bindings\[profileId\] = \{[^}]*accessToken/);
});
