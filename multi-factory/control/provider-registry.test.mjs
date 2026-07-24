import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_IDS,
  defaultRouteForProvider,
  expectedModelSelector,
  normalizeProviderModel,
  normalizeRouteEntry,
  providerEfforts,
  publicProviderRegistry,
  validateRouteEntry,
} from './provider-registry.mjs';

test('registry exposes four stable providers and explicit route metadata', () => {
  assert.deepEqual(PROVIDER_IDS, ['claude', 'claudex', 'codex', 'gemini']);
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
