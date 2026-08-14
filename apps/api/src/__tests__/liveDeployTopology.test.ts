import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the 2026-07-11 `alert.triggered` P1 — the class of bug
 * where every process is individually correct but the TOPOLOGY drops the event.
 *
 * Root cause then: the canonical live deploy loop (infra/live/updater.sh) built
 * and `up -d`'d only web+api. Compose never recreates a service it doesn't
 * list and each buildable service owns its own image tag, so the worker
 * container stayed frozen on its first-bring-up image across every auto-deploy.
 * When #427 cut the api over to the durable notifications pipeline, the frozen
 * pre-v2 worker kept publishing `alert.triggered` onto the retired ephemeral
 * bus that nothing subscribes to anymore: alerts flipped to `triggered` with no
 * inbox row and no push.
 *
 * Guard 1 pins the deploy loop: every compose service that builds app code must
 * be in BOTH the updater's `build` list and its final `up -d` list, so adding a
 * service to the stack without adding it to the deploy loop fails CI.
 *
 * Guard 2 pins the worker entry: the ONE process that consumes
 * `notifications.dispatch` must keep registering the consumer and the durable
 * bridge. These are source anchors on scripts/worker.ts (it opens connections at
 * import time, so it cannot be imported in a unit test); if a refactor renames
 * the wiring, update the anchors together with it — deliberately, not silently.
 */

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

/** Top-level compose service names, and which of them have a `build:` block. */
function parseComposeServices(source: string): { all: string[]; buildable: string[] } {
  const all: string[] = [];
  const buildable: string[] = [];
  let inServices = false;
  let current: string | null = null;
  for (const line of source.split('\n')) {
    const topLevel = /^([a-zA-Z][\w-]*):\s*(#.*)?$/.exec(line);
    if (topLevel) {
      inServices = topLevel[1] === 'services';
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z][\w-]*):\s*(#.*)?$/.exec(line);
    if (service) {
      current = service[1]!;
      all.push(current);
      continue;
    }
    if (current && /^ {4}build:/.test(line)) {
      buildable.push(current);
    }
  }
  return { all, buildable };
}

/** Union of the services named across every `dc <verb> …` line in the updater. */
function updaterServices(source: string, pattern: RegExp): Set<string> {
  const services = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    for (const name of match[1]!.trim().split(/\s+/)) services.add(name);
  }
  return services;
}

describe('live deploy loop covers the whole app stack (guard 1)', () => {
  const compose = parseComposeServices(read('infra/docker-compose.yml'));
  const updater = read('infra/live/updater.sh');
  const built = updaterServices(updater, /\bdc build ([a-z][\w -]*?)\s*>>/g);
  const upped = updaterServices(updater, /\bdc up -d ([a-z][\w -]*?)\s*>>/g);

  it('parses the expected stack (parser sanity — a silent no-match must not pass)', () => {
    expect(compose.buildable).toEqual(expect.arrayContaining(['web', 'landing', 'api', 'worker']));
    expect(compose.all).toEqual(expect.arrayContaining(['db', 'redis']));
    expect(built.size).toBeGreaterThan(0);
    expect(upped.size).toBeGreaterThan(0);
  });

  it('every buildable compose service is rebuilt AND recreated by the updater', () => {
    for (const service of compose.buildable) {
      expect(built, `updater.sh must "dc build" the '${service}' service`).toContain(service);
      expect(upped, `updater.sh must "dc up -d" the '${service}' service`).toContain(service);
    }
  });

  it('db and redis are brought up (migrate preflight), and the updater never lists itself', () => {
    expect(upped).toContain('db');
    expect(upped).toContain('redis');
    // The self-exclusion invariant from the script header: `up` recreating the
    // updater would kill the deploy loop mid-deploy.
    expect(upped).not.toContain('updater');
    expect(built).not.toContain('updater');
  });

  it('only known compose services are named (catches a typo that compose would reject at deploy time)', () => {
    const known = new Set(compose.all);
    for (const service of [...built, ...upped]) {
      expect(known, `'${service}' in updater.sh is not a compose service`).toContain(service);
    }
  });
});

/**
 * Observability stack boots on deploy (§13.5 V5-P2 arc (a), owner 2026-07-19).
 *
 * The compose already carried prometheus + grafana, but the live updater's fixed
 * `up -d` list excluded them, so they never booted on the live box (#611). This
 * guard pins the fix: prometheus, grafana and the infra exporters are PULLED
 * images (no app code), so they belong in the final `up -d` list — so monitoring
 * comes up on every deploy — but never in `dc build`. Adding a monitoring service
 * to the compose without adding it to the up-list fails here.
 */
describe('live deploy loop boots the observability stack (guard 3)', () => {
  const compose = parseComposeServices(read('infra/docker-compose.yml'));
  const updater = read('infra/live/updater.sh');
  const built = updaterServices(updater, /\bdc build ([a-z][\w -]*?)\s*>>/g);
  const upped = updaterServices(updater, /\bdc up -d ([a-z][\w -]*?)\s*>>/g);

  const MONITORING_SERVICES = [
    'prometheus',
    'grafana',
    'node-exporter',
    'cadvisor',
    'postgres-exporter',
    'redis-exporter',
  ];

  it('declares every monitoring service in the compose as a pulled (non-buildable) image', () => {
    for (const service of MONITORING_SERVICES) {
      expect(compose.all, `'${service}' must be a compose service`).toContain(service);
      expect(
        compose.buildable,
        `'${service}' is a pulled image — it must NOT have a build block`,
      ).not.toContain(service);
    }
  });

  it('brings every monitoring service up on deploy, and never builds them', () => {
    for (const service of MONITORING_SERVICES) {
      expect(upped, `updater.sh must "dc up -d" the '${service}' service`).toContain(service);
      expect(built, `updater.sh must NOT "dc build" the pulled '${service}' image`).not.toContain(
        service,
      );
    }
  });
});

/**
 * Worker job metrics are actually scraped (#632, §13.5 V5-P2).
 *
 * `bettertrack_job_outcomes_total` is incremented ONLY in the worker process
 * (apps/api/src/jobs/worker.ts), so the dashboard's "Job outcomes" panel is
 * permanently empty unless (a) the worker entrypoint binds its own /metrics
 * listener, (b) that listener is reachable by the prometheus sidecar (bound to
 * 0.0.0.0 inside the container, not the 127.0.0.1 schema default), and (c)
 * prometheus.yml carries a scrape target for it. This guard pins all three.
 */
describe('worker job metrics are scraped (guard 4, #632)', () => {
  const workerEntry = read('apps/api/src/scripts/worker.ts');
  const prometheus = read('infra/prometheus/prometheus.yml');
  const compose = read('infra/docker-compose.yml');
  const sharedEnvironmentBlock = compose.slice(
    compose.indexOf('\nx-api-worker-environment:'),
    compose.indexOf('\nservices:'),
  );

  it('the worker entrypoint starts a metrics scrape listener', () => {
    expect(workerEntry).toContain('createMetricsServer(config, logger)');
  });

  it('prometheus scrapes the worker metrics endpoint by service name', () => {
    expect(prometheus).toContain('bettertrack-worker');
    expect(prometheus).toContain("'worker:9464'");
  });

  it('the worker compose service binds the metrics listener on 0.0.0.0 so the sidecar can reach it', () => {
    // Both processes inherit BT_METRICS_HOST=0.0.0.0 from their one shared
    // environment anchor. Without it the worker falls back to the 127.0.0.1
    // schema default and prometheus cannot scrape worker:9464.
    const workerBlock = compose.slice(compose.indexOf('\n  worker:'), compose.indexOf('\n  db:'));
    expect(workerBlock).toContain('<<: *api-worker-environment');
    expect(sharedEnvironmentBlock).toContain("BT_METRICS_HOST: '${BT_METRICS_HOST:-0.0.0.0}'");
    expect(sharedEnvironmentBlock).toContain('BT_METRICS_ENABLED');
  });
});

describe('compose readiness and cross-container exports (#939)', () => {
  const compose = read('infra/docker-compose.yml');
  const sharedEnvironmentBlock = compose.slice(
    compose.indexOf('\nx-api-worker-environment:'),
    compose.indexOf('\nservices:'),
  );
  const apiBlock = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  worker:'));
  const workerBlock = compose.slice(compose.indexOf('\n  worker:'), compose.indexOf('\n  db:'));
  const buildConfig = read('apps/api/tsup.config.ts');
  const dockerfile = read('apps/api/Dockerfile');
  const exportPath = '/var/lib/bettertrack/exports';

  it('gates api health on the DB + Redis readiness route', () => {
    expect(apiBlock).toContain('/api/v1/health/ready');
    expect(apiBlock).not.toContain('http://localhost:3000/api/v1/health ||');
  });

  it('ships and invokes the worker heartbeat probe with startup grace', () => {
    expect(buildConfig).toContain("'src/scripts/workerHealth.ts'");
    expect(workerBlock).toContain("['CMD', 'node', 'dist/scripts/workerHealth.js']");
    expect(workerBlock).toContain('start_period: 3m');
  });

  it('mounts one writable export volume at the identical api and worker path', () => {
    expect(sharedEnvironmentBlock).toContain(`BT_EXPORT_DIR: '${exportPath}'`);
    for (const serviceBlock of [apiBlock, workerBlock]) {
      expect(serviceBlock).toContain('<<: *api-worker-environment');
      expect(serviceBlock).toContain(`exportdata:${exportPath}`);
    }
    expect(compose.slice(compose.lastIndexOf('\nvolumes:'))).toContain('\n  exportdata:');
    expect(dockerfile).toContain(`mkdir -p ${exportPath}`);
    expect(dockerfile).toContain('chown -R bettertrack:bettertrack /var/lib/bettertrack');
  });

  it('keeps the gyp fallback toolchain in Docker build-only stages', () => {
    const runnerMarker = 'AS runner';
    const runnerMarkerIndex = dockerfile.indexOf(runnerMarker);

    expect(runnerMarkerIndex, 'Dockerfile must define its final runner stage').toBeGreaterThan(-1);

    const buildStages = dockerfile.slice(0, runnerMarkerIndex);
    const runnerStage = dockerfile.slice(runnerMarkerIndex);

    expect(
      buildStages,
      'Dockerfile must retain the node-gyp fallback toolchain in a build stage',
    ).toContain('RUN apk add --no-cache python3 make g++');
    expect(
      runnerStage,
      'Dockerfile invariant: build toolchain stays in build-only stages',
    ).not.toContain('apk add');
  });
});

describe('worker entry registers the durable notification consumer + bridge (guard 2)', () => {
  const workerEntry = read('apps/api/src/scripts/worker.ts');

  it('registers the notifications.dispatch consumer with the fully-built dispatcher + webhook bridge', () => {
    // V5-P10 (#648): the durable dispatch consumer also fans events out to the
    // webhook bridge — the ONE place every user-scoped event converges.
    expect(workerEntry).toMatch(
      /createNotificationsDispatchJob\(\{\s*dispatcher,\s*webhooks: webhookBridge,\s*\}\)/,
    );
    expect(workerEntry).toContain('createNotificationDispatcher(');
  });

  it('bridges the notification center onto the durable queue (never the ephemeral bus)', () => {
    expect(workerEntry).toContain("registry.enqueue('notifications.dispatch', { event })");
  });

  it('hands the center to the registered jobs so the alert evaluator emits durably', () => {
    expect(workerEntry).toContain('createNotificationCenter(');
    expect(workerEntry).toContain('assembleRegisteredJobDefinitions({');
    expect(workerEntry).toMatch(
      /const coreJobDeps = \{[\s\S]*?\bnotify,[\s\S]*?\};[\s\S]*?createAlertsEvaluateJob\(coreJobDeps\)/,
    );
  });
});

describe('live legal pages consume the canonical landing tree (#984)', () => {
  const updater = read('infra/live/updater.sh');
  const liveEdge = read('infra/live/edge/bt-live-edge.conf');
  const productBlock = liveEdge.slice(
    liveEdge.indexOf('# ── Product page'),
    liveEdge.indexOf('# ── Mobile placeholder'),
  );

  it('copies the four legal directories plus every remaining live overlay directory', () => {
    expect(updater).toContain('_landing_src="$APP/apps/landing/site"');
    expect(updater).toContain('for _name in terms privacy impressum cookies; do');
    expect(updater).toContain('cp -R "$_dir" "${_dst}/"');
    expect(updater).toContain('_overlay_src="$APP/infra/live/edge/html/product"');
    expect(updater).toContain('for _dir in "$_overlay_src"/*/; do');
    expect(updater).toContain('cp -R "${_overlay_src}/${_name}" "${_dst}/"');
    expect(read('infra/live/edge/html/product/404/index.html')).toContain(
      '<title>Page not found — BetterTrack</title>',
    );
  });

  it('publishes every root script loaded by the legal documents without copying the landing root', () => {
    expect(updater).toContain('for _name in env.js landing.js; do');
    expect(updater).toContain('_file="${_landing_src}/${_name}"');
    expect(updater).toContain('cp "$_file" "${_dst}/${_name}"');
    expect(updater).not.toContain('cp -R "$_landing_src"');

    for (const page of ['terms', 'privacy', 'impressum', 'cookies']) {
      for (const localePath of ['index.html', 'de/index.html']) {
        const document = read(`apps/landing/site/${page}/${localePath}`);
        expect(document).toContain('<script src="/env.js"></script>');
        expect(document).toContain('<script src="/landing.js"></script>');
      }
    }
  });

  it('keeps the live edge directory-route contract unchanged', () => {
    expect(productBlock).toContain('root /usr/share/nginx/bt-live/product;');
    expect(productBlock).toContain('index index.html;');
    expect(productBlock).toContain('try_files $uri $uri/ =404;');
    for (const page of ['terms', 'privacy', 'impressum', 'cookies']) {
      expect(productBlock).toContain(`/${page}/`);
      expect(productBlock).toContain(`/${page}/de/`);
    }
  });
});
