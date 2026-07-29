import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * nginx front-proxy template rendering (PROJECTPLAN.md §4.6, §11; V3-P12 arc c).
 *
 * The `web` container renders one of two `server`-block layouts from env at start
 * via docker-entrypoint.sh (restricted `envsubst`). These tests exercise that
 * templating path in-process — substituting the SAME whitelisted vars the
 * entrypoint exports — to prove the 5-origin layout (api/web/admin + the static
 * product apex and mobile placeholder) falls out of env alone, with no
 * hand-edited nginx. The security-policy assertions also lock nginx's
 * add_header inheritance workaround: every static server and every location
 * that declares Cache-Control must include the same rendered policy.
 */

const infraDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../infra');
const repoDir = resolve(infraDir, '..');

function template(mode: 'subdomains' | 'ports'): string {
  return readFileSync(resolve(infraDir, `nginx/templates/${mode}.conf.template`), 'utf8');
}

function readInfra(path: string): string {
  return readFileSync(resolve(infraDir, path), 'utf8');
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function section(value: string, start: string, end: string): string {
  return value.slice(value.indexOf(start), value.indexOf(end));
}

/** Mirror the entrypoint's restricted envsubst: replace only `${NAME}` for NAME in env. */
function render(raw: string, env: Record<string, string>): string {
  return raw.replace(/\$\{(\w+)\}/g, (match, name: string) => env[name] ?? match);
}

function composeLandingEnvironment(hostEnv: Record<string, string>): Record<string, string> {
  const compose = readInfra('docker-compose.yml');
  const landingStart = compose.indexOf('\n  landing:\n');
  const apiStart = compose.indexOf('\n  api:\n', landingStart);
  if (landingStart < 0 || apiStart < 0) throw new Error('landing Compose service not found');

  const landingService = compose.slice(landingStart, apiStart);
  const entries = [...landingService.matchAll(/^ {6}([A-Z][A-Z0-9_]*): '([^']*)'$/gm)];
  return Object.fromEntries(
    entries.map((entry) => {
      const name = entry[1];
      const rawValue = entry[2];
      if (name === undefined || rawValue === undefined) {
        throw new Error('invalid landing Compose environment entry');
      }
      return [
        name,
        rawValue.replace(
          /\$\{([A-Z][A-Z0-9_]*):-(.*?)\}/g,
          (_match, variable: string, fallback: string) => hostEnv[variable] || fallback,
        ),
      ];
    }),
  );
}

function renderLandingEntrypoint(env: Record<string, string>): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'bettertrack-landing-topology-'));
  const htmlRoot = resolve(temporaryRoot, 'html');
  const binRoot = resolve(temporaryRoot, 'bin');
  const fakeEnvsubst = resolve(binRoot, 'envsubst');
  mkdirSync(htmlRoot);
  mkdirSync(binRoot);
  writeFileSync(
    resolve(htmlRoot, 'env.js.template'),
    readFileSync(resolve(repoDir, 'apps/landing/site/env.js.template'), 'utf8'),
  );
  writeFileSync(
    fakeEnvsubst,
    [
      '#!/usr/bin/env node',
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  input = input.replaceAll('${BT_WEB_ORIGIN}', process.env.BT_WEB_ORIGIN || '');",
      "  input = input.replaceAll('${BT_API_ORIGIN}', process.env.BT_API_ORIGIN || '');",
      '  process.stdout.write(input);',
      '});',
      '',
    ].join('\n'),
  );
  chmodSync(fakeEnvsubst, 0o755);

  try {
    execFileSync('sh', [resolve(repoDir, 'apps/landing/docker-entrypoint.sh')], {
      env: {
        ...process.env,
        ...env,
        BT_LANDING_HTML_ROOT: htmlRoot,
        PATH: `${binRoot}:${process.env.PATH ?? ''}`,
      },
    });
    return readFileSync(resolve(htmlRoot, 'env.js'), 'utf8');
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

const SECURITY_INCLUDE = 'include /etc/nginx/bt-includes/static-security-headers.conf;';
const CONDITIONAL_HSTS_INCLUDE = 'include /etc/nginx/bt-includes/static-hsts.conf;';

const SUBDOMAINS_ENV: Record<string, string> = {
  BT_DOMAIN: 'track.example.at',
  BT_SUB_API: 'api',
  BT_SUB_WEB: 'web',
  BT_SUB_ADMIN: 'admin',
  BT_SUB_MOBILE: 'mobile',
  API_UPSTREAM: 'api:3000',
  LANDING_UPSTREAM: 'landing:80',
  API_ORIGIN: 'https://api.track.example.at',
  WS_ORIGIN: 'wss://api.track.example.at',
};

const PORTS_ENV: Record<string, string> = {
  BT_PORT_API: '3000',
  BT_PORT_WEB: '8080',
  BT_PORT_ADMIN: '8081',
  BT_PORT_PRODUCT: '8082',
  BT_PORT_MOBILE: '8083',
  API_UPSTREAM: 'api:3000',
  LANDING_UPSTREAM: 'landing:80',
  API_ORIGIN: 'http://track.example.at:3000',
  WS_ORIGIN: 'ws://track.example.at:3000',
};

describe('subdomains template', () => {
  const out = render(template('subdomains'), SUBDOMAINS_ENV);

  it('keeps the api/web/admin server_name blocks byte-identical', () => {
    expect(out).toContain('server_name api.track.example.at;');
    expect(out).toContain('server_name web.track.example.at;');
    expect(out).toContain('server_name admin.track.example.at;');
    expect(out).toContain('proxy_pass http://api:3000;');
  });

  it('serves the product landing from the apex origin', () => {
    expect(out).toContain('server_name track.example.at;');
    // The apex block reverse-proxies to the static landing container.
    expect(out).toContain('proxy_pass http://landing:80;');
  });

  it('serves the mobile placeholder from its own subdomain, rooting at mobile.html', () => {
    expect(out).toContain('server_name mobile.track.example.at;');
    expect(out).toContain('proxy_pass http://landing:80/mobile.html;');
  });

  it('substitutes every whitelisted var (no topology value left)', () => {
    expect(out).not.toMatch(/\$\{(BT_|LANDING_UPSTREAM|API_UPSTREAM|API_ORIGIN|WS_ORIGIN)/);
  });

  it('applies the shared policy and conditional HSTS to every static response path', () => {
    // user: server + config.js + assets; admin: same; product + mobile: server.
    expect(occurrences(out, SECURITY_INCLUDE)).toBe(8);
    expect(occurrences(out, CONDITIONAL_HSTS_INCLUDE)).toBe(8);
    expect(section(out, '# ── API origin', '# ── Web origin')).not.toContain(SECURITY_INCLUDE);
  });
});

describe('ports template', () => {
  const out = render(template('ports'), PORTS_ENV);

  it('keeps the api/web/admin listen ports byte-identical', () => {
    expect(out).toContain('listen 3000;');
    expect(out).toContain('listen 8080 default_server;');
    expect(out).toContain('listen 8081;');
  });

  it('gives product + mobile their own symmetric listen ports', () => {
    expect(out).toContain('listen 8082;');
    expect(out).toContain('listen 8083;');
    expect(out).toContain('proxy_pass http://landing:80;');
    expect(out).toContain('proxy_pass http://landing:80/mobile.html;');
  });

  it('substitutes every whitelisted var', () => {
    expect(out).not.toMatch(/\$\{(BT_|LANDING_UPSTREAM|API_UPSTREAM|API_ORIGIN|WS_ORIGIN)/);
  });

  it('applies the shared policy to every static response path without literal HSTS', () => {
    expect(occurrences(out, SECURITY_INCLUDE)).toBe(8);
    expect(occurrences(out, CONDITIONAL_HSTS_INCLUDE)).toBe(8);
    expect(section(out, '# ── API port', '# ── Web port')).not.toContain(SECURITY_INCLUDE);
    expect(out).not.toContain('add_header Strict-Transport-Security');
  });
});

describe('static browser security policy', () => {
  const rawPolicy = readInfra('nginx/templates/includes/static-security-headers.conf.template');
  const renderedPolicy = render(rawPolicy, SUBDOMAINS_ENV);
  const csp = renderedPolicy.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1] ?? '';
  const scriptSrc = csp
    .split(';')
    .map((directive) => directive.trim())
    .find((directive) => directive.startsWith('script-src'));

  it('ships the required baseline with a frame-ancestors deny-all policy', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(
      "connect-src 'self' https://api.track.example.at wss://api.track.example.at",
    );
    expect(csp).not.toMatch(/\b(?:ws|wss):(?:\s|;)/);
    expect(csp).toContain(
      "frame-src 'self' https://api.track.example.at https://accounts.google.com",
    );
    expect(csp).not.toMatch(/frame-src[^;]*\shttps:(?:\s|;|$)/);
    expect(renderedPolicy).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(renderedPolicy).toContain(
      'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
    );
    expect(renderedPolicy).toContain(
      'add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;',
    );
  });

  it('never permits inline/eval scripts while documenting the style-only exception', () => {
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://accounts.google.com");
    expect(rawPolicy).toContain('inline style attributes');
  });

  it('renders HSTS only into a deployment whose public scheme is HTTPS', () => {
    const entrypoint = readInfra('nginx/docker-entrypoint.sh');
    const hsts = readInfra('nginx/templates/includes/static-hsts.conf');

    expect(hsts).toContain('add_header Strict-Transport-Security "max-age=31536000" always;');
    expect(rawPolicy).not.toContain('Strict-Transport-Security');
    expect(entrypoint).toContain('if [ "$SCHEME" = "https" ]; then');
    expect(entrypoint).toContain(
      'cp /etc/nginx/bt-templates/includes/static-hsts.conf "$INCLUDE_DIR/static-hsts.conf"',
    );
    expect(entrypoint).toContain(': > "$INCLUDE_DIR/static-hsts.conf"');
  });

  it('keeps the live TLS edge on the shared baseline and explicit HSTS', () => {
    const liveEdge = readInfra('live/edge/bt-live-edge.conf');
    expect(occurrences(liveEdge, SECURITY_INCLUDE)).toBe(4);
    expect(
      occurrences(liveEdge, 'include /etc/nginx/bt-templates/includes/static-hsts.conf;'),
    ).toBe(4);
  });

  it('loads every landing behavior from external scripts under script-src self', () => {
    for (const name of ['index.html', 'de.html', 'mobile.html', 'mobile.de.html']) {
      const html = readFileSync(resolve(repoDir, 'apps/landing/site', name), 'utf8');
      const scripts = html.match(/<script\b[^>]*>/g) ?? [];
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.every((tag) => /\bsrc=/.test(tag))).toBe(true);
      expect(html).toContain('<script src="/landing.js"></script>');
    }
  });
});

describe('shipped landing Compose topology', () => {
  it('derives custom subdomain origins that match the front proxy CSP', () => {
    const rendered = renderLandingEntrypoint(
      composeLandingEnvironment({
        BT_MODE: 'subdomains',
        BT_DOMAIN: 'money.example.net',
        BT_SUB_API: 'gateway',
        BT_SUB_WEB: 'app',
      }),
    );

    expect(rendered).toBe(
      "window.__BT_LANDING__ = { webOrigin: 'https://app.money.example.net', apiOrigin: 'https://gateway.money.example.net' };\n",
    );
  });

  it('derives plain-HTTP ports origins from the shipped Compose environment', () => {
    const rendered = renderLandingEntrypoint(
      composeLandingEnvironment({
        BT_MODE: 'ports',
        BT_DOMAIN: 'track.lan',
        BT_PORT_API: '4300',
        BT_PORT_WEB: '4800',
      }),
    );

    expect(rendered).toBe(
      "window.__BT_LANDING__ = { webOrigin: 'http://track.lan:4800', apiOrigin: 'http://track.lan:4300' };\n",
    );
  });

  it('honors the same explicit Compose origin overrides as the front proxy', () => {
    const rendered = renderLandingEntrypoint(
      composeLandingEnvironment({
        BT_MODE: 'subdomains',
        BT_DOMAIN: 'internal.example.net',
        BT_API_ORIGIN: 'https://public-api.example.net/',
        BT_WEB_ORIGIN: 'https://public-app.example.net/',
      }),
    );

    expect(rendered).toBe(
      "window.__BT_LANDING__ = { webOrigin: 'https://public-app.example.net', apiOrigin: 'https://public-api.example.net' };\n",
    );
  });
});
