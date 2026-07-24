import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildClaudexStatus,
  claudexProviderTestInvocation,
  claudexRuntimeStatusInvocation,
  composeFileArgs,
  createExclusiveOperation,
  parseClaudexRuntimeOutput,
  parseClaudexTestOutput,
  readRuntimeProofCache,
  runningMasterContainer,
  sanitizeClaudexLastTest,
  sanitizeClaudexMarker,
} from './claudex-control.mjs';

const marker = (overrides = {}) => ({
  configured: true,
  providerId: 'codex-api',
  providerName: 'codex-api',
  authMode: 'codex-oauth',
  upstreamHost: 'chatgpt.com',
  oauthPluginCount: 2,
  directOpenAiProvider: false,
  runtimeReady: true,
  models: ['gpt-5.6-sol', 'codex-api/gpt-5.6-terra', 'secret model', 'other/model'],
  updatedAt: '2026-07-24T12:00:00Z',
  version: '3.0.7',
  requestLogging: false,
  ...overrides,
});

test('marker sanitizer enforces the proven route invariants and allowlists public fields', () => {
  const raw = marker({
    apiKey: 'SECRET_CLIENT_KEY',
    serviceUrl: 'http://127.0.0.1:3458/?ccr_web_token=SECRET',
    providerPlugins: [{ token: 'SECRET_OAUTH' }],
    authFile: '/Users/person/.codex/auth.json',
    modelCacheSha256: 'private-fingerprint',
  });
  const clean = sanitizeClaudexMarker(raw);
  assert.deepEqual(clean, {
    provider: null,
    configured: true,
    runtimeReady: true,
    models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    updatedAt: '2026-07-24T12:00:00.000Z',
    version: '3.0.7',
  });
  const serialized = JSON.stringify(clean);
  for (const forbidden of [
    'SECRET_CLIENT_KEY',
    'ccr_web_token',
    'SECRET_OAUTH',
    '/Users/person',
    'private-fingerprint',
  ])
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  assert.equal(sanitizeClaudexMarker(marker({ providerName: 'Codex API' })).configured, false);
  assert.equal(sanitizeClaudexMarker(marker({ directOpenAiProvider: true })).configured, false);
  assert.equal(sanitizeClaudexMarker(marker({ requestLogging: true })).configured, false);
  assert.equal(sanitizeClaudexMarker(marker({ version: '3.0.8' })).configured, false);
});

test('status distinguishes configured/stopped from disconnected and runtime-ready', () => {
  const stopped = buildClaudexStatus({
    codexAuthPresent: true,
    marker: marker(),
    masterRunning: false,
  });
  assert.equal(stopped.configured, true);
  assert.equal(stopped.runtimeReady, false);
  assert.equal(stopped.connected, false);
  assert.equal(stopped.state, 'stopped');

  const ready = buildClaudexStatus({
    codexAuthPresent: true,
    marker: marker(),
    masterRunning: true,
  });
  assert.equal(ready.connected, true);
  assert.equal(ready.state, 'ready');

  const missingAuth = buildClaudexStatus({
    codexAuthPresent: false,
    marker: marker(),
    masterRunning: true,
  });
  assert.equal(missingAuth.configured, false);
  assert.equal(missingAuth.state, 'unconfigured');

  const staleMarkerWithDeadRuntime = buildClaudexStatus({
    codexAuthPresent: true,
    marker: marker(),
    masterRunning: true,
    runtimeProof: null,
  });
  assert.equal(staleMarkerWithDeadRuntime.configured, true);
  assert.equal(staleMarkerWithDeadRuntime.runtimeReady, false);
  assert.equal(staleMarkerWithDeadRuntime.connected, false);
  assert.equal(staleMarkerWithDeadRuntime.state, 'starting');
});

test('provider proof requires one clean JSON result and exact requested modelUsage', () => {
  const good = {
    ok: true,
    provider: 'claudex',
    model: 'codex-api/gpt-5.6-sol',
    modelUsage: ['codex-api/gpt-5.6-sol'],
    is_error: false,
    terminalReason: 'completed',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    testedAt: '2026-07-24T12:00:00Z',
    runtimeReady: true,
    apiKey: 'must-not-survive',
  };
  const parsed = parseClaudexTestOutput(JSON.stringify(good), 'gpt-5.6-sol');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.result.modelUsage, ['codex-api/gpt-5.6-sol']);
  assert.doesNotMatch(JSON.stringify(parsed), /must-not-survive/);

  assert.equal(
    parseClaudexTestOutput(`${JSON.stringify(good)}\nextra`, 'gpt-5.6-sol').reason,
    'unexpected-output-shape',
  );
  assert.equal(
    parseClaudexTestOutput(
      JSON.stringify({ ...good, modelUsage: ['codex-api/gpt-5.6-terra'] }),
      'gpt-5.6-sol',
    ).reason,
    'proof-mismatch',
  );
  assert.equal(
    parseClaudexTestOutput(JSON.stringify({ ...good, is_error: true }), 'gpt-5.6-sol').reason,
    'proof-mismatch',
  );
  assert.equal(
    parseClaudexTestOutput(JSON.stringify({ ...good, terminalReason: 'end_turn' }), 'gpt-5.6-sol')
      .reason,
    'invalid-terminal-reason',
  );
  assert.equal(
    parseClaudexTestOutput(JSON.stringify({ ...good, terminalReason: undefined }), 'gpt-5.6-sol')
      .reason,
    'invalid-terminal-reason',
  );
});

test('live runtime proof is sanitized and requires the full healthy marker contract', () => {
  const good = parseClaudexRuntimeOutput(
    JSON.stringify({
      ok: true,
      ...marker(),
      serviceUrl: 'http://localhost/?ccr_web_token=secret',
      apiKey: 'secret',
    }),
  );
  assert.equal(good.configured, true);
  assert.equal(good.runtimeReady, true);
  assert.equal(good.providerId, 'codex-api');
  assert.doesNotMatch(JSON.stringify(good), /ccr_web_token|apiKey|secret/);
  assert.equal(
    parseClaudexRuntimeOutput(JSON.stringify({ ok: true, ...marker({ runtimeReady: false }) })),
    null,
  );
  assert.equal(
    parseClaudexRuntimeOutput(JSON.stringify({ ok: true, ...marker({ requestLogging: true }) })),
    null,
  );
});

test('legacy raw result model is tolerated but the proof selector remains exact', () => {
  const parsed = parseClaudexTestOutput(
    JSON.stringify({
      ok: true,
      provider: 'claudex',
      model: 'gpt-5.6-terra',
      modelUsage: { 'codex-api/gpt-5.6-terra': { inputTokens: 2 } },
      is_error: false,
      terminalReason: 'completed',
      runtimeReady: true,
    }),
    'codex-api/gpt-5.6-terra',
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.model, 'gpt-5.6-terra');
});

test('persisted last-test metadata is reduced to a safe fixed schema', () => {
  const clean = sanitizeClaudexLastTest({
    ok: true,
    model: 'codex-api/gpt-5.6-luna',
    effort: 'high',
    modelUsage: ['codex-api/gpt-5.6-luna', 'unrelated'],
    testedAt: '2026-07-24T12:00:00Z',
    runtimeReady: true,
    stdout: 'secret output',
    serviceUrl: 'secret URL',
  });
  assert.deepEqual(clean, {
    ok: true,
    model: 'gpt-5.6-luna',
    effort: 'high',
    modelUsage: ['codex-api/gpt-5.6-luna'],
    testedAt: '2026-07-24T12:00:00.000Z',
    runtimeReady: true,
  });
  assert.equal(
    sanitizeClaudexLastTest({
      ok: false,
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      testedAt: '2026-07-24T12:00:00Z',
    }),
    null,
  );
});

test('compose test invocation never calls the host wrapper and isolates stopped state', () => {
  const running = claudexProviderTestInvocation({
    mfDir: '/repo/multi-factory',
    project: 'bettertrack-multifactory',
    model: 'gpt-5.6-sol',
    effort: 'high',
    override: '/private/tmp/runtime.yml',
    running: true,
  });
  assert.equal(running.cmd, 'docker');
  assert.deepEqual(running.args.slice(-5), [
    'master',
    '/work/mf/provider-test.sh',
    'claudex',
    'gpt-5.6-sol',
    'high',
  ]);
  assert.ok(running.args.includes('/private/tmp/runtime.yml'));
  assert.ok(running.args.includes('exec'));
  assert.ok(!running.args.includes('claudex -p'));

  const stopped = claudexProviderTestInvocation({
    mfDir: '/repo/multi-factory',
    project: 'bettertrack-multifactory',
    model: 'codex-api/gpt-5.6-terra',
    effort: 'high',
    running: false,
  });
  assert.ok(stopped.args.includes('run'));
  assert.ok(stopped.args.includes('--rm'));
  assert.ok(stopped.args.includes('--build'));
  assert.ok(stopped.args.includes('--no-deps'));
  assert.equal(stopped.args.filter((arg) => arg === '/work/state').length, 1);
  assert.equal(stopped.args.filter((arg) => arg === '/work/mfstate').length, 1);
  assert.equal(stopped.args.filter((arg) => arg === '/work/usage').length, 1);
  assert.ok(!stopped.args.includes('bash'));
  assert.ok(!stopped.args.includes('-c'));
});

test('runtime status invocation is an in-container no-model health proof', () => {
  const invocation = claudexRuntimeStatusInvocation({
    mfDir: '/repo/multi-factory',
    project: 'bettertrack-multifactory',
    override: '/private/tmp/runtime.yml',
  });
  assert.equal(invocation.cmd, 'docker');
  assert.deepEqual(invocation.args.slice(-6), [
    'exec',
    '-T',
    'master',
    'node',
    '/work/mf/ccr-ensure.mjs',
    '--status-json',
  ]);
  assert.ok(invocation.args.includes('/private/tmp/runtime.yml'));
  assert.ok(!invocation.args.includes('/work/mf/provider-test.sh'));
});

test('compose override is passed as data and rejects control-character paths', () => {
  assert.deepEqual(composeFileArgs('/repo/multi-factory', ''), [
    'compose',
    '-f',
    '/repo/multi-factory/compose.yml',
  ]);
  assert.throws(() => composeFileArgs('/repo/multi-factory', 'bad\nfile.yml'));
});

test('exclusive operation reservation is atomic across lifecycle and provider-test names', () => {
  const operation = createExclusiveOperation();
  assert.equal(operation.reserve('test-provider-claudex'), true);
  assert.equal(operation.current(), 'test-provider-claudex');
  assert.equal(operation.reserve('restart'), false);
  assert.equal(operation.release('restart'), false);
  assert.equal(operation.current(), 'test-provider-claudex');
  assert.equal(operation.release('test-provider-claudex'), true);
  assert.equal(operation.reserve('down'), true);
  assert.equal(operation.release('down'), true);
  assert.equal(operation.current(), null);
});

test('runtime proof cache follows the exact running master container identity', () => {
  const dockerState = {
    containers: [
      { id: 'worker-id', name: 'worker-1', service: 'worker-1', state: 'running' },
      { id: 'master-v2', name: 'master', service: 'master', state: 'running' },
    ],
  };
  assert.deepEqual(runningMasterContainer(dockerState), {
    id: 'master-v2',
    name: 'master',
  });
  assert.equal(
    runningMasterContainer({
      containers: [{ id: 'master-v2', service: 'master', state: 'paused' }],
    }),
    null,
  );

  const cache = { containerId: 'master-v1', at: 1000, data: { runtimeReady: true } };
  assert.deepEqual(readRuntimeProofCache(cache, 'master-v1', 1500, 1000), {
    hit: true,
    data: { runtimeReady: true },
  });
  assert.deepEqual(readRuntimeProofCache(cache, 'master-v2', 1500, 1000), {
    hit: false,
    data: null,
  });
  assert.deepEqual(readRuntimeProofCache(cache, null, 1500, 1000), {
    hit: false,
    data: null,
  });
  assert.deepEqual(readRuntimeProofCache(cache, 'master-v1', 2000, 1000), {
    hit: false,
    data: null,
  });
});

test('server source binds ClaudeX tests to the container contract, not the host launcher', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /claudexProviderTestInvocation/);
  assert.match(source, /claudexRuntimeStatusInvocation/);
  assert.match(source, /MF_CLAUDEX_STATUS_TTL_MS/);
  assert.equal(source.includes("run('claudex'"), false);
  assert.match(source, /providerRegistry: publicProviderRegistry\(\)/);
  assert.match(source, /id: c\.ID \|\| null/);
  for (const action of ['stop', 'down', 'pause', 'unpause'])
    assert.match(source, new RegExp(`case '${action}':[\\s\\S]{0,80}return withMfOperation`));
});
