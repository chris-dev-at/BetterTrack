import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PRODUCTION_SUPPORTED_ENV_KEYS, UNSAFE_GRAFANA_PASSWORDS } from '../config/env';

type DeploymentMode = 'subdomains' | 'ports';

interface ComposeInvocation {
  executable: string;
  prefix: string[];
}

interface ProductionTopology {
  label: string;
  mode: DeploymentMode;
  overlays: string[];
  profiles?: string[];
  interpolationEnvironment?: Record<string, string>;
  webPortTargets: number[];
}

interface RenderedPort {
  target?: number | string;
}

interface RenderedLogging {
  driver?: unknown;
  options?: Record<string, unknown>;
}

interface RenderedService {
  entrypoint?: unknown;
  environment?: Record<string, unknown>;
  logging?: RenderedLogging;
  ports?: RenderedPort[];
}

export interface RenderedCompose {
  services?: Record<string, RenderedService>;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const baseCompose = resolve(repoRoot, 'infra/docker-compose.yml');
const offsiteCompose = resolve(repoRoot, 'infra/docker-compose.offsite.yml');
const productionExample = resolve(repoRoot, 'infra/.env.production.example');
const expectedEnvironmentKeys: string[] = [...PRODUCTION_SUPPORTED_ENV_KEYS].sort();
const productionExampleKeys = readFileSync(productionExample, 'utf8')
  .split('\n')
  .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
  .filter((key): key is string => key !== undefined);

const offsiteInterpolationEnvironment = {
  BT_BACKUP_AGE_RECIPIENT_HOST_FILE: '/tmp/bettertrack-compose-check-age-recipient',
  BT_BACKUP_RCLONE_CONFIG_HOST_FILE: '/tmp/bettertrack-compose-check-rclone.conf',
  BT_BACKUP_RCLONE_REMOTE: 'check:bettertrack-backups',
  BT_BACKUP_RETENTION_RCLONE_CONFIG_HOST_FILE:
    '/tmp/bettertrack-compose-check-retention-rclone.conf',
  BT_BACKUP_RETENTION_RCLONE_REMOTE: 'check-retention:bettertrack-backups',
};

const topologies: ReadonlyArray<ProductionTopology> = [
  {
    label: 'subdomains',
    mode: 'subdomains',
    overlays: [resolve(repoRoot, 'infra/docker-compose.subdomains.yml')],
    webPortTargets: [80],
  },
  {
    label: 'subdomains+offsite',
    mode: 'subdomains',
    overlays: [resolve(repoRoot, 'infra/docker-compose.subdomains.yml'), offsiteCompose],
    profiles: ['offsite', 'offsite-retention'],
    interpolationEnvironment: offsiteInterpolationEnvironment,
    webPortTargets: [80],
  },
  {
    label: 'ports',
    mode: 'ports',
    overlays: [resolve(repoRoot, 'infra/docker-compose.ports.yml')],
    webPortTargets: [3000, 8080, 8081, 8082, 8083],
  },
  {
    label: 'ports+offsite',
    mode: 'ports',
    overlays: [resolve(repoRoot, 'infra/docker-compose.ports.yml'), offsiteCompose],
    profiles: ['offsite', 'offsite-retention'],
    interpolationEnvironment: offsiteInterpolationEnvironment,
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

function renderTopology(compose: ComposeInvocation, topology: ProductionTopology): RenderedCompose {
  const interpolationEnvironment = { ...process.env };
  for (const key of productionExampleKeys) delete interpolationEnvironment[key];
  interpolationEnvironment.BT_MODE = topology.mode;
  Object.assign(interpolationEnvironment, topology.interpolationEnvironment);

  const composeFiles = [baseCompose, ...topology.overlays].flatMap((file) => ['-f', file]);
  const profiles = (topology.profiles ?? []).flatMap((profile) => ['--profile', profile]);

  const result = spawnSync(
    compose.executable,
    [
      ...compose.prefix,
      '--env-file',
      productionExample,
      ...composeFiles,
      ...profiles,
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
      `docker compose config failed for ${topology.label} (exit ${result.status ?? 'unknown'}):\n${result.stderr.trim()}`,
    );
  }

  try {
    return JSON.parse(result.stdout) as RenderedCompose;
  } catch (error) {
    throw new Error(`docker compose returned invalid JSON for ${topology.label}`, { cause: error });
  }
}

function renderedService(config: RenderedCompose, topology: string, name: string): RenderedService {
  const service = config.services?.[name];
  assert(service, `${topology}: rendered service "${name}" is missing`);
  return service;
}

function renderedEnvironment(
  config: RenderedCompose,
  topology: string,
  serviceName: string,
): Record<string, string> {
  const environment = renderedService(config, topology, serviceName).environment;
  assert(environment, `${topology}: rendered service "${serviceName}" has no environment`);

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value !== 'string') {
      throw new TypeError(`${topology}: ${serviceName}.${key} is not a string`);
    }
    normalized[key] = value;
  }
  return normalized;
}

function assertExactEnvironmentKeys(
  topology: string,
  serviceName: string,
  environment: Record<string, string>,
): void {
  const actual = Object.keys(environment).sort();
  const missing = expectedEnvironmentKeys.filter((key) => !actual.includes(key));
  const extra = actual.filter((key) => !expectedEnvironmentKeys.includes(key));
  assert.equal(
    missing.length + extra.length,
    0,
    `${topology}: ${serviceName} environment contract drift (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
  );
}

function webPortTargets(config: RenderedCompose, topology: string): number[] {
  const ports = renderedService(config, topology, 'web').ports;
  assert(ports, `${topology}: rendered web service has no published ports`);
  return ports.map((port) => Number(port.target)).sort((left, right) => left - right);
}

export function assertServiceLoggingLimits(config: RenderedCompose, topology: string): void {
  const services = config.services;
  assert(services, `${topology}: rendered Compose config has no services`);

  const entries = Object.entries(services);
  assert(entries.length > 0, `${topology}: rendered Compose config has no services`);

  for (const [serviceName, service] of entries) {
    const logging = service.logging;
    assert.equal(
      logging?.driver,
      'local',
      `${topology}: rendered service "${serviceName}" must use the bounded local log driver`,
    );

    const maxSize = String(logging.options?.['max-size'] ?? '');
    const maxFile = String(logging.options?.['max-file'] ?? '');
    assert.match(
      maxSize,
      /^[1-9]\d*[kmg]$/i,
      `${topology}: rendered service "${serviceName}" must set a positive logging max-size`,
    );
    assert.match(
      maxFile,
      /^[1-9]\d*$/,
      `${topology}: rendered service "${serviceName}" must set a positive logging max-file`,
    );
  }
}

const GRAFANA_PASSWORD_KEY = 'GF_SECURITY_ADMIN_PASSWORD';
const GRAFANA_PASSWORD_FILE_KEY = `${GRAFANA_PASSWORD_KEY}__FILE`;

/**
 * The Grafana admin credential must never be a compose literal (§13.5 V5-P2):
 * an inline `GF_SECURITY_ADMIN_PASSWORD` — hardcoded, or defaulted via
 * `${BT_GRAFANA_ADMIN_PASSWORD:-admin}` — is reachable on EVERY interface
 * Grafana binds to, including the LAN bind docs/monitoring.md recommends.
 * The shipped shape instead points Grafana at a credential file that the
 * service's own entrypoint seeds (operator value, else a random password
 * generated into the persistent volume), so zero owner setup survives.
 */
export function assertGrafanaAdminCredential(config: RenderedCompose, topology: string): void {
  const grafana = renderedService(config, topology, 'grafana');
  const environment = grafana.environment ?? {};

  assert(
    !(GRAFANA_PASSWORD_KEY in environment),
    `${topology}: grafana must not carry an inline ${GRAFANA_PASSWORD_KEY} — ` +
      `the admin credential is seeded into ${GRAFANA_PASSWORD_FILE_KEY} on first boot`,
  );

  for (const [key, value] of Object.entries(environment)) {
    // Only credential-shaped keys: GF_SECURITY_ADMIN_USER legitimately renders
    // the literal `admin`.
    if (!key.startsWith('GF_') || !key.includes('PASSWORD')) continue;
    assert(
      !UNSAFE_GRAFANA_PASSWORDS.has(String(value).trim().toLowerCase()),
      `${topology}: grafana renders a known-unsafe credential for ${key}`,
    );
  }

  const credentialFile = String(environment[GRAFANA_PASSWORD_FILE_KEY] ?? '');
  assert(
    credentialFile.startsWith('/'),
    `${topology}: grafana must point ${GRAFANA_PASSWORD_FILE_KEY} at an absolute credential path`,
  );

  const entrypoint = grafana.entrypoint;
  assert(
    Array.isArray(entrypoint) && entrypoint.length > 0,
    `${topology}: grafana must keep the credential bootstrap entrypoint — ` +
      `without it nothing writes ${credentialFile} and Grafana falls back to its default login`,
  );
  const bootstrap = entrypoint.map((part) => String(part)).join('\n');
  assert(
    bootstrap.includes(credentialFile),
    `${topology}: the grafana entrypoint does not seed ${credentialFile}`,
  );
  assert(
    bootstrap.includes('/dev/urandom'),
    `${topology}: the grafana entrypoint must generate a random credential when none is supplied`,
  );
  // Seeding the file is not enough on its own: a bootstrap that wrote `admin`
  // into it would satisfy everything above while reopening exactly this hole.
  // Require the refusal branch itself — every UNSAFE_GRAFANA_PASSWORDS literal,
  // plus the empty value, in one case arm — to survive in the script.
  const refusalArm = `''|${[...UNSAFE_GRAFANA_PASSWORDS].join('|')})`;
  assert(
    bootstrap.replace(/\s+/g, '').includes(refusalArm),
    `${topology}: the grafana entrypoint must keep refusing the known-unsafe credentials — ` +
      `expected a \`${[...UNSAFE_GRAFANA_PASSWORDS].join(' | ')}\` case arm that blanks the supplied ` +
      `value, otherwise the bootstrap can seed one of them into ${credentialFile}`,
  );
  // The image's own /run.sh implements the `__FILE` convention and hard-fails
  // ("Both … are set (but are exclusive)") when the plain variable is exported
  // too — under `restart: unless-stopped` that is a permanent crash loop.
  assert(
    !bootstrap.includes(`${GRAFANA_PASSWORD_KEY}=`),
    `${topology}: the grafana entrypoint must not set ${GRAFANA_PASSWORD_KEY} — ` +
      `the image entrypoint refuses to start when it and ${GRAFANA_PASSWORD_FILE_KEY} are both set`,
  );
  // Grafana applies a bootstrap password only when it CREATES the admin user,
  // so a volume that already booted keeps its old (default) credential unless
  // the bootstrap pushes the seeded one into the existing grafana.db.
  assert(
    bootstrap.includes('reset-admin-password'),
    `${topology}: the grafana entrypoint must apply ${credentialFile} to an already-provisioned ` +
      `grafana.db — Grafana honours a bootstrap password only while it creates the admin user`,
  );
}

function validateTopology(config: RenderedCompose, topology: ProductionTopology): void {
  assertServiceLoggingLimits(config, topology.label);
  assertGrafanaAdminCredential(config, topology.label);

  const apiEnvironment = renderedEnvironment(config, topology.label, 'api');
  const workerEnvironment = renderedEnvironment(config, topology.label, 'worker');

  assertExactEnvironmentKeys(topology.label, 'api', apiEnvironment);
  assertExactEnvironmentKeys(topology.label, 'worker', workerEnvironment);
  for (const key of expectedEnvironmentKeys) {
    assert.equal(
      apiEnvironment[key],
      workerEnvironment[key],
      `${topology.label}: API and worker render different values for ${key}`,
    );
  }

  assert.equal(
    apiEnvironment.BT_MODE,
    topology.mode,
    `${topology.label}: BT_MODE interpolation drifted`,
  );
  assert.deepEqual(
    webPortTargets(config, topology.label),
    [...topology.webPortTargets].sort((left, right) => left - right),
    `${topology.label}: topology overlay published the wrong web ports`,
  );
}

export function runProductionComposeCheck(): void {
  const compose = findCompose();
  for (const topology of topologies) {
    const rendered = renderTopology(compose, topology);
    validateTopology(rendered, topology);
    process.stdout.write(
      `Validated ${topology.label} production Compose render: ` +
        `${Object.keys(rendered.services ?? {}).length} services with bounded logs; ` +
        `${expectedEnvironmentKeys.length} identical API/worker variables.\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProductionComposeCheck();
}
