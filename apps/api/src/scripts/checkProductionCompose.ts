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
  /** Set on the probe render that moves `BT_OBS_BIND_HOST` off loopback. */
  lanObservabilityBind?: string;
}

interface RenderedPort {
  target?: number | string;
  host_ip?: string;
}

interface RenderedLogging {
  driver?: unknown;
  options?: Record<string, unknown>;
}

interface RenderedService {
  command?: unknown;
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

/**
 * RFC1918 stand-in for "the operator followed the LAN recipe". Never a real
 * deploy value — it only has to be non-loopback for the probe render.
 */
const LAN_BIND_PROBE = '192.168.242.10';

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
  {
    // docs/monitoring.md's LAN recipe, rendered: BT_OBS_BIND_HOST moves Grafana
    // (which has a login) onto the network. Prometheus, which has none, must not
    // travel with it — `assertPrometheusExposure` runs on this render too.
    label: 'subdomains+lan-obs-bind',
    mode: 'subdomains',
    overlays: [resolve(repoRoot, 'infra/docker-compose.subdomains.yml')],
    interpolationEnvironment: { BT_OBS_BIND_HOST: LAN_BIND_PROBE },
    webPortTargets: [80],
    lanObservabilityBind: LAN_BIND_PROBE,
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

/**
 * Grafana OSS reaches out of the box: anonymous usage statistics to
 * `stats.grafana.org`, version + plugin update checks and feedback links
 * against `grafana.com`, the grafana.com news feed, and — for every signed-in
 * user — a server-side avatar proxy to `secure.gravatar.com`. The V5-P2
 * observability arc is first-party only with zero owner setup (the same rule
 * that rejects a Sentry DSN), so the compose service pins every one of them
 * off. They are deliberately compose literals rather than `${BT_…}` inputs —
 * this gate is what keeps them from being re-enabled, or dropped and silently
 * defaulting back to the calling-out value.
 *
 * The polarities differ, so each key carries its required value:
 * `GF_SECURITY_DISABLE_GRAVATAR` must be `true`, the rest `false`.
 */
export const GRAFANA_TELEMETRY_SETTINGS: Readonly<Record<string, 'true' | 'false'>> = {
  GF_ANALYTICS_REPORTING_ENABLED: 'false',
  GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
  GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES: 'false',
  GF_ANALYTICS_FEEDBACK_LINKS_ENABLED: 'false',
  GF_NEWS_NEWS_FEED_ENABLED: 'false',
  GF_SECURITY_DISABLE_GRAVATAR: 'true',
};

export function assertGrafanaTelemetryDisabled(config: RenderedCompose, topology: string): void {
  const environment = renderedService(config, topology, 'grafana').environment ?? {};

  for (const [key, required] of Object.entries(GRAFANA_TELEMETRY_SETTINGS)) {
    const value = environment[key];
    assert(
      value !== undefined,
      `${topology}: grafana must set ${key}=${required} — Grafana OSS defaults it the other way ` +
        `and calls grafana.com / stats.grafana.org / secure.gravatar.com, which the ` +
        `first-party-only observability arc forbids`,
    );
    assert.equal(
      String(value).trim().toLowerCase(),
      required,
      `${topology}: grafana must keep ${key} at ${required} — it renders "${String(value)}"`,
    );
  }
}

const GRAFANA_ANONYMOUS_KEY = 'GF_AUTH_ANONYMOUS_ENABLED';
const GRAFANA_ANONYMOUS_ROLE_KEY = 'GF_AUTH_ANONYMOUS_ORG_ROLE';
const GRAFANA_BIND_HOST_KEY = 'BT_OBS_BIND_HOST';
const GRAFANA_ANONYMOUS_ACK_KEY = 'BT_GRAFANA_ANON_LAN_ACK';
/** Fragment of the entrypoint guard's own refusal — code, not comment prose. */
const GRAFANA_ANONYMOUS_GUARD_REFUSAL = 'refusing to start Grafana';

// Grafana parses `auth.anonymous.enabled` with go-ini's parseBool, which also
// accepts the single letters `t` and `y`. A guard must not disagree with the
// thing it guards in the unsafe direction, so the same set is honoured here and
// in the entrypoint's `case` arms.
function isEnabledFlag(value: unknown): boolean {
  return ['true', 't', '1', 'yes', 'y', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

function isLoopbackBind(hostIp: unknown): boolean {
  const host = String(hostIp ?? '')
    .trim()
    .replace(/[[\]]/g, '')
    .toLowerCase();
  if (host === 'localhost' || host === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Anonymous Grafana access is a SERVER-WIDE setting, not a per-path one. The
 * admin-proxy recipe turns it on (the proxy is the auth) and the LAN recipe
 * moves `BT_OBS_BIND_HOST` off loopback; each is documented as safe alone, and
 * together they publish every dashboard to the LAN with no credential. The
 * grafana entrypoint refuses that combination at boot unless
 * `BT_GRAFANA_ANON_LAN_ACK` names it explicitly; this gate refuses it in the
 * rendered contract and keeps the runtime guard from being quietly deleted.
 */
export function assertGrafanaAnonymousAccessBind(config: RenderedCompose, topology: string): void {
  const grafana = renderedService(config, topology, 'grafana');
  const environment = grafana.environment ?? {};
  const anonymous = isEnabledFlag(environment[GRAFANA_ANONYMOUS_KEY]);

  if (anonymous) {
    assert.equal(
      String(environment[GRAFANA_ANONYMOUS_ROLE_KEY] ?? '').trim(),
      'Viewer',
      `${topology}: anonymous Grafana access must stay read-only — ${GRAFANA_ANONYMOUS_ROLE_KEY} ` +
        `renders "${String(environment[GRAFANA_ANONYMOUS_ROLE_KEY] ?? 'unset')}"`,
    );
  }

  const ports = grafana.ports ?? [];
  assert(ports.length > 0, `${topology}: rendered grafana service publishes no host port`);
  const exposedBinds = ports
    .map((port) => String(port.host_ip ?? ''))
    .filter((host) => !isLoopbackBind(host));
  const acknowledged = isEnabledFlag(environment[GRAFANA_ANONYMOUS_ACK_KEY]);

  assert(
    !(anonymous && exposedBinds.length > 0 && !acknowledged),
    `${topology}: grafana renders anonymous access on the non-loopback bind ` +
      `${exposedBinds.join(', ') || '(all interfaces)'} — that is an unauthenticated dashboard ` +
      `server for everything that can reach it. Keep ${GRAFANA_BIND_HOST_KEY} on loopback (the ` +
      `admin-proxy path needs nothing else), turn ${GRAFANA_ANONYMOUS_KEY} off, or name the ` +
      `exposure with ${GRAFANA_ANONYMOUS_ACK_KEY}`,
  );

  // The rendered contract only sees the shipped defaults; the owner's own `.env`
  // is what actually boots. The entrypoint guard is what covers that case, so it
  // must keep receiving both inputs and keep comparing them.
  for (const key of [GRAFANA_BIND_HOST_KEY, GRAFANA_ANONYMOUS_ACK_KEY]) {
    assert(
      key in environment,
      `${topology}: grafana must receive ${key} — the entrypoint guard cannot compare inputs it never sees`,
    );
  }

  const entrypoint = grafana.entrypoint;
  const bootstrap = Array.isArray(entrypoint)
    ? entrypoint.map((part) => String(part)).join('\n')
    : '';
  for (const key of [GRAFANA_ANONYMOUS_KEY, GRAFANA_BIND_HOST_KEY, GRAFANA_ANONYMOUS_ACK_KEY]) {
    assert(
      bootstrap.includes(key),
      `${topology}: the grafana entrypoint must keep the anonymous-access guard — it no longer ` +
        `reads ${key}, so an owner .env could still combine anonymous access with a LAN bind`,
    );
  }
  // The three key names above also appear in the entrypoint's own explanatory
  // comments, so name-presence alone would pass on a guard gutted down to its
  // prose. Anchor on the refusal itself — the one string only the live branch
  // emits — the way `assertGrafanaAdminCredential` anchors on its refusal arm.
  assert(
    bootstrap.includes(GRAFANA_ANONYMOUS_GUARD_REFUSAL),
    `${topology}: the grafana entrypoint must keep the anonymous-access guard's refusal ` +
      `("${GRAFANA_ANONYMOUS_GUARD_REFUSAL}") — reading the keys in a comment is not a guard`,
  );
}

const PROMETHEUS_BIND_HOST_KEY = 'BT_PROMETHEUS_BIND_HOST';

/**
 * Prometheus flags that add unauthenticated WRITE endpoints to a server which
 * has no login of its own: `--web.enable-lifecycle` serves `POST /-/reload` and
 * `POST /-/quit`, `--web.enable-admin-api` serves series deletion, tombstone
 * cleaning and snapshotting. Nothing in this repo calls any of them.
 */
export const PROMETHEUS_FORBIDDEN_FLAGS = [
  '--web.enable-lifecycle',
  '--web.enable-admin-api',
] as const;

/** The endpoints `--web.enable-lifecycle` gates — the reason it is refused. */
export const PROMETHEUS_LIFECYCLE_GATED_PATHS = ['/-/reload', '/-/quit'] as const;

/**
 * What the admin Monitoring probe GETs (`monitoringService.ts`). Prometheus
 * serves it unconditionally — it is NOT one of the lifecycle-gated paths above —
 * so dropping the flag leaves the health probe working.
 */
export const PROMETHEUS_HEALTH_PROBE_PATH = '/-/healthy';

/**
 * Prometheus is the one observability service with no authentication at all
 * (`apps/api/src/http/grafanaProxy.ts` never proxies it for exactly that
 * reason). Two things therefore have to hold in the rendered contract:
 *
 * 1. it runs without the write-endpoint flags above — `POST /-/quit` from
 *    anything that can reach the port would otherwise stop the monitoring stack;
 * 2. its published host bind stays on loopback. It reads `BT_PROMETHEUS_BIND_HOST`
 *    and deliberately NOT `BT_OBS_BIND_HOST`, so the documented LAN recipe moves
 *    Grafana — which has a login — without dragging an unauthenticated metrics
 *    server onto the network with it.
 */
export function assertPrometheusExposure(config: RenderedCompose, topology: string): void {
  const prometheus = renderedService(config, topology, 'prometheus');

  // Both argv sources: a flag smuggled into an entrypoint override reaches the
  // binary exactly like one in `command`.
  const argv = [prometheus.entrypoint, prometheus.command]
    .flatMap((part) => (Array.isArray(part) ? (part as unknown[]) : [part]))
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part))
    .join('\n');

  for (const flag of PROMETHEUS_FORBIDDEN_FLAGS) {
    assert(
      !argv.includes(flag),
      `${topology}: prometheus must not run with ${flag} — it publishes unauthenticated write ` +
        `endpoints (${PROMETHEUS_LIFECYCLE_GATED_PATHS.join(', ')}, series deletion) on a server ` +
        `with no login of its own, and nothing here calls them (the admin probe only GETs ` +
        `${PROMETHEUS_HEALTH_PROBE_PATH}, which is served either way)`,
    );
  }

  const exposedBinds = (prometheus.ports ?? [])
    .map((port) => String(port.host_ip ?? ''))
    .filter((host) => !isLoopbackBind(host))
    .map((host) => host || '(all interfaces)');

  assert.equal(
    exposedBinds.length,
    0,
    `${topology}: prometheus publishes on the non-loopback bind ${exposedBinds.join(', ')} — that ` +
      `is an unauthenticated metrics server, and its whole TSDB, for everything that can reach it. ` +
      `Its bind is ${PROMETHEUS_BIND_HOST_KEY} (loopback by default) and must not follow ` +
      `${GRAFANA_BIND_HOST_KEY}: Grafana, which has a login, is the LAN surface`,
  );
}

/**
 * Guards the probe render itself: if `BT_OBS_BIND_HOST` stopped moving Grafana,
 * the "prometheus stayed on loopback" assertion above would pass for the wrong
 * reason on that topology.
 */
export function assertLanObservabilityBind(
  config: RenderedCompose,
  topology: string,
  lanBind: string,
): void {
  const grafanaBinds = (renderedService(config, topology, 'grafana').ports ?? []).map((port) =>
    String(port.host_ip ?? ''),
  );

  assert(
    grafanaBinds.includes(lanBind),
    `${topology}: the LAN-bind probe did not take — grafana renders ` +
      `${grafanaBinds.join(', ') || '(no published port)'} instead of ${lanBind}, so this render ` +
      `proves nothing about prometheus`,
  );
}

function validateTopology(config: RenderedCompose, topology: ProductionTopology): void {
  assertServiceLoggingLimits(config, topology.label);
  assertGrafanaAdminCredential(config, topology.label);
  assertGrafanaTelemetryDisabled(config, topology.label);
  assertGrafanaAnonymousAccessBind(config, topology.label);
  assertPrometheusExposure(config, topology.label);
  if (topology.lanObservabilityBind) {
    assertLanObservabilityBind(config, topology.label, topology.lanObservabilityBind);
  }

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
