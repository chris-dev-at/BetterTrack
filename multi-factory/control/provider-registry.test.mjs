import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTIES,
  PINNABLE_ROLES,
  PROVIDER_IDS,
  SLOTS,
  composerRouteAllowed,
  defaultRouteForProvider,
  entryRoutes,
  expectedModelSelector,
  isOpusFiveModel,
  normalizeModelRouting,
  normalizeProviderModel,
  normalizeRolePin,
  normalizeRouteEntry,
  normalizeSlotRoutes,
  providerDefinition,
  providerEfforts,
  publicProviderRegistry,
  validateRouteEntry,
} from './provider-registry.mjs';

test('composer accepts only Fable, Opus, or Sol routes', () => {
  assert.equal(
    composerRouteAllowed({ provider: 'claude', model: 'claude-fable-5', effort: 'max' }),
    true,
  );
  assert.equal(
    composerRouteAllowed({ provider: 'claude', model: 'claude-opus-4-8', effort: 'xhigh' }),
    true,
  );
  assert.equal(
    composerRouteAllowed({ provider: 'claudex', model: 'codex-api/gpt-5.6-sol', effort: 'xhigh' }),
    true,
  );
  assert.equal(
    composerRouteAllowed({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' }),
    true,
  );
  for (const route of [
    { provider: 'claude', model: 'claude-sonnet-5', effort: 'high' },
    { provider: 'claude', model: 'claude-haiku-4-5', effort: 'high' },
    { provider: 'claudex', model: 'gpt-5.6-terra', effort: 'xhigh' },
    { provider: 'codex', model: 'gpt-5.6-luna', effort: 'high' },
    { provider: 'gemini', model: 'Gemini 3.1 Pro (High)' },
    { provider: 'opencode', model: 'openrouter/stealth/ox-alpha' },
  ])
    assert.equal(composerRouteAllowed(route), false, `${route.provider}/${route.model}`);
});

test('opencode routes validate as an API-key provider with slashed model ids', () => {
  const opencode = publicProviderRegistry().find((entry) => entry.id === 'opencode');
  assert.equal(opencode.providerFamily, 'openrouter');
  assert.equal(opencode.harness, 'opencode-cli');
  // NOT "subscription": OpenRouter bills per token and the preview is only
  // temporarily free, so a $0 ledger row must never read as structural.
  assert.equal(opencode.billing, 'free-preview');
  assert.equal(opencode.experimental, true);
  assert.equal(opencode.capabilities.retainsPrompts, true);
  assert.deepEqual(opencode.efforts, []);

  // The provider separator makes slashes legal here, unlike every other route.
  assert.equal(
    validateRouteEntry({ provider: 'opencode', model: 'openrouter/stealth/ox-alpha' }),
    true,
  );
  assert.deepEqual(
    normalizeRouteEntry({ provider: 'opencode', model: 'openrouter/stealth/ox-alpha' }),
    { provider: 'opencode', model: 'openrouter/stealth/ox-alpha' },
  );
  // No variant is verified for this provider, so any effort must be refused
  // rather than silently dropped by the CLI.
  assert.equal(
    validateRouteEntry({
      provider: 'opencode',
      model: 'openrouter/stealth/ox-alpha',
      effort: 'high',
    }),
    false,
  );
  // Same selector guard as cc_opencode in mflib.sh.
  for (const model of ['openrouter/a|b', 'openrouter/a b', '/leading-slash', 'a\nb'])
    assert.equal(validateRouteEntry({ provider: 'opencode', model }), false, model);
});

test('registry exposes five stable providers and explicit route metadata', () => {
  assert.deepEqual(PROVIDER_IDS, ['claude', 'claudex', 'codex', 'gemini', 'opencode']);
  const entries = publicProviderRegistry();
  const claudex = entries.find((entry) => entry.id === 'claudex');
  assert.equal(claudex.label, 'ClaudeX (Claude Code + Codex OAuth)');
  assert.equal(claudex.providerFamily, 'openai');
  assert.equal(claudex.harness, 'claude-code');
  assert.equal(claudex.billing, 'subscription');
  assert.equal(claudex.experimental, true);
  assert.equal(claudex.capabilities.freeTextModel, true);
  assert.equal(claudex.capabilities.containerTest, true);
  assert.ok(claudex.modelSuggestions.includes('gpt-5.6-sol'));
  assert.ok(claudex.modelSuggestions.includes('gpt-5.6-terra'));
  assert.ok(claudex.modelSuggestions.includes('gpt-5.6-luna'));
});

test('public registry is a detached copy of the validation registry', () => {
  const first = publicProviderRegistry();
  first[0].modelSuggestions.push('mutation');
  first[0].capabilities.freeTextModel = false;
  const second = publicProviderRegistry();
  assert.ok(!second[0].modelSuggestions.includes('mutation'));
  assert.equal(second[0].capabilities.freeTextModel, true);
});

test('ClaudeX accepts free-text models and normalizes the CCR selector prefix', () => {
  assert.equal(normalizeProviderModel('claudex', ' codex-api/gpt-custom '), 'gpt-custom');
  assert.equal(expectedModelSelector('claudex', 'codex-api/gpt-custom'), 'codex-api/gpt-custom');
  assert.equal(
    validateRouteEntry({
      provider: 'claudex',
      model: 'codex-api/gpt-custom',
      effort: 'high',
    }),
    true,
  );
  assert.deepEqual(
    normalizeRouteEntry({
      provider: 'claudex',
      model: ' codex-api/gpt-custom ',
      effort: 'high',
    }),
    { provider: 'claudex', model: 'gpt-custom', effort: 'high' },
  );
});

test('effort validation is harness- and model-aware', () => {
  assert.equal(providerEfforts('claudex', 'gpt-5.6-sol').includes('ultra'), false);
  assert.equal(
    validateRouteEntry({ provider: 'claudex', model: 'gpt-5.6-sol', effort: 'ultra' }),
    false,
  );
  assert.equal(
    validateRouteEntry({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' }),
    true,
  );
  assert.equal(
    validateRouteEntry({ provider: 'codex', model: 'gpt-5.6-luna', effort: 'ultra' }),
    false,
  );
  assert.equal(
    validateRouteEntry({ provider: 'gemini', model: 'Gemini custom', effort: undefined }),
    true,
  );
  assert.equal(
    validateRouteEntry({ provider: 'gemini', model: 'Gemini custom', effort: 'high' }),
    false,
  );
});

test('route validation rejects unknown providers, blank/control-character models and bad efforts', () => {
  assert.equal(validateRouteEntry({ provider: 'other', model: 'x', effort: 'high' }), false);
  assert.equal(validateRouteEntry({ provider: 'claudex', model: ' ', effort: 'high' }), false);
  assert.equal(
    validateRouteEntry({ provider: 'claudex', model: 'gpt\nsecret', effort: 'high' }),
    false,
  );
  assert.equal(
    validateRouteEntry({ provider: 'claudex', model: 'other/gpt-model', effort: 'high' }),
    false,
  );
  assert.equal(validateRouteEntry({ provider: 'claudex', model: 'gpt', effort: 'extreme' }), false);
  assert.equal(defaultRouteForProvider('claudex').effort, 'high');
});

test('provider lookup accepts only registry own keys', () => {
  for (const inheritedKey of ['toString', 'constructor', '__proto__']) {
    assert.equal(providerDefinition(inheritedKey), null);
    assert.equal(
      validateRouteEntry({ provider: inheritedKey, model: 'gpt-5.6-sol', effort: 'high' }),
      false,
    );
  }
});

test('routing normalization preserves explicit empty effort and contains malformed persisted data', () => {
  const fallback = {
    version: 1,
    difficulties: Object.fromEntries(
      DIFFICULTIES.map((difficulty) => [
        difficulty,
        { provider: 'claude', model: `fallback-${difficulty}`, effort: 'high' },
      ]),
    ),
    roles: { composer: 'hard', checker: 'hard', reviewFloor: 'intermediate' },
  };
  const normalized = normalizeModelRouting(
    {
      difficulties: {
        easy: { provider: 'claudex', model: 'codex-api/gpt-5.6-luna', effort: '' },
        normal: { provider: 'constructor', model: 'gpt-5.6-sol', effort: 'high' },
        intermediate: null,
        hard: { provider: 'claudex', model: 'other/gpt-5.6-sol', effort: 'high' },
        max: { provider: 'gemini', model: 'Gemini custom', effort: '' },
      },
      roles: { composer: 'toString', checker: 'max', reviewFloor: '__proto__' },
    },
    fallback,
  );
  assert.deepEqual(normalized.difficulties.easy, {
    provider: 'claudex',
    model: 'gpt-5.6-luna',
    effort: '',
  });
  assert.deepEqual(normalized.difficulties.normal, fallback.difficulties.normal);
  assert.deepEqual(normalized.difficulties.intermediate, fallback.difficulties.intermediate);
  assert.deepEqual(normalized.difficulties.hard, fallback.difficulties.hard);
  assert.deepEqual(normalized.difficulties.max, {
    provider: 'gemini',
    model: 'Gemini custom',
    effort: '',
  });
  assert.deepEqual(normalized.roles, {
    composer: 'hard',
    checker: 'max',
    reviewFloor: 'intermediate',
  });
});

test('slot order matches MF_SLOT_ORDER in mflib.sh', () => {
  assert.deepEqual(SLOTS, ['writer', 'reviewer1', 'completion']);
});

test('Opus 5 can never be routed above xhigh, in any shape', () => {
  assert.equal(isOpusFiveModel('claude-opus-5'), true);
  assert.equal(isOpusFiveModel('claude-opus-5-20260514'), true);
  assert.equal(isOpusFiveModel('claude-opus-4-8'), false);
  assert.equal(isOpusFiveModel('claude-fable-5'), false);
  assert.deepEqual(providerEfforts('claude', 'claude-opus-5'), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(providerEfforts('claude', 'claude-opus-5-20260514').includes('max'), false);
  assert.equal(
    validateRouteEntry({ provider: 'claude', model: 'claude-opus-5', effort: 'max' }),
    false,
  );
  assert.equal(
    validateRouteEntry({ provider: 'claude', model: 'claude-opus-5-20260514', effort: 'max' }),
    false,
  );
  assert.equal(
    validateRouteEntry({ provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' }),
    true,
  );
  // other Claude models keep their full effort range
  assert.equal(
    validateRouteEntry({ provider: 'claude', model: 'claude-fable-5', effort: 'max' }),
    true,
  );
  // the cap also binds when an opus-5 route appears inside a slot object
  assert.equal(
    normalizeSlotRoutes({
      writer: { provider: 'claude', model: 'claude-opus-5', effort: 'max' },
      reviewer1: { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
    }).writer,
    undefined,
  );
  assert.ok(
    publicProviderRegistry()
      .find((p) => p.id === 'claude')
      .modelSuggestions.includes('claude-opus-5'),
  );
});

test('v2 slotted routing normalizes per slot and survives round-tripping', () => {
  const raw = {
    version: 2,
    difficulties: {
      hard: {
        provider: 'claude',
        model: 'claude-opus-5',
        effort: 'xhigh',
        writer: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' },
        reviewer1: { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
        completion: { provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' },
      },
      max: {
        provider: 'claude',
        model: 'claude-fable-5',
        effort: 'xhigh',
        writer: { provider: 'claude', model: 'claude-fable-5', effort: 'xhigh' },
        reviewer1: { provider: 'constructor', model: 'gpt-5.6-sol', effort: 'ultra' },
        completion: { provider: 'claudex', model: ' codex-api/gpt-5.6-sol ', effort: 'high' },
      },
    },
  };
  const normalized = normalizeModelRouting(raw, { difficulties: {}, roles: {} });
  assert.equal(normalized.version, 2);
  assert.deepEqual(normalized.difficulties.hard.writer, {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });
  assert.deepEqual(normalized.difficulties.hard.reviewer1, {
    provider: 'claude',
    model: 'claude-opus-5',
    effort: 'xhigh',
  });
  // invalid slot providers are dropped, valid siblings survive and normalize
  assert.equal(normalized.difficulties.max.reviewer1, undefined);
  assert.deepEqual(normalized.difficulties.max.completion, {
    provider: 'claudex',
    model: 'gpt-5.6-sol',
    effort: 'high',
  });
  // flat mirror keys stay intact for pre-slot readers
  assert.equal(normalized.difficulties.hard.provider, 'claude');
  assert.equal(normalized.difficulties.hard.model, 'claude-opus-5');
  // a flat v1 config stays version 1 with no slot keys invented
  const flat = normalizeModelRouting(
    { difficulties: { easy: { provider: 'codex', model: 'gpt-5.6-terra', effort: 'max' } } },
    { difficulties: {}, roles: {} },
  );
  assert.equal(flat.version, 1);
  assert.equal(flat.difficulties.easy.writer, undefined);
  // entryRoutes surfaces flat + slot routes for provider scans
  assert.equal(entryRoutes(normalized.difficulties.hard).length, 4);
  assert.equal(entryRoutes(flat.difficulties.easy).length, 1);
});

test('role pins: object entries pin a role, strings keep difficulty semantics', () => {
  // mirror of the role set mflib.sh scans; reviewFloor is deliberately not pinnable
  assert.deepEqual(PINNABLE_ROLES, [
    'composer',
    'checker',
    'writer',
    'reviewer',
    'fixer',
    'ci-fix',
  ]);
  assert.deepEqual(
    normalizeRolePin({ provider: 'claude', model: 'claude-fable-5', effort: 'xhigh' }),
    {
      provider: 'claude',
      model: 'claude-fable-5',
      effort: 'xhigh',
    },
  );
  // strings and absent entries are not pins
  assert.equal(normalizeRolePin('hard'), null);
  assert.equal(normalizeRolePin(undefined), null);
  assert.equal(normalizeRolePin(null), null);
  assert.equal(normalizeRolePin(['claude']), null);
  // malformed pins are rejected (unknown provider, missing model, bad effort)
  assert.equal(normalizeRolePin({ provider: 'constructor', model: 'x', effort: 'high' }), null);
  assert.equal(normalizeRolePin({ provider: 'claude', model: '', effort: 'high' }), null);
  assert.equal(
    normalizeRolePin({ provider: 'codex', model: 'gpt-5.6-sol', effort: 'turbo' }),
    null,
  );
  // HARD RULE: an Opus 5 pin above xhigh is never valid, dated ids included
  assert.equal(
    normalizeRolePin({ provider: 'claude', model: 'claude-opus-5', effort: 'max' }),
    null,
  );
  assert.equal(
    normalizeRolePin({ provider: 'claude', model: 'claude-opus-5-20260514', effort: 'max' }),
    null,
  );
  assert.deepEqual(
    normalizeRolePin({ provider: 'claude', model: 'claude-opus-5', effort: 'xhigh' }),
    {
      provider: 'claude',
      model: 'claude-opus-5',
      effort: 'xhigh',
    },
  );
});

test('routing normalization round-trips role pins without corrupting them', () => {
  const fallbackRoles = { composer: 'hard', checker: 'hard', reviewFloor: 'intermediate' };
  const normalized = normalizeModelRouting(
    {
      difficulties: {},
      roles: {
        composer: { provider: 'claude', model: 'claude-fable-5', effort: 'xhigh' },
        checker: 'hard',
        reviewer: { provider: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' },
        fixer: 'intermediate', // inert string under a worker role — preserved verbatim
        'ci-fix': { provider: 'claude', model: 'claude-opus-5', effort: 'max' }, // over-cap → dropped
        reviewFloor: { provider: 'claude', model: 'claude-fable-5' }, // floor is never a pin
      },
    },
    { difficulties: {}, roles: fallbackRoles },
  );
  assert.deepEqual(normalized.roles.composer, {
    provider: 'claude',
    model: 'claude-fable-5',
    effort: 'xhigh',
  });
  assert.equal(normalized.roles.checker, 'hard');
  assert.deepEqual(normalized.roles.reviewer, {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'ultra',
  });
  assert.equal(normalized.roles.fixer, 'intermediate');
  assert.equal(normalized.roles['ci-fix'], undefined);
  assert.equal(normalized.roles.reviewFloor, 'intermediate'); // fallback, pin ignored
  assert.equal(normalized.version, 2); // pins are v2 schema
  // a pin-free config keeps byte-identical legacy roles handling
  const flat = normalizeModelRouting(
    { difficulties: {}, roles: { composer: 'max', checker: 'hard', reviewFloor: 'easy' } },
    { difficulties: {}, roles: fallbackRoles },
  );
  assert.deepEqual(flat.roles, { composer: 'max', checker: 'hard', reviewFloor: 'easy' });
  assert.equal(flat.version, 1);
});
