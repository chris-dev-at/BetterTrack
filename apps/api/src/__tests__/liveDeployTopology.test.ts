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
  // Matches the named final runner stage, allowing `FROM --option image` and
  // lowercase `as`; it intentionally does not span backslash-continued headers.
  const runnerStageHeader =
    /^FROM[ \t]+(?:--[^\s\\]+[ \t]+)*[^\s\\]+[ \t]+[Aa][Ss][ \t]+runner(?:[ \t]|$).*$/m;
  // Covers `apk add` plus any number or order of short or long options before
  // `add` (for example, `apk -q --no-cache add`); it intentionally does not
  // span backslash-continued command lines.
  const apkAddCommand = /\bapk[ \t]+(?:-{1,2}[^\s\\]+[ \t]+)*add\b/;

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
    const runnerStageMatch = dockerfile.match(runnerStageHeader);
    const runnerMarkerIndex = runnerStageMatch?.index ?? -1;

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
    ).not.toMatch(apkAddCommand);
  });

  it('recognizes runner-stage and apk option drift without changing the Dockerfile', () => {
    expect('FROM --platform=$BUILDPLATFORM node:22-alpine AS runner').toMatch(runnerStageHeader);
    expect('FROM node:22-alpine as runner').toMatch(runnerStageHeader);
    expect('FROM node:22-alpine AS build').not.toMatch(runnerStageHeader);
    expect('FROM node:22-alpine AS runner-tools').not.toMatch(runnerStageHeader);
    expect('FROM --platform=$BUILDPLATFORM\\\n node:22-alpine AS runner').not.toMatch(
      runnerStageHeader,
    );

    for (const command of [
      'RUN apk -U add curl',
      'RUN apk -q --no-cache add curl',
      'RUN apk --no-cache add curl',
    ]) {
      expect(command).toMatch(apkAddCommand);
    }

    expect('RUN apk -q info').not.toMatch(apkAddCommand);
    expect('RUN apk -q\\\n  add curl').not.toMatch(apkAddCommand);
  });
});

/**
 * Top-level property names of the object literal passed to
 * `createNotificationDispatcher({ … })`, sorted. Full-line comments are dropped
 * first (they carry commas and braces); string literals are skipped so a comma
 * inside one cannot split a property.
 */
function dispatcherDependencyKeys(source: string): string[] {
  const marker = 'createNotificationDispatcher({';
  const start = source.indexOf(marker);
  expect(start, 'source must construct a notification dispatcher').toBeGreaterThan(-1);
  const body = source
    .slice(start + marker.length)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  const pieces: string[] = [];
  let current = '';
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') {
      if (depth === 0) break; // the dispatcher literal's own closing brace
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      pieces.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  pieces.push(current);

  const keys: string[] = [];
  for (const piece of pieces) {
    const named = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(piece);
    const shorthand = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(piece);
    const key = named?.[1] ?? shorthand?.[1];
    if (key) keys.push(key);
  }
  return keys.sort();
}

describe('worker entry registers the durable notification consumer + bridge (guard 2)', () => {
  const workerEntry = read('apps/api/src/scripts/worker.ts');
  const apiContext = read('apps/api/src/http/context.ts');

  it('registers the notifications.dispatch consumer with the fully-built dispatcher + webhook bridge', () => {
    // V5-P10 (#648): the durable dispatch consumer also fans events out to the
    // webhook bridge — the ONE place every user-scoped event converges.
    expect(workerEntry).toMatch(
      /createNotificationsDispatchJob\(\{\s*dispatcher,\s*webhooks: webhookBridge,\s*\}\)/,
    );
    expect(workerEntry).toContain('createNotificationDispatcher(');
  });

  it('hands the worker dispatcher the SAME dependency set as the API dispatcher', () => {
    // The 2026-09 drift (#1723): both processes built a dispatcher, but only
    // the API built the Telegram + Discord channels. In production the worker
    // is the authoritative dispatcher, so `routing.telegram && telegram` saw
    // `undefined` and every Telegram/Discord notification was silently dropped
    // — the kill-switch's "env flip restores" half never worked at all.
    //
    // Comparing the two dependency SETS is what makes this guard survive the
    // next channel: adding one to a single entry point fails here, whichever
    // entry point was forgotten.
    const workerKeys = dispatcherDependencyKeys(workerEntry);
    const apiKeys = dispatcherDependencyKeys(apiContext);
    expect(workerKeys).toEqual(apiKeys);
    // Named explicitly so deleting a channel from BOTH entry points — which
    // the set comparison alone would happily accept — still fails.
    for (const channel of ['fcm', 'webPush', 'telegram', 'discord']) {
      expect(workerKeys, `dispatcher must receive the ${channel} channel`).toContain(channel);
    }
  });

  it("builds both dispatchers' channels through the one shared factory", () => {
    // Passing the same keys is necessary but not sufficient: the values have to
    // come from the same place, or the worker can pass `telegram: null` forever
    // while the API builds a live channel.
    for (const [name, source] of [
      ['worker entry', workerEntry],
      ['api context', apiContext],
    ] as const) {
      expect(source, `${name} must build channels via createNotificationChannelSet`).toContain(
        'createNotificationChannelSet({ db, config, logger })',
      );
    }
  });

  it('recognizes a channel added to only one entry point', () => {
    // Self-test of the parser: it must see the keys, not just the substring.
    const apiLike = `const d = createNotificationDispatcher({
      bus: events,
      // a comment, with a comma and a { brace
      fcm: fcmChannel,
      telegram: telegramChannel,
      digest: { cadenceFor: (a, b) => x(a, b) },
      logger,
    });`;
    const workerLike = apiLike.replace('      telegram: telegramChannel,\n', '');
    expect(dispatcherDependencyKeys(apiLike)).toEqual([
      'bus',
      'digest',
      'fcm',
      'logger',
      'telegram',
    ]);
    expect(dispatcherDependencyKeys(workerLike)).not.toEqual(dispatcherDependencyKeys(apiLike));
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
