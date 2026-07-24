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
      protocol: {},
      docker: { multi: {}, single: {} },
      github: {},
    }),
    true,
  );
  assert.equal(helpers.validSnapshot({ protocol: {}, docker: {}, github: {} }), false);
  assert.equal(helpers.validSnapshot({}), false);

  assert.match(script, /Control plane unavailable/);
  assert.match(script, /Docker runtime status unavailable/);
  assert.match(script, /GitHub status unavailable/);
  assert.match(script, /startupProblems\.length > 0/);
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
        hard: { provider: 'gemini' },
      },
    },
    providers: {},
  });
  assert.deepEqual(
    providers.definitions().map((entry) => entry.id),
    ['claude', 'codex', 'gemini'],
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
});
