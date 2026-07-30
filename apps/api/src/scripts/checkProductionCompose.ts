import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRODUCTION_SUPPORTED_ENV_KEYS } from '../config/env';

type DeploymentMode = 'subdomains' | 'ports';

interface ComposeInvocation {
  executable: string;
  prefix: string[];
}

interface RenderedPort {
  target?: number | string;
}

interface RenderedService {
  environment?: Record<string, unknown>;
  ports?: RenderedPort[];
}

interface RenderedCompose {
  services?: Record<string, RenderedService>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const baseCompose = resolve(repoRoot, 'infra/docker-compose.yml');
const productionExample = resolve(repoRoot, 'infra/.env.production.example');
const expectedEnvironmentKeys: string[] = [...PRODUCTION_SUPPORTED_ENV_KEYS].sort();
const productionExampleKeys = readFileSync(productionExample, 'utf8')
  .split('\n')
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter((key): key is string => key !== undefined);

const topologies: ReadonlyArray<{
  mode: DeploymentMode;
  overlay: string;
  webPortTargets: number[];
}> = [
  {
    mode: 'subdomains',
    overlay: resolve(repoRoot, 'infra/docker-compose.subdomains.yml'),
    webPortTargets: [80],
  },
  {
    mode: 'ports',
    overlay: resolve(repoRoot, 'infra/docker-compose.ports.yml'),
    webPortTargets: [3000, 8080, 8081, 8082, 8083],
  },
];

function findCompose(): ComposeInvocation {
  const candidates: ComposeInvocation[] = [
    { executable: 'docker', prefix: ['compose'] },
    { executable: 'docker-compose', prefix: [] },
  ];

  for (const candidate of candidates) {
    const result = spawnSync(candidate.executable, [...candidate.prefix, 'version'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (result.status === 0) return candidate;
  }

  throw new Error('Docker Compose v2 is required to render the production deployment contract');
}

function renderTopology(
  compose: ComposeInvocation,
  mode: DeploymentMode,
  overlay: string,
): RenderedCompose {
  const interpolationEnvironment = { ...process.env };
  for (const key of productionExampleKeys) delete interpolationEnvironment[key];
  interpolationEnvironment.BT_MODE = mode;

  const result = spawnSync(
    compose.executable,
    [
      ...compose.prefix,
      '--env-file',
      productionExample,
      '-f',
      baseCompose,
      '-f',
      overlay,
      'config',
      '--format',
      'json',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: interpolationEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker compose config failed for ${mode} (exit ${result.status ?? 'unknown'}):\n${result.stderr.trim()}`,
    );
  }

  try {
    return JSON.parse(result.stdout) as RenderedCompose;
  } catch (error) {
    throw new Error(`docker compose returned invalid JSON for ${mode}`, { cause: error });
  }
}

function renderedService(
  config: RenderedCompose,
  mode: DeploymentMode,
  name: string,
): RenderedService {
  const service = config.services?.[name];
  assert(service, `${mode}: rendered service "${name}" is missing`);
  return service;
}

function renderedEnvironment(
  config: RenderedCompose,
  mode: DeploymentMode,
  serviceName: string,
): Record<string, string> {
  const environment = renderedService(config, mode, serviceName).environment;
  assert(environment, `${mode}: rendered service "${serviceName}" has no environment`);

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string') {
      throw new TypeError(`${mode}: ${serviceName}.${key} is not a string`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function assertExactEnvironmentKeys(
  mode: DeploymentMode,
  serviceName: string,
  environment: Record<string, string>,
): void {
  const actual = Object.keys(environment).sort();
  const missing = expectedEnvironmentKeys.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expectedEnvironmentKeys.includes(key));
  assert.equal(
    missing.length + extra.length,
    0,
    `${mode}: ${serviceName} environment contract drift (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
  );
}

function webPortTargets(config: RenderedCompose, mode: DeploymentMode): number[] {
  const ports = renderedService(config, mode, 'web').ports;
  assert(ports, `${mode}: rendered web service has no published ports`);
  return ports.map((port) => Number(port.target)).sort((left, right) => left - right);
}

function validateTopology(
  config: RenderedCompose,
  mode: DeploymentMode,
  expectedWebPortTargets: number[],
): void {
  const apiEnvironment = renderedEnvironment(config, mode, 'api');
  const workerEnvironment = renderedEnvironment(config, mode, 'worker');

  assertExactEnvironmentKeys(mode, 'api', apiEnvironment);
  assertExactEnvironmentKeys(mode, 'worker', workerEnvironment);
  for (const key of expectedEnvironmentKeys) {
    assert.equal(
      apiEnvironment[key],
      workerEnvironment[key],
      `${mode}: API and worker render different values for ${key}`,
    );
  }

  assert.equal(apiEnvironment.BT_MODE, mode, `${mode}: BT_MODE interpolation drifted`);
  assert.deepEqual(
    webPortTargets(config, mode),
    [...expectedWebPortTargets].sort((left, right) => left - right),
    `${mode}: topology overlay published the wrong web ports`,
  );
}

const compose = findCompose();
for (const topology of topologies) {
  const rendered = renderTopology(compose, topology.mode, topology.overlay);
  validateTopology(rendered, topology.mode, topology.webPortTargets);
  process.stdout.write(
    `Validated ${topology.mode} production Compose render: ` +
      `${expectedEnvironmentKeys.length} identical API/worker variables.\n`,
  );
}
