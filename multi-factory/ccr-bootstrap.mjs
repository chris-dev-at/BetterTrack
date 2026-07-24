import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CCR_VERSION,
  FACTORY_PROFILE,
  PROVIDER_ID,
  PROVIDER_MARKER,
  ccrHome,
  codexHome,
  gatewayHealthy,
  hasApiOpenAiHost,
  installedCcrVersion,
  isCodexOAuthUpstream,
  readServiceContext,
  rpc,
  sanitizeModels,
  sanitizedStatus,
  sleep,
  validateConfig,
  writeSanitizedStatus,
} from './ccr-common.mjs';

function replacePluginPlaceholders(value) {
  return JSON.parse(
    JSON.stringify(value)
      .replaceAll('__CCR_PROVIDER_INTERNAL_NAME__', `${PROVIDER_ID}::openai_responses`)
      .replaceAll('__CCR_PROVIDER_NAME_SLUG__', PROVIDER_ID)
      .replaceAll('__CCR_PROVIDER_NAME__', PROVIDER_ID),
  );
}

function scrubProfile(profile) {
  const env = { ...(profile?.env || {}) };
  for (const key of [
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL',
    'CLAUDE_AGENT_API_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_VERTEX',
  ]) {
    delete env[key];
  }
  return { ...profile, env };
}

export function buildFactoryConfig(config, imported) {
  if (
    imported?.provider?.apiKey !== PROVIDER_MARKER ||
    imported?.provider?.protocol !== 'openai_responses'
  ) {
    throw new Error('Imported Codex authentication mode is invalid');
  }

  let importedBaseUrl;
  try {
    importedBaseUrl = new URL(imported.provider.baseUrl);
  } catch {
    throw new Error('Imported Codex upstream is invalid');
  }
  if (!isCodexOAuthUpstream(importedBaseUrl)) {
    throw new Error('Imported Codex upstream is invalid');
  }

  const models = sanitizeModels(imported.provider.models);
  for (const required of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    if (!models.includes(required)) {
      throw new Error('Imported Codex model catalog is incomplete');
    }
  }

  if (!Array.isArray(imported.providerPlugins) || imported.providerPlugins.length !== 2) {
    throw new Error('Imported Codex OAuth plugins are incomplete');
  }
  const providerPlugins = imported.providerPlugins.map(replacePluginPlaceholders);
  if (
    providerPlugins.some(
      (plugin) =>
        !plugin ||
        typeof plugin !== 'object' ||
        Array.isArray(plugin) ||
        Array.isArray(plugin.value),
    )
  ) {
    throw new Error('Imported Codex OAuth plugins are not flat');
  }
  const serializedPlugins = JSON.stringify(providerPlugins);
  if (
    serializedPlugins.includes('__CCR_PROVIDER_') ||
    (serializedPlugins.match(/codexOauth/g) || []).length < 2
  ) {
    throw new Error('Imported Codex OAuth plugins are invalid');
  }

  const provider = {
    account: imported.provider.account,
    api_base_url: importedBaseUrl.toString().replace(/\/$/, ''),
    api_key: PROVIDER_MARKER,
    id: PROVIDER_ID,
    modelDisplayNames: imported.provider.modelDisplayNames,
    modelMetadata: imported.provider.modelMetadata,
    models,
    name: PROVIDER_ID,
    type: 'openai_responses',
  };

  const next = structuredClone(config || {});
  next.Providers = [
    ...(Array.isArray(next.Providers) ? next.Providers : []).filter(
      (entry) =>
        entry.id !== PROVIDER_ID &&
        entry.name !== PROVIDER_ID &&
        entry.id !== 'openai-api' &&
        !hasApiOpenAiHost(entry),
    ),
    provider,
  ];
  next.providerPlugins = providerPlugins;
  next.preferredProvider = PROVIDER_ID;
  next.HOST = '127.0.0.1';
  next.LOG = false;
  next.gateway = {
    ...(next.gateway || {}),
    coreHost: '127.0.0.1',
    enabled: true,
    host: '127.0.0.1',
  };
  next.observability = {
    ...(next.observability || {}),
    agentAnalysis: false,
    requestLogBodyCapture: 'none',
    requestLogMaxBodyBytes: 0,
    requestLogSuccessSampleRate: 0,
    requestLogs: false,
  };

  const profiles = (next.profile?.profiles || [])
    .filter((profile) => profile.id !== FACTORY_PROFILE)
    .map((profile) => {
      const scrubbed = scrubProfile(profile);
      return profile.id === 'default-claude-code' || profile.id === 'default-codex'
        ? { ...scrubbed, enabled: false }
        : scrubbed;
    });

  profiles.push({
    agent: 'claude-code',
    enabled: true,
    env: {
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    },
    id: FACTORY_PROFILE,
    model: `${PROVIDER_ID}/gpt-5.6-sol`,
    name: 'BetterTrack Factory ClaudeX',
    scope: 'ccr',
    settingsFile: '~/.claude/settings.json',
    smallFastModel: `${PROVIDER_ID}/gpt-5.6-luna`,
    surface: 'cli',
  });

  next.profile = {
    ...(next.profile || {}),
    claudeCode: {
      ...(next.profile?.claudeCode || {}),
      enabled: false,
    },
    codex: {
      ...(next.profile?.codex || {}),
      enabled: false,
    },
    enabled: true,
    profiles,
  };

  if (!validateConfig(next)) {
    throw new Error('Generated ClaudeX configuration failed validation');
  }
  return next;
}

async function waitForGateway() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await gatewayHealthy()) return;
    await sleep(500);
  }
  throw new Error('CCR gateway did not become healthy');
}

export async function bootstrap() {
  const authPath = path.join(codexHome(), 'auth.json');
  if (!fs.existsSync(authPath)) {
    throw new Error('Native Codex authentication is unavailable');
  }
  const version = installedCcrVersion();
  if (version !== CCR_VERSION) {
    throw new Error('Pinned CCR version is not installed');
  }

  fs.mkdirSync(ccrHome(), { mode: 0o700, recursive: true });
  const context = await readServiceContext();
  const config = await rpc(context, 'getConfig');
  const candidates = await rpc(context, 'getLocalAgentProviderCandidates');
  const candidate = Array.isArray(candidates)
    ? candidates.find((entry) => entry.id === PROVIDER_ID)
    : null;

  let nextConfig = config;
  if (candidate?.importable) {
    if (candidate.protocol !== 'openai_responses') {
      throw new Error('Codex OAuth candidate protocol is invalid');
    }
    const providerNames = (config.Providers || [])
      .filter((provider) => provider.id !== PROVIDER_ID && provider.name !== PROVIDER_ID)
      .map((provider) => provider.name)
      .filter(Boolean);
    const imported = await rpc(context, 'importLocalAgentProvider', {
      id: PROVIDER_ID,
      providerNames,
    });
    nextConfig = buildFactoryConfig(config, imported);
    await rpc(context, 'saveConfig', nextConfig, { applyProfile: false });
  } else if (!validateConfig(config)) {
    throw new Error('Codex OAuth candidate is not importable');
  }

  await rpc(context, 'restartGateway');
  await waitForGateway();

  const savedConfig = await rpc(context, 'getConfig');
  if (!validateConfig(savedConfig)) {
    throw new Error('Saved ClaudeX configuration failed validation');
  }
  writeSanitizedStatus(sanitizedStatus(savedConfig, version));
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  bootstrap().catch((error) => {
    const message = error instanceof Error ? error.message : 'ClaudeX bootstrap failed';
    process.stderr.write(`ClaudeX bootstrap failed: ${message}\n`);
    process.exitCode = 1;
  });
}
