import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { bootstrap } from './ccr-bootstrap.mjs';
import {
  CCR_VERSION,
  ccrHome,
  codexHome,
  gatewayHealthy,
  installedCcrVersion,
  readServiceContext,
  rpc,
  sanitizeModels,
  scrubProviderEnv,
  sleep,
  statusNeedsRefresh,
  validateConfig,
} from './ccr-common.mjs';

async function managementConfig() {
  try {
    const context = await readServiceContext();
    return { config: await rpc(context, 'getConfig'), context };
  } catch {
    return null;
  }
}

function runCcr(args) {
  return spawnSync('ccr', args, {
    encoding: 'utf8',
    env: scrubProviderEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

async function waitForManagement() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const managed = await managementConfig();
    if (managed) return managed;
    await sleep(500);
  }
  return null;
}

async function startManagement() {
  fs.mkdirSync(ccrHome(), { mode: 0o700, recursive: true });
  runCcr(['start', '--host', '127.0.0.1', '--port', '3458', '--no-open']);
  let managed = await waitForManagement();
  if (managed) return managed;

  // A stale detached-service record is safe to clear inside this container's
  // private CCR home. Never kill unrelated node processes or inspect secrets.
  runCcr(['stop']);
  runCcr(['start', '--host', '127.0.0.1', '--port', '3458', '--no-open']);
  managed = await waitForManagement();
  if (!managed) {
    throw new Error('CCR management service did not become ready');
  }
  return managed;
}

export async function ensure({ force = false } = {}) {
  if (process.env.MF_DRY_RUN === '1') return;
  if (!fs.existsSync(path.join(codexHome(), 'auth.json'))) {
    throw new Error('Native Codex authentication is unavailable');
  }
  if (installedCcrVersion() !== CCR_VERSION) {
    throw new Error('Pinned CCR version is not installed');
  }

  const managed = (await managementConfig()) || (await startManagement());
  const ready = validateConfig(managed.config) && (await gatewayHealthy()) && !statusNeedsRefresh();
  if (!force && ready) return;

  await bootstrap();
  const verified = await managementConfig();
  if (!verified || !validateConfig(verified.config) || !(await gatewayHealthy())) {
    throw new Error('ClaudeX runtime failed post-bootstrap validation');
  }
}

export async function readOnlyStatus() {
  if (!fs.existsSync(path.join(codexHome(), 'auth.json'))) {
    throw new Error('Native Codex authentication is unavailable');
  }
  if (installedCcrVersion() !== CCR_VERSION) {
    throw new Error('Pinned CCR version is not installed');
  }

  const managed = await managementConfig();
  if (
    !managed ||
    !validateConfig(managed.config) ||
    !(await gatewayHealthy()) ||
    statusNeedsRefresh()
  ) {
    throw new Error('ClaudeX runtime is not ready');
  }
  return sanitizedReadyStatus();
}

export function sanitizedReadyStatus() {
  const statusPath = path.join(ccrHome(), 'factory-status.json');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  return {
    ok: true,
    configured: status.configured === true,
    providerId: status.providerId === 'codex-api' ? 'codex-api' : null,
    providerName: status.providerName === 'codex-api' ? 'codex-api' : null,
    authMode: status.authMode === 'codex-oauth' ? 'codex-oauth' : null,
    upstreamHost: status.upstreamHost === 'chatgpt.com' ? 'chatgpt.com' : null,
    oauthPluginCount: Number(status.oauthPluginCount) || 0,
    directOpenAiProvider: status.directOpenAiProvider === true,
    runtimeReady: true,
    models: sanitizeModels(status.models),
    version: typeof status.version === 'string' ? status.version : null,
    requestLogging: status.requestLogging === true,
    updatedAt: typeof status.updatedAt === 'string' ? status.updatedAt : null,
  };
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const statusOnly = process.argv.includes('--status-json');
  const operation = statusOnly
    ? readOnlyStatus()
    : ensure({ force: process.argv.includes('--force') });
  operation
    .then((status) => {
      if (statusOnly) process.stdout.write(`${JSON.stringify(status)}\n`);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : 'ClaudeX ensure failed';
      process.stderr.write(`ClaudeX ensure failed: ${message}\n`);
      process.exitCode = 1;
    });
}
