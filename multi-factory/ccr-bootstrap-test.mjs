import assert from 'node:assert/strict';

import { buildFactoryConfig } from './ccr-bootstrap.mjs';
import { sanitizedStatus, validateConfig } from './ccr-common.mjs';

const imported = {
  provider: {
    account: { enabled: true },
    apiKey: 'ccr-local-agent-login',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    modelDisplayNames: {},
    modelMetadata: {},
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    protocol: 'openai_responses',
  },
  providerPlugins: [
    {
      codexOauth: true,
      providerName: '__CCR_PROVIDER_NAME__',
    },
    {
      codexOauth: true,
      providerInternalName: '__CCR_PROVIDER_INTERNAL_NAME__',
    },
  ],
};

const base = {
  Providers: [
    {
      api_base_url: 'https://api.openai.com/v1',
      api_key: 'must-be-removed',
      id: 'openai-api',
      name: 'OpenAI',
    },
    {
      api_base_url: 'https://example.invalid',
      api_key: 'other-provider',
      id: 'other',
      name: 'other',
    },
  ],
  profile: {
    profiles: [
      {
        agent: 'claude-code',
        enabled: true,
        env: { ANTHROPIC_API_KEY: 'must-be-removed' },
        id: 'default-claude-code',
      },
      {
        agent: 'codex',
        enabled: true,
        env: { OPENAI_API_KEY: 'must-be-removed' },
        id: 'default-codex',
      },
    ],
  },
};

const config = buildFactoryConfig(base, imported);
assert.equal(validateConfig(config), true);
assert.equal(
  config.Providers.some((provider) =>
    String(provider.api_base_url || '').includes('api.openai.com'),
  ),
  false,
);
assert.equal(config.Providers.find((entry) => entry.id === 'codex-api').name, 'codex-api');
assert.equal(config.providerPlugins.length, 2);
assert.equal(Array.isArray(config.providerPlugins[0].value), false);
assert.equal(JSON.stringify(config.profile.profiles).includes('must-be-removed'), false);

const status = sanitizedStatus(config, '3.0.7');
assert.deepEqual(
  {
    authMode: status.authMode,
    configured: status.configured,
    directOpenAiProvider: status.directOpenAiProvider,
    oauthPluginCount: status.oauthPluginCount,
    providerId: status.providerId,
    providerName: status.providerName,
    requestLogging: status.requestLogging,
    runtimeReady: status.runtimeReady,
    upstreamHost: status.upstreamHost,
    version: status.version,
  },
  {
    authMode: 'codex-oauth',
    configured: true,
    directOpenAiProvider: false,
    oauthPluginCount: 2,
    providerId: 'codex-api',
    providerName: 'codex-api',
    requestLogging: false,
    runtimeReady: true,
    upstreamHost: 'chatgpt.com',
    version: '3.0.7',
  },
);
assert.equal(JSON.stringify(status).includes('api_key'), false);
assert.equal(JSON.stringify(status).includes('backend-api'), false);

assert.throws(
  () =>
    buildFactoryConfig(base, {
      ...imported,
      providerPlugins: [{ value: imported.providerPlugins }],
    }),
  /plugins/,
);
assert.throws(
  () =>
    buildFactoryConfig(base, {
      ...imported,
      provider: {
        ...imported.provider,
        models: ['gpt-5.6-sol'],
      },
    }),
  /catalog/,
);
assert.throws(
  () =>
    buildFactoryConfig(base, {
      ...imported,
      provider: {
        ...imported.provider,
        baseUrl: 'https://chatgpt.com/backend-api/codex?unexpected=1',
      },
    }),
  /upstream/,
);

process.stdout.write('CCR bootstrap tests: 13 passed\n');
