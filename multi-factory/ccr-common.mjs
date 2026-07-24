import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CCR_VERSION = process.env.CCR_EXPECTED_VERSION || '3.0.7';
export const FACTORY_PROFILE = process.env.CCR_FACTORY_PROFILE || 'bettertrack-factory-claudex';
export const PROVIDER_ID = 'codex-api';
export const PROVIDER_MARKER = 'ccr-local-agent-login';
export const REQUIRED_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

export function ccrHome() {
  return process.env.CCR_HOME || path.join(os.homedir(), '.claude-code-router');
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function isLoopback(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}

export function scrubProviderEnv(source = process.env) {
  const env = { ...source };
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
  return env;
}

export function modelCacheFingerprint() {
  const cachePath = path.join(codexHome(), 'models_cache.json');
  if (!fs.existsSync(cachePath)) return null;
  try {
    return createHash('sha256').update(fs.readFileSync(cachePath)).digest('hex');
  } catch {
    return null;
  }
}

export function installedCcrVersion() {
  const npmRoot = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf8',
    env: scrubProviderEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (npmRoot.status !== 0) return null;
  const packagePath = path.join(
    npmRoot.stdout.trim(),
    '@musistudio',
    'claude-code-router',
    'package.json',
  );
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function sanitizeModels(models) {
  if (!Array.isArray(models)) return [];
  return [
    ...new Set(
      models.filter(
        (model) => typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model),
      ),
    ),
  ];
}

export function hasApiOpenAiHost(entry) {
  try {
    return new URL(entry?.api_base_url || entry?.baseUrl || '').hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

export function isCodexOAuthUpstream(url) {
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  return (
    url.protocol === 'https:' &&
    url.hostname === 'chatgpt.com' &&
    normalizedPath === '/backend-api/codex' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
  );
}

function flatOAuthPlugins(config) {
  const plugins = config?.providerPlugins;
  if (!Array.isArray(plugins) || plugins.length !== 2) return false;
  if (
    plugins.some(
      (plugin) =>
        !plugin ||
        typeof plugin !== 'object' ||
        Array.isArray(plugin) ||
        Array.isArray(plugin.value),
    )
  ) {
    return false;
  }
  const serialized = JSON.stringify(plugins);
  return (
    !serialized.includes('__CCR_PROVIDER_') && (serialized.match(/codexOauth/g) || []).length >= 2
  );
}

function profilesContainSecrets(config) {
  const forbidden = new Set([
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]);
  return (config?.profile?.profiles || []).some((profile) =>
    Object.keys(profile?.env || {}).some((key) => forbidden.has(key)),
  );
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') return false;
  const providers = Array.isArray(config.Providers) ? config.Providers : [];
  const provider = providers.find((entry) => entry.id === PROVIDER_ID);
  if (!provider || providers.filter((entry) => entry.id === PROVIDER_ID).length !== 1) {
    return false;
  }

  let upstream;
  try {
    upstream = new URL(provider.api_base_url || '');
  } catch {
    return false;
  }

  const models = sanitizeModels(provider.models);
  const profile = (config.profile?.profiles || []).find((entry) => entry.id === FACTORY_PROFILE);
  const defaultsDisabled = (config.profile?.profiles || [])
    .filter((entry) => entry.id === 'default-claude-code' || entry.id === 'default-codex')
    .every((entry) => entry.enabled === false);

  return (
    provider.name === PROVIDER_ID &&
    provider.type === 'openai_responses' &&
    provider.api_key === PROVIDER_MARKER &&
    isCodexOAuthUpstream(upstream) &&
    REQUIRED_MODELS.every((model) => models.includes(model)) &&
    !providers.some((entry) => entry.id === 'openai-api' || hasApiOpenAiHost(entry)) &&
    flatOAuthPlugins(config) &&
    config.preferredProvider === PROVIDER_ID &&
    config.HOST === '127.0.0.1' &&
    config.gateway?.enabled === true &&
    config.gateway?.host === '127.0.0.1' &&
    config.gateway?.coreHost === '127.0.0.1' &&
    config.observability?.requestLogs === false &&
    config.observability?.agentAnalysis === false &&
    config.observability?.requestLogBodyCapture === 'none' &&
    config.observability?.requestLogMaxBodyBytes === 0 &&
    config.observability?.requestLogSuccessSampleRate === 0 &&
    profile?.enabled === true &&
    profile?.agent === 'claude-code' &&
    profile?.scope === 'ccr' &&
    profile?.surface === 'cli' &&
    profile?.model === `${PROVIDER_ID}/gpt-5.6-sol` &&
    defaultsDisabled &&
    config.profile?.claudeCode?.enabled === false &&
    config.profile?.codex?.enabled === false &&
    !profilesContainSecrets(config)
  );
}

export async function readServiceContext() {
  const servicePath = process.env.CCR_SERVICE_FILE || path.join(ccrHome(), 'service.json');
  if (!fs.existsSync(servicePath)) {
    throw new Error('CCR management state is unavailable');
  }
  let serviceUrl;
  try {
    const service = JSON.parse(fs.readFileSync(servicePath, 'utf8'));
    serviceUrl = new URL(service.url);
  } catch {
    throw new Error('CCR management state is invalid');
  }
  if (!isLoopback(serviceUrl.hostname)) {
    throw new Error('CCR management service is not loopback-bound');
  }
  const webToken = serviceUrl.searchParams.get('ccr_web_token');
  if (!webToken) {
    throw new Error('CCR management authentication is unavailable');
  }
  return {
    rpcUrl: new URL('/api/ccr/rpc', serviceUrl),
    webToken,
  };
}

export async function rpc(context, method, ...args) {
  let response;
  try {
    response = await fetch(context.rpcUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ccr-web-auth': context.webToken,
      },
      body: JSON.stringify({ method, args }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`CCR ${method} RPC is unavailable`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`CCR ${method} RPC returned invalid data`);
  }
  if (!response.ok || !body?.ok) {
    throw new Error(`CCR ${method} RPC failed`);
  }
  return body.value;
}

export async function gatewayHealthy() {
  let healthUrl;
  try {
    healthUrl = new URL(process.env.CCR_GATEWAY_HEALTH_URL || 'http://127.0.0.1:3456/health');
    if (!isLoopback(healthUrl.hostname)) return false;
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(3_000),
    });
    const body = await response.json();
    return response.ok && body.status === 'running';
  } catch {
    return false;
  }
}

export function sanitizedStatus(config, version = installedCcrVersion()) {
  const provider = (config?.Providers || []).find((entry) => entry.id === PROVIDER_ID);
  return {
    configured: true,
    providerId: PROVIDER_ID,
    providerName: PROVIDER_ID,
    authMode: 'codex-oauth',
    upstreamHost: 'chatgpt.com',
    oauthPluginCount: Array.isArray(config?.providerPlugins) ? config.providerPlugins.length : 0,
    directOpenAiProvider: false,
    runtimeReady: true,
    models: sanitizeModels(provider?.models),
    version,
    modelCacheSha256: modelCacheFingerprint(),
    requestLogging: false,
    updatedAt: new Date().toISOString(),
  };
}

export function writeSanitizedStatus(status) {
  const home = ccrHome();
  fs.mkdirSync(home, { mode: 0o700, recursive: true });
  try {
    fs.chmodSync(home, 0o700);
  } catch {
    // A bind mount may not support chmod; the host launcher also protects it.
  }
  const target = path.join(home, 'factory-status.json');
  const temporary = path.join(home, `.factory-status.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(status)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, target);
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // See directory chmod note above.
  }
}

export function statusNeedsRefresh() {
  const target = path.join(ccrHome(), 'factory-status.json');
  try {
    const status = JSON.parse(fs.readFileSync(target, 'utf8'));
    return (
      status.configured !== true ||
      status.providerId !== PROVIDER_ID ||
      status.providerName !== PROVIDER_ID ||
      status.authMode !== 'codex-oauth' ||
      status.upstreamHost !== 'chatgpt.com' ||
      status.oauthPluginCount !== 2 ||
      status.directOpenAiProvider !== false ||
      status.runtimeReady !== true ||
      !REQUIRED_MODELS.every((model) => sanitizeModels(status.models).includes(model)) ||
      status.version !== CCR_VERSION ||
      status.modelCacheSha256 !== modelCacheFingerprint() ||
      status.requestLogging !== false
    );
  } catch {
    return true;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
