import { delimiter, isAbsolute, resolve } from 'node:path';
import {
  expectedModelSelector,
  normalizeProviderModel,
  providerEfforts,
  validateRouteEntry,
} from './provider-registry.mjs';

const MAX_MODELS = 64;
const SAFE_TEXT = /^[\x20-\x7e]+$/;
const CLAUDEX_RUNTIME_VERSION = '3.0.7';

export function createExclusiveOperation() {
  let active = null;
  return Object.freeze({
    reserve(name) {
      if (active !== null) return false;
      active = name;
      return true;
    },
    release(name) {
      if (active !== name) return false;
      active = null;
      return true;
    },
    current() {
      return active;
    },
  });
}

export function runningMasterContainer(dockerState) {
  const master = (dockerState?.containers || []).find(
    (container) => container?.service === 'master' && /running/i.test(container?.state || ''),
  );
  if (!master) return null;
  return {
    id: typeof master.id === 'string' && master.id ? master.id : null,
    name: typeof master.name === 'string' ? master.name : null,
  };
}

export function readRuntimeProofCache(cache, containerId, now, ttl) {
  if (
    !containerId ||
    !cache ||
    cache.containerId !== containerId ||
    !Number.isFinite(cache.at) ||
    !Number.isFinite(now) ||
    !Number.isFinite(ttl) ||
    cache.at <= 0 ||
    now - cache.at < 0 ||
    now - cache.at >= ttl
  )
    return { hit: false, data: null };
  return { hit: true, data: cache.data ?? null };
}

const safeText = (value, max = 120) =>
  typeof value === 'string' && value.length > 0 && value.length <= max && SAFE_TEXT.test(value)
    ? value
    : null;

const safeTimestamp = (value) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

const safeModels = (value) => {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((model) => safeText(model))
        .filter(Boolean)
        .map((model) => normalizeProviderModel('claudex', model))
        .filter((model) => validateRouteEntry({ provider: 'claudex', model, effort: 'high' })),
    ),
  ].slice(0, MAX_MODELS);
};

const safeUsageSelectors = (value) => {
  if (Array.isArray(value)) return value.map((entry) => safeText(entry)).filter(Boolean);
  if (typeof value === 'string') return safeText(value) ? [value] : [];
  if (value && typeof value === 'object')
    return Object.keys(value)
      .map((entry) => safeText(entry))
      .filter(Boolean);
  return [];
};

export function sanitizeClaudexMarker(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const provider = raw.provider === 'claudex' || raw.provider === 'codex-api' ? 'claudex' : null;
  const configured =
    raw.configured === true &&
    (raw.providerId === 'codex-api' || raw.provider_id === 'codex-api') &&
    (raw.providerName === 'codex-api' || raw.provider_name === 'codex-api') &&
    raw.authMode === 'codex-oauth' &&
    raw.upstreamHost === 'chatgpt.com' &&
    Number.isInteger(raw.oauthPluginCount) &&
    raw.oauthPluginCount >= 2 &&
    raw.directOpenAiProvider === false &&
    raw.version === CLAUDEX_RUNTIME_VERSION &&
    raw.requestLogging === false;
  return {
    provider,
    configured,
    runtimeReady: configured && raw.runtimeReady === true,
    models: safeModels(raw.models),
    updatedAt: safeTimestamp(raw.updatedAt || raw.updated_at),
    version: safeText(raw.version, 40),
  };
}

export function parseClaudexTestOutput(stdout, requestedModel) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return { ok: false, reason: 'unexpected-output-shape' };
  let raw;
  try {
    raw = JSON.parse(lines[0]);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { ok: false, reason: 'invalid-result' };
  const model = normalizeProviderModel('claudex', requestedModel);
  const selector = expectedModelSelector('claudex', model);
  const selectors = safeUsageSelectors(raw.modelUsage);
  if (
    raw.ok !== true ||
    raw.is_error !== false ||
    raw.runtimeReady !== true ||
    raw.provider !== 'claudex' ||
    normalizeProviderModel('claudex', raw.model) !== model ||
    !selectors.includes(selector)
  )
    return { ok: false, reason: 'proof-mismatch' };
  const terminalReason = safeText(raw.terminalReason, 40);
  if (terminalReason !== 'completed') return { ok: false, reason: 'invalid-terminal-reason' };
  return {
    ok: true,
    result: {
      ok: true,
      provider: 'claudex',
      model,
      modelUsage: [selector],
      isError: false,
      runtimeReady: true,
      terminalReason: terminalReason || null,
      models: safeModels(raw.models),
      testedAt: safeTimestamp(raw.testedAt) || new Date().toISOString(),
    },
  };
}

export function parseClaudexRuntimeOutput(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return null;
  try {
    const raw = JSON.parse(lines[0]);
    if (raw?.ok !== true) return null;
    const marker = sanitizeClaudexMarker(raw);
    if (!marker?.configured || !marker.runtimeReady) return null;
    return {
      configured: true,
      providerId: 'codex-api',
      providerName: 'codex-api',
      authMode: 'codex-oauth',
      upstreamHost: 'chatgpt.com',
      oauthPluginCount: raw.oauthPluginCount,
      directOpenAiProvider: false,
      runtimeReady: true,
      models: marker.models,
      version: CLAUDEX_RUNTIME_VERSION,
      requestLogging: false,
      updatedAt: marker.updatedAt,
    };
  } catch {
    return null;
  }
}

export function sanitizeClaudexLastTest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const model = normalizeProviderModel('claudex', value.model);
  if (
    !safeText(model) ||
    !validateRouteEntry({ provider: 'claudex', model, effort: 'high' }) ||
    typeof value.ok !== 'boolean'
  )
    return null;
  const effort = safeText(value.effort, 20);
  if (effort && !providerEfforts('claudex', model).includes(effort)) return null;
  const selector = expectedModelSelector('claudex', model);
  const modelUsage = safeUsageSelectors(value.modelUsage).filter((entry) => entry === selector);
  if (value.ok && modelUsage.length === 0) return null;
  return {
    ok: value.ok,
    model,
    effort,
    modelUsage: value.ok ? modelUsage.slice(0, 1) : [],
    testedAt: safeTimestamp(value.testedAt),
    runtimeReady: value.ok && value.runtimeReady === true,
    ...(value.ok ? {} : { reason: safeText(value.reason, 60) || 'provider-test-failed' }),
  };
}

export function buildClaudexStatus({
  codexAuthPresent = false,
  marker = null,
  lastTest = null,
  masterRunning = false,
  runtimeProof,
} = {}) {
  const cleanMarker = sanitizeClaudexMarker(marker);
  const cleanRuntime =
    runtimeProof === undefined ? cleanMarker : sanitizeClaudexMarker(runtimeProof);
  const cleanLastTest = sanitizeClaudexLastTest(lastTest);
  const configured = !!(codexAuthPresent && (cleanMarker?.configured || cleanRuntime?.configured));
  const runtimeReady = !!(configured && masterRunning && cleanRuntime?.runtimeReady);
  const current = cleanRuntime?.configured ? cleanRuntime : cleanMarker;
  return {
    connected: runtimeReady,
    configured,
    runtimeReady,
    state: runtimeReady
      ? 'ready'
      : configured
        ? masterRunning
          ? 'starting'
          : 'stopped'
        : 'unconfigured',
    models: current?.models || [],
    lastTest: cleanLastTest,
    ...(current?.updatedAt ? { updatedAt: current.updatedAt } : {}),
    ...(current?.version ? { version: current.version } : {}),
  };
}

export function composeFileArgs(mfDir, override = '') {
  const args = ['compose', '-f', resolve(mfDir, 'compose.yml')];
  const raw = typeof override === 'string' ? override.trim() : '';
  if (!raw) return args;
  // Accept one or more platform-delimited file paths. They are always emitted
  // as execFile arguments, never interpolated into a shell command.
  for (const item of raw.split(delimiter).filter(Boolean)) {
    if (item.includes('\0') || /[\r\n]/.test(item)) throw new Error('invalid compose override');
    args.push('-f', isAbsolute(item) ? item : resolve(mfDir, item));
  }
  return args;
}

export function claudexProviderTestInvocation({
  mfDir,
  project,
  model,
  effort,
  override = '',
  running = false,
} = {}) {
  const normalizedModel = normalizeProviderModel('claudex', model);
  const args = [...composeFileArgs(mfDir, override), '-p', project];
  if (running) {
    args.push(
      'exec',
      '-T',
      'master',
      '/work/mf/provider-test.sh',
      'claudex',
      normalizedModel,
      effort,
    );
  } else {
    args.push(
      'run',
      '--rm',
      '--build',
      '--no-deps',
      '--no-TTY',
      '--volume',
      '/work/state',
      '--volume',
      '/work/mfstate',
      '--volume',
      '/work/usage',
      '--entrypoint',
      '/work/mf/provider-test.sh',
      'master',
      'claudex',
      normalizedModel,
      effort,
    );
  }
  return { cmd: 'docker', args };
}

export function claudexRuntimeStatusInvocation({ mfDir, project, override = '' } = {}) {
  return {
    cmd: 'docker',
    args: [
      ...composeFileArgs(mfDir, override),
      '-p',
      project,
      'exec',
      '-T',
      'master',
      'node',
      '/work/mf/ccr-ensure.mjs',
      '--status-json',
    ],
  };
}
