import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildFactoryConfig } from './ccr-bootstrap.mjs';
import { sanitizedStatus, writeSanitizedStatus } from './ccr-common.mjs';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bettertrack-ccr-ensure-'));
const ccrDir = path.join(temporary, 'ccr');
const codexDir = path.join(temporary, 'codex');
const binDir = path.join(temporary, 'bin');
const npmRoot = path.join(temporary, 'npm-root');
const fetchLog = path.join(temporary, 'fetch.log');
const configFile = path.join(temporary, 'config.json');
fs.mkdirSync(ccrDir, { recursive: true });
fs.mkdirSync(codexDir, { recursive: true });
fs.mkdirSync(binDir, { recursive: true });
fs.mkdirSync(path.join(npmRoot, '@musistudio', 'claude-code-router'), { recursive: true });
fs.writeFileSync(path.join(codexDir, 'auth.json'), '{"oauth":"MUST_NOT_PRINT"}\n', { mode: 0o600 });
fs.writeFileSync(
  path.join(npmRoot, '@musistudio', 'claude-code-router', 'package.json'),
  '{"version":"3.0.7"}\n',
);
const fakeNpm = path.join(binDir, 'npm');
fs.writeFileSync(fakeNpm, `#!/usr/bin/env bash\nprintf '%s\\n' '${npmRoot}'\n`, { mode: 0o700 });

const imported = {
  provider: {
    apiKey: 'ccr-local-agent-login',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    protocol: 'openai_responses',
  },
  providerPlugins: [
    { codexOauth: true, providerName: '__CCR_PROVIDER_NAME__' },
    {
      codexOauth: true,
      providerInternalName: '__CCR_PROVIDER_INTERNAL_NAME__',
    },
  ],
};
const config = buildFactoryConfig({ Providers: [], profile: { profiles: [] } }, imported);
config.APIKEY = 'CCR_LOCAL_KEY_MUST_NOT_PRINT';
fs.writeFileSync(configFile, JSON.stringify(config));

const serviceFile = path.join(ccrDir, 'service.json');
fs.writeFileSync(
  serviceFile,
  JSON.stringify({
    url: 'http://127.0.0.1:23456/?ccr_web_token=SERVICE_SECRET',
  }),
  { mode: 0o600 },
);
process.env.CCR_HOME = ccrDir;
process.env.CODEX_HOME = codexDir;
writeSanitizedStatus(sanitizedStatus(config, '3.0.7'));

const preload = path.join(temporary, 'fake-fetch.mjs');
fs.writeFileSync(
  preload,
  `import fs from "node:fs";
const config = JSON.parse(fs.readFileSync(process.env.CCR_TEST_CONFIG, "utf8"));
globalThis.fetch = async (input, options = {}) => {
  const url = String(input);
  fs.appendFileSync(process.env.CCR_TEST_FETCH_LOG, url + "\\n");
  if (url.includes("/v1/messages")) {
    throw new Error("model request forbidden in status test");
  }
  if (url.includes("/api/ccr/rpc")) {
    const payload = JSON.parse(options.body);
    if (payload.method !== "getConfig") throw new Error("unexpected RPC");
    return new Response(JSON.stringify({ ok: true, value: config }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.endsWith("/health")) {
    return new Response('{"status":"running"}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  throw new Error("unexpected fetch");
};
`,
  { mode: 0o600 },
);

const child = spawnSync(
  process.execPath,
  [path.join(import.meta.dirname, 'ccr-ensure.mjs'), '--status-json'],
  {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      NODE_OPTIONS: `--import=${preload}`,
      CCR_HOME: ccrDir,
      CODEX_HOME: codexDir,
      CCR_SERVICE_FILE: serviceFile,
      CCR_GATEWAY_HEALTH_URL: 'http://127.0.0.1:3456/health',
      CCR_TEST_CONFIG: configFile,
      CCR_TEST_FETCH_LOG: fetchLog,
      OPENAI_API_KEY: 'OPENAI_SECRET',
      ANTHROPIC_API_KEY: 'ANTHROPIC_SECRET',
      CLAUDE_CODE_OAUTH_TOKEN: 'CLAUDE_SECRET',
    },
  },
);

assert.equal(child.status, 0);
assert.equal(child.stderr, '');
assert.equal(child.stdout.trim().split('\n').length, 1);
const status = JSON.parse(child.stdout);
assert.equal(status.ok, true);
assert.equal(status.runtimeReady, true);
assert.equal(status.providerId, 'codex-api');
assert.equal(status.upstreamHost, 'chatgpt.com');
assert.equal(status.directOpenAiProvider, false);
assert.equal(status.requestLogging, false);
const fetches = fs.readFileSync(fetchLog, 'utf8').trim().split('\n');
assert.equal(fetches.filter((url) => url.includes('/v1/messages')).length, 0);
assert.equal(fetches.filter((url) => url.includes('/api/ccr/rpc')).length, 1);
assert.equal(fetches.filter((url) => url.endsWith('/health')).length, 1);
for (const secret of [
  'MUST_NOT_PRINT',
  'CCR_LOCAL_KEY_MUST_NOT_PRINT',
  'SERVICE_SECRET',
  'OPENAI_SECRET',
  'ANTHROPIC_SECRET',
  'CLAUDE_SECRET',
]) {
  assert.equal(`${child.stdout}${child.stderr}`.includes(secret), false);
}

fs.rmSync(temporary, { recursive: true, force: true });
process.stdout.write('CCR ensure status tests: 16 passed\n');
