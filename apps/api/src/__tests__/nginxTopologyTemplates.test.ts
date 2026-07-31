import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

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

const LEGAL_PAGES = ['terms', 'privacy', 'impressum', 'cookies'] as const;
const LEGAL_DOCUMENTS = LEGAL_PAGES.flatMap((page) => [
  {
    route: `/${page}/`,
    repositoryPath: `apps/landing/site/${page}/index.html`,
  },
  {
    route: `/${page}/de/`,
    repositoryPath: `apps/landing/site/${page}/de/index.html`,
  },
]);

function assertProductLandingProxy(
  renderedTemplate: string,
  productSectionStart: string,
  mobileSectionStart: string,
): void {
  const product = section(renderedTemplate, productSectionStart, mobileSectionStart);
  expect(product).toContain('location / {');
  expect(product).toContain('proxy_pass http://landing:80;');
}

/** Mirror the entrypoint's restricted envsubst: replace only `${NAME}` for NAME in env. */
function render(raw: string, env: Record<string, string>): string {
  return raw.replace(/\$\{(\w+)\}/g, (match, name: string) => env[name] ?? match);
}

/**
 * Read the SHIPPED Compose `environment:` block of one service and resolve its
 * `${VAR:-default}` interpolations against a host env. This is what makes the
 * entrypoint tests below regression tests for the wiring itself: a variable the
 * front proxy needs but Compose never passes shows up as a missing key here.
 */
function composeServiceEnvironment(
  service: string,
  nextService: string,
  hostEnv: Record<string, string>,
): Record<string, string> {
  const compose = readInfra('docker-compose.yml');
  const start = compose.indexOf(`\n  ${service}:\n`);
  const end = compose.indexOf(`\n  ${nextService}:\n`, start);
  if (start < 0 || end < 0) throw new Error(`${service} Compose service not found`);

  const entries = [...compose.slice(start, end).matchAll(/^ {6}([A-Z][A-Z0-9_]*): '([^']*)'$/gm)];
  return Object.fromEntries(
    entries.map((entry) => {
      const name = entry[1];
      const rawValue = entry[2];
      if (name === undefined || rawValue === undefined) {
        throw new Error(`invalid ${service} Compose environment entry`);
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

function composeLandingEnvironment(hostEnv: Record<string, string>): Record<string, string> {
  return composeServiceEnvironment('landing', 'api', hostEnv);
}

function composeWebEnvironment(hostEnv: Record<string, string>): Record<string, string> {
  return composeServiceEnvironment('web', 'landing', hostEnv);
}

interface LandingEntrypointRun {
  status: number;
  stderr: string;
  /** null when the entrypoint refused to boot before rendering. */
  config: string | null;
}

function runLandingEntrypoint(env: Record<string, string>): LandingEntrypointRun {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'bettertrack-landing-topology-'));
  const htmlRoot = resolve(temporaryRoot, 'html');
  mkdirSync(htmlRoot);
  writeFileSync(
    resolve(htmlRoot, 'env.js.template'),
    readFileSync(resolve(repoDir, 'apps/landing/site/env.js.template'), 'utf8'),
  );

  try {
    const result = spawnSync('sh', [resolve(repoDir, 'apps/landing/docker-entrypoint.sh')], {
      env: {
        ...process.env,
        ...env,
        BT_LANDING_HTML_ROOT: htmlRoot,
      },
      encoding: 'utf8',
    });
    return {
      status: result.status ?? 1,
      stderr: result.stderr ?? '',
      config: existsSync(resolve(htmlRoot, 'env.js'))
        ? readFileSync(resolve(htmlRoot, 'env.js'), 'utf8')
        : null,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function renderLandingEntrypoint(env: Record<string, string>): string {
  const result = runLandingEntrypoint(env);
  if (result.status !== 0 || result.config === null) {
    throw new Error(`landing entrypoint failed: ${result.stderr}`);
  }
  return result.config;
}

function landingRuntimeConfig(rendered: string): { webOrigin: string; apiOrigin: string } {
  const assignment = /window\.__BT_LANDING__ = (\{.*\});/.exec(rendered);
  if (!assignment?.[1]) throw new Error('landing config assignment not found');
  return JSON.parse(assignment[1]) as { webOrigin: string; apiOrigin: string };
}

interface LandingElement {
  tagName: string;
  hidden: boolean;
  textContent: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

function landingElement(
  tagName: string,
  attributes: Record<string, string> = {},
  textContent = '',
): LandingElement {
  const values = new Map(Object.entries(attributes));
  return {
    tagName,
    hidden: false,
    textContent,
    getAttribute(name) {
      return values.get(name) ?? null;
    },
    setAttribute(name, value) {
      values.set(name, value);
    },
  };
}

type LandingRegistrationMode = 'closed' | 'invite_token' | 'approval' | 'open';

interface LandingScriptRun {
  documentElement: LandingElement;
  webLink: LandingElement;
  webPathLink: LandingElement;
  registerCta: LandingElement;
  registrationNote: LandingElement;
  title: LandingElement;
  description: LandingElement;
  footer: LandingElement;
}

async function runLandingScript(options: {
  mode?: LandingRegistrationMode;
  fetchFailure?: boolean;
  includeRegistrationUi?: boolean;
  webOrigin?: string;
  apiOrigin?: string;
  webPath?: string;
}): Promise<LandingScriptRun> {
  const documentElement = landingElement('HTML');
  const webLink = landingElement('A', { href: 'https://web.bettertrack.at' });
  const webPathLink = landingElement('A', {
    href: 'https://web.bettertrack.at/account/delete',
    'data-web-path': options.webPath ?? '/account/delete',
  });
  const registerCta = landingElement('A', {
    'data-registration-label-invite_token': 'Register with an invite token',
    'data-registration-label-approval': 'Request an account',
    'data-registration-label-open': 'Create an account',
  });
  registerCta.hidden = true;
  const registrationNote = landingElement('P', {
    'data-registration-copy-closed': 'Registration is currently closed.',
    'data-registration-copy-invite_token': 'Registration requires an invite token.',
    'data-registration-copy-approval': 'Request an account, then wait for approval.',
    'data-registration-copy-open': 'Registration is open. Create an account to get started.',
    'data-registration-copy-unavailable': 'Registration status unavailable.',
  });
  registrationNote.hidden = true;
  const title = landingElement(
    'TITLE',
    {
      'data-registration-copy-closed': 'BetterTrack — registration closed',
      'data-registration-copy-invite_token': 'BetterTrack — register with an invite token',
      'data-registration-copy-approval': 'BetterTrack — request an account',
      'data-registration-copy-open': 'BetterTrack — create an account',
    },
    'BetterTrack — your personal investing workspace',
  );
  const description = landingElement('META', {
    content: 'Neutral registration description.',
    'data-registration-copy-closed': 'Registration is closed.',
    'data-registration-copy-invite_token': 'Registration requires an invite token.',
    'data-registration-copy-approval': 'Account requests are reviewed before access.',
    'data-registration-copy-open': 'Registration is open.',
  });
  const eyebrow = landingElement('SPAN', {
    'data-registration-copy-closed': 'Self-hosted · Registration closed',
    'data-registration-copy-invite_token': 'Self-hosted · Invite token required',
    'data-registration-copy-approval': 'Self-hosted · Approval required',
    'data-registration-copy-open': 'Self-hosted · Registration open',
  });
  const footer = landingElement('SPAN', {
    'data-registration-copy-closed': 'Self-hosted personal finance. Registration is closed.',
    'data-registration-copy-invite_token':
      'Self-hosted personal finance. An invite token is required.',
    'data-registration-copy-approval':
      'Self-hosted personal finance. Account requests require approval.',
    'data-registration-copy-open': 'Self-hosted personal finance. Registration is open.',
  });
  const copyElements = [registrationNote, title, description, eyebrow, footer];
  const includeRegistrationUi = options.includeRegistrationUi !== false;
  const document = {
    documentElement,
    querySelector(selector: string) {
      if (!includeRegistrationUi) return null;
      if (selector === '.js-register-cta') return registerCta;
      if (selector === '.js-registration-note') return registrationNote;
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '.js-web-link') return [webLink, webPathLink];
      const match = /^\[data-registration-copy-(.+)]$/.exec(selector);
      if (!match?.[1]) return [];
      return copyElements.filter(
        (element) => element.getAttribute(`data-registration-copy-${match[1]}`) !== null,
      );
    },
  };
  const fetch = options.fetchFailure
    ? () => Promise.reject(new Error('offline'))
    : () =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ mode: options.mode }),
        });
  const window = {
    __BT_LANDING__: {
      webOrigin: options.webOrigin ?? 'https://web.example.net',
      apiOrigin: options.apiOrigin ?? 'https://api.example.net',
    },
    fetch,
  };
  const landingScript = readFileSync(resolve(repoDir, 'apps/landing/site/landing.js'), 'utf8');
  runInNewContext(landingScript, { Error, URL, document, fetch, window });
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

  return {
    documentElement,
    webLink,
    webPathLink,
    registerCta,
    registrationNote,
    title,
    description,
    footer,
  };
}

interface WebEntrypointRun {
  status: number;
  stderr: string;
  /** null when the entrypoint refused to boot before rendering. */
  policy: string | null;
  defaultConf: string | null;
  hsts: string | null;
}

/**
 * Execute the REAL `infra/nginx/docker-entrypoint.sh` against an isolated nginx
 * tree. The `render()` helper above only emulates envsubst, so it cannot catch a
 * derivation or validation bug in the entrypoint itself — this harness runs the
 * shipped script, with `nginx` stubbed (the script ends in `exec nginx`) and a
 * faithful stand-in for gettext's restricted `envsubst '<shell-format>'`.
 */
function runWebEntrypoint(env: Record<string, string>): WebEntrypointRun {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'bettertrack-web-topology-'));
  const nginxRoot = resolve(temporaryRoot, 'etc-nginx');
  const binRoot = resolve(temporaryRoot, 'bin');
  mkdirSync(resolve(nginxRoot, 'conf.d'), { recursive: true });
  mkdirSync(binRoot);
  // Same wholesale copy apps/web/Dockerfile makes into /etc/nginx/bt-templates.
  cpSync(resolve(infraDir, 'nginx/templates'), resolve(nginxRoot, 'bt-templates'), {
    recursive: true,
  });
  writeFileSync(
    resolve(binRoot, 'envsubst'),
    [
      '#!/usr/bin/env node',
      "const names = [...(process.argv[2] ?? '').matchAll(/\\$\\{(\\w+)\\}/g)].map((m) => m[1]);",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      '  for (const name of names) {',
      "    input = input.replaceAll('${' + name + '}', process.env[name] ?? '');",
      '  }',
      '  process.stdout.write(input);',
      '});',
      '',
    ].join('\n'),
  );
  writeFileSync(resolve(binRoot, 'nginx'), '#!/bin/sh\nexit 0\n');
  chmodSync(resolve(binRoot, 'envsubst'), 0o755);
  chmodSync(resolve(binRoot, 'nginx'), 0o755);

  // Drop inherited BT_* vars so only the Compose-derived env under test applies.
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('BT_')),
  );

  try {
    const result = spawnSync('sh', [resolve(infraDir, 'nginx/docker-entrypoint.sh')], {
      env: {
        ...baseEnv,
        ...env,
        BT_NGINX_CONF_ROOT: nginxRoot,
        PATH: `${binRoot}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    });
    const read = (relative: string): string | null => {
      const path = resolve(nginxRoot, relative);
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    };
    return {
      status: result.status ?? -1,
      stderr: result.stderr ?? '',
      policy: read('bt-includes/static-security-headers.conf'),
      defaultConf: read('conf.d/default.conf'),
      hsts: read('bt-includes/static-hsts.conf'),
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function contentSecurityPolicy(rendered: string | null): string {
  return rendered?.match(/add_header Content-Security-Policy "([^"]+)"/)?.[1] ?? '';
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
  PRODUCT_ORIGIN: 'https://track.example.at',
  WS_ORIGIN: 'wss://api.track.example.at',
  // Rendered empty unless BT_GRAFANA_PUBLIC_URL is configured; the entrypoint
  // suite below covers the configured shape against the real script.
  GRAFANA_FRAME_SRC: '',
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
  PRODUCT_ORIGIN: 'http://track.example.at:8082',
  WS_ORIGIN: 'ws://track.example.at:3000',
  GRAFANA_FRAME_SRC: '',
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
    expect(out).toContain('productOrigin: "https://track.example.at"');
    assertProductLandingProxy(out, '# ── Product origin', '# ── Mobile origin');
  });

  it('serves the mobile placeholder from its own subdomain, rooting at mobile.html', () => {
    expect(out).toContain('server_name mobile.track.example.at;');
    expect(out).toContain('proxy_pass http://landing:80/mobile.html;');
  });

  it('substitutes every whitelisted var (no topology value left)', () => {
    expect(out).not.toMatch(
      /\$\{(BT_|LANDING_UPSTREAM|API_UPSTREAM|API_ORIGIN|PRODUCT_ORIGIN|WS_ORIGIN)/,
    );
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
    expect(out).toContain('productOrigin: "http://track.example.at:8082"');
    assertProductLandingProxy(out, '# ── Product port', '# ── Mobile port');
  });

  it('substitutes every whitelisted var', () => {
    expect(out).not.toMatch(
      /\$\{(BT_|LANDING_UPSTREAM|API_UPSTREAM|API_ORIGIN|PRODUCT_ORIGIN|WS_ORIGIN)/,
    );
  });

  it('applies the shared policy to every static response path without literal HSTS', () => {
    expect(occurrences(out, SECURITY_INCLUDE)).toBe(8);
    expect(occurrences(out, CONDITIONAL_HSTS_INCLUDE)).toBe(8);
    expect(section(out, '# ── API port', '# ── Web port')).not.toContain(SECURITY_INCLUDE);
    expect(out).not.toContain('add_header Strict-Transport-Security');
  });
});

describe('canonical landing legal documents', () => {
  it('ships every canonical legal route from the landing tree', () => {
    for (const document of LEGAL_DOCUMENTS) {
      expect(
        existsSync(resolve(repoDir, document.repositoryPath)),
        `${document.route} must resolve to shipped landing content`,
      ).toBe(true);
    }
  });

  it('keeps exactly one tracked EN/DE copy of every legal page', () => {
    const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: repoDir,
      encoding: 'utf8',
    });
    if (tracked.status !== 0) {
      throw new Error(`git ls-files failed: ${tracked.stderr}`);
    }
    const legalCopies = tracked.stdout
      .split('\n')
      .filter((path) => path.length > 0 && existsSync(resolve(repoDir, path)))
      .filter((path) =>
        /(?:^|\/)(?:terms|privacy|impressum|cookies)(?:\/de)?\/index\.html$/.test(path),
      )
      .sort();

    expect(legalCopies).toEqual(LEGAL_DOCUMENTS.map(({ repositoryPath }) => repositoryPath).sort());
  });

  it('copies the canonical tree into the generic landing image', () => {
    const dockerfile = readFileSync(resolve(repoDir, 'apps/landing/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('COPY apps/landing/site/ /usr/share/nginx/html/');
    expect(dockerfile).toContain('for route in features security roadmap; do');
    expect(dockerfile).toContain(
      'cp /usr/share/nginx/html/index.html "/usr/share/nginx/html/${route}/index.html"',
    );
  });

  it('ships the live-compatible legal chrome dependencies in the generic image', () => {
    const landingRoot = resolve(repoDir, 'apps/landing/site');
    const compatibilityStyles = readFileSync(resolve(landingRoot, 'style.css'), 'utf8');
    const icon = readFileSync(resolve(landingRoot, 'BT_AppIcon.png'));

    expect(compatibilityStyles).toContain("@import url('/styles.css');");
    for (const token of ['--text-3', '--surface-2', '--line-soft']) {
      expect(compatibilityStyles).toContain(token);
    }
    expect(icon.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    for (const document of LEGAL_DOCUMENTS) {
      const html = readFileSync(resolve(repoDir, document.repositoryPath), 'utf8');
      expect(html).toContain('href="/style.css?v=2"');
      expect(html).toContain('href="/BT_AppIcon.png"');
      expect(html).toContain('<script src="/env.js"></script>');
      expect(html).toContain('<script src="/landing.js"></script>');

      const webLinks =
        html.match(/<a\b[^>]*href="https:\/\/web\.bettertrack\.at[^"]*"[^>]*>/g) ?? [];
      expect(webLinks.length).toBeGreaterThan(0);
      for (const link of webLinks) {
        expect(link).toMatch(/\bclass="[^"]*\bjs-web-link\b[^"]*"/);
      }
      if (html.includes('/account/delete')) {
        expect(html).toContain('data-web-path="/account/delete"');
      }
    }
  });

  it.each([
    ['index.html', LEGAL_PAGES.map((page) => `href="/${page}/"`), 'aria-label="Legal"'],
    ['de.html', LEGAL_PAGES.map((page) => `href="/${page}/de/"`), 'aria-label="Rechtliches"'],
  ])('links the matching legal locale from the compact footer in %s', (file, links, label) => {
    const html = readFileSync(resolve(repoDir, 'apps/landing/site', file), 'utf8');
    for (const link of links) expect(html).toContain(link);
    expect(html.match(/<nav class="legal-links"/g)).toHaveLength(1);
    expect(html).toContain(label);
  });

  it('keeps all four links in one low-emphasis footer row', () => {
    const styles = readFileSync(resolve(repoDir, 'apps/landing/site/styles.css'), 'utf8');
    const legalLinksRule = styles.match(/\.legal-links\s*\{[^}]+\}/)?.[0] ?? '';
    expect(legalLinksRule).toContain('display: flex');
    expect(legalLinksRule).toContain('width: 100%');
    expect(legalLinksRule).toContain('font-size: 13px');
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
    expect(csp).toContain("img-src 'self' data: blob: https://api.track.example.at https:");
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

  it('permits the vault Argon2 WASM compiler without enabling inline or general eval', () => {
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://accounts.google.com");
    expect(rawPolicy).toContain('inline style attributes');
    expect(rawPolicy).toContain('hash-wasm Argon2id');

    // Keep the policy exception coupled to the actual paranoid unlock path:
    // deriveVaultKek defaults to hash-wasm rather than an injected test KDF.
    const vaultCrypto = readFileSync(resolve(repoDir, 'apps/web/src/user/vault/crypto.ts'), 'utf8');
    expect(vaultCrypto).toContain("import { argon2id } from 'hash-wasm';");
    expect(vaultCrypto).toContain('deps.argon2 ?? argon2id');
  });

  it('renders HSTS only into a deployment whose public scheme is HTTPS', () => {
    const hsts = readInfra('nginx/templates/includes/static-hsts.conf');
    expect(hsts).toContain('add_header Strict-Transport-Security "max-age=31536000" always;');
    expect(rawPolicy).not.toContain('Strict-Transport-Security');

    // Behavior, not source text: run the shipped entrypoint in both schemes.
    const secure = runWebEntrypoint(
      composeWebEnvironment({ BT_MODE: 'subdomains', BT_DOMAIN: 'bettertrack.at' }),
    );
    expect(secure.status).toBe(0);
    expect(secure.hsts).toContain(
      'add_header Strict-Transport-Security "max-age=31536000" always;',
    );

    const plain = runWebEntrypoint(
      composeWebEnvironment({ BT_MODE: 'ports', BT_DOMAIN: 'track.lan' }),
    );
    expect(plain.status).toBe(0);
    expect(plain.hsts?.trim()).toBe('');
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
      expect(html).toContain('<script src="/env.js"></script>');
      expect(html).toContain('<script src="/landing.js"></script>');
    }
  });
});

describe('landing registration status presentation', () => {
  it.each([
    {
      mode: 'closed' as const,
      ctaLabel: null,
      note: 'Registration is currently closed.',
      title: 'BetterTrack — registration closed',
      description: 'Registration is closed.',
      footer: 'Self-hosted personal finance. Registration is closed.',
    },
    {
      mode: 'invite_token' as const,
      ctaLabel: 'Register with an invite token',
      note: 'Registration requires an invite token.',
      title: 'BetterTrack — register with an invite token',
      description: 'Registration requires an invite token.',
      footer: 'Self-hosted personal finance. An invite token is required.',
    },
    {
      mode: 'approval' as const,
      ctaLabel: 'Request an account',
      note: 'Request an account, then wait for approval.',
      title: 'BetterTrack — request an account',
      description: 'Account requests are reviewed before access.',
      footer: 'Self-hosted personal finance. Account requests require approval.',
    },
    {
      mode: 'open' as const,
      ctaLabel: 'Create an account',
      note: 'Registration is open. Create an account to get started.',
      title: 'BetterTrack — create an account',
      description: 'Registration is open.',
      footer: 'Self-hosted personal finance. Registration is open.',
    },
  ])('renders an accurate $mode registration state', async (expectation) => {
    const page = await runLandingScript({ mode: expectation.mode });

    expect(page.documentElement.getAttribute('data-registration-mode')).toBe(expectation.mode);
    expect(page.webLink.getAttribute('href')).toBe('https://web.example.net');
    expect(page.webPathLink.getAttribute('href')).toBe('https://web.example.net/account/delete');
    expect(page.registrationNote.hidden).toBe(false);
    expect(page.registrationNote.textContent).toBe(expectation.note);
    expect(page.title.textContent).toBe(expectation.title);
    expect(page.description.getAttribute('content')).toBe(expectation.description);
    expect(page.footer.textContent).toBe(expectation.footer);
    expect(page.registerCta.hidden).toBe(expectation.ctaLabel === null);

    if (expectation.ctaLabel) {
      expect(page.registerCta.textContent).toBe(expectation.ctaLabel);
      expect(page.registerCta.getAttribute('href')).toBe('https://web.example.net/register');
    }
  });

  it('shows a restrained unavailable status instead of assuming registration is closed', async () => {
    const page = await runLandingScript({ fetchFailure: true });

    expect(page.documentElement.getAttribute('data-registration-mode')).toBe('unavailable');
    expect(page.registrationNote.hidden).toBe(false);
    expect(page.registrationNote.textContent).toBe('Registration status unavailable.');
    expect(page.registerCta.hidden).toBe(true);
    expect(page.title.textContent).toBe('BetterTrack — your personal investing workspace');
    expect(page.description.getAttribute('content')).toBe('Neutral registration description.');
  });

  it.each(['javascript:alert(1)', 'https://web.example.net\nwindow.pwned = true'])(
    'does not overwrite the mobile web-app link with an unsafe runtime origin (%j)',
    async (webOrigin) => {
      const page = await runLandingScript({
        includeRegistrationUi: false,
        webOrigin,
      });

      expect(page.webLink.getAttribute('href')).toBe('https://web.bettertrack.at');
      expect(page.webPathLink.getAttribute('href')).toBe(
        'https://web.bettertrack.at/account/delete',
      );
    },
  );

  it.each(['//attacker.example/delete', 'javascript:alert(1)', '/account/delete\nignored'])(
    'does not append an unsafe page path to the runtime web origin (%j)',
    async (webPath) => {
      const page = await runLandingScript({
        includeRegistrationUi: false,
        webPath,
      });

      expect(page.webPathLink.getAttribute('href')).toBe(
        'https://web.bettertrack.at/account/delete',
      );
    },
  );

  it.each([
    ['index.html', 'Registration status unavailable. Please try again later or contact the host.'],
    [
      'de.html',
      'Registrierungsstatus nicht verfügbar. Bitte versuche es später erneut oder kontaktiere den Host.',
    ],
  ])('ships complete mode copy in %s', (name, unavailableCopy) => {
    const html = readFileSync(resolve(repoDir, 'apps/landing/site', name), 'utf8');

    for (const mode of ['closed', 'invite_token', 'approval', 'open']) {
      expect(html).toContain(`data-registration-copy-${mode}=`);
    }
    for (const mode of ['invite_token', 'approval', 'open']) {
      expect(html).toContain(`data-registration-label-${mode}=`);
    }
    expect(html).toContain('js-registration-note');
    expect(html).toContain('js-register-cta');
    expect(html).toContain('data-registration-copy-unavailable=');
    expect(html).toContain(unavailableCopy);
  });

  it('stacks header controls before they can overflow on phone widths', () => {
    const styles = readFileSync(resolve(repoDir, 'apps/landing/site/styles.css'), 'utf8');

    expect(styles).toContain('@media (max-width: 480px)');
    expect(styles).toContain('flex-wrap: wrap;');
    expect(styles).toMatch(/\.header-actions\s*\{\s*width:\s*100%;/);
  });
});

describe('shipped web Compose topology → rendered browser policy', () => {
  it('passes every policy-interpolated origin variable to the front proxy', () => {
    // The CSP is rendered by THIS service at container start, so a variable the
    // policy interpolates must be in its own environment block — the api's copy
    // does not reach nginx (the round-2 landing regression, one layer over).
    const shipped = composeWebEnvironment({});
    expect(Object.keys(shipped)).toContain('BT_API_ORIGIN');
    expect(Object.keys(shipped)).toContain('BT_PRODUCT_ORIGIN');
    expect(Object.keys(shipped)).toContain('BT_GRAFANA_PUBLIC_URL');
    expect(shipped['BT_PRODUCT_ORIGIN']).toBe('');
    expect(shipped['BT_GRAFANA_PUBLIC_URL']).toBe('');
    expect(
      composeWebEnvironment({ BT_GRAFANA_PUBLIC_URL: 'https://grafana.bettertrack.at' })[
        'BT_GRAFANA_PUBLIC_URL'
      ],
    ).toBe('https://grafana.bettertrack.at');
  });

  it('renders the deployment policy and layout together with no Grafana source when unset', () => {
    const rendered = runWebEntrypoint(
      composeWebEnvironment({
        BT_MODE: 'subdomains',
        BT_DOMAIN: 'money.example.net',
        BT_SUB_API: 'gateway',
      }),
    );

    expect(rendered.status).toBe(0);
    const csp = contentSecurityPolicy(rendered.policy);
    expect(csp).toContain(
      "connect-src 'self' https://gateway.money.example.net wss://gateway.money.example.net",
    );
    expect(csp).toContain(
      "frame-src 'self' https://gateway.money.example.net https://accounts.google.com;",
    );
    // No unset variable, no separator artifact from the optional source.
    expect(csp).not.toMatch(/\$\{/);
    expect(csp).not.toContain('  ');
    expect(csp).not.toContain(' ;');
    expect(rendered.defaultConf).toContain('server_name gateway.money.example.net;');
    expect(rendered.defaultConf).toContain('productOrigin: "https://money.example.net"');
    expect(rendered.defaultConf).not.toMatch(/\$\{(BT_|API_|LANDING_|PRODUCT_|WS_|GRAFANA_)/);
  });

  it('allows exactly the configured Grafana subdomain in frame-src', () => {
    const rendered = runWebEntrypoint(
      composeWebEnvironment({
        BT_MODE: 'subdomains',
        BT_DOMAIN: 'bettertrack.at',
        BT_GRAFANA_PUBLIC_URL: 'https://grafana.bettertrack.at',
      }),
    );

    expect(rendered.status).toBe(0);
    expect(contentSecurityPolicy(rendered.policy)).toContain(
      "frame-src 'self' https://api.bettertrack.at https://accounts.google.com https://grafana.bettertrack.at;",
    );
    // Narrowed, never reopened to the whole https web.
    expect(contentSecurityPolicy(rendered.policy)).not.toMatch(/frame-src[^;]*\shttps:(?:\s|;|$)/);
  });

  it('reduces a Grafana URL with port, path, query and fragment to its origin', () => {
    const rendered = runWebEntrypoint(
      composeWebEnvironment({
        BT_MODE: 'subdomains',
        BT_DOMAIN: 'bettertrack.at',
        BT_GRAFANA_PUBLIC_URL: 'HTTPS://obs.example.com:8443/grafana/?kiosk#panel',
      }),
    );

    expect(rendered.status).toBe(0);
    expect(contentSecurityPolicy(rendered.policy)).toContain(
      "frame-src 'self' https://api.bettertrack.at https://accounts.google.com https://obs.example.com:8443;",
    );
  });

  it('derives ports-mode sources for API assets, sockets, and plain-HTTP Grafana', () => {
    const rendered = runWebEntrypoint(
      composeWebEnvironment({
        BT_MODE: 'ports',
        BT_DOMAIN: 'track.lan',
        BT_PORT_API: '4300',
        BT_GRAFANA_PUBLIC_URL: 'http://track.lan:3001/grafana',
      }),
    );

    expect(rendered.status).toBe(0);
    const csp = contentSecurityPolicy(rendered.policy);
    // ConsentPage turns a non-null logoPath into this cross-port API asset URL.
    // Its origin must be an explicit img-src because the web port is not 'self'.
    const oauthLogoUrl = 'http://track.lan:4300/api/v1/oauth/client-logos/btc_charting_buddy';
    expect(csp).toContain(`img-src 'self' data: blob: ${new URL(oauthLogoUrl).origin} https:`);
    expect(csp).toContain("connect-src 'self' http://track.lan:4300 ws://track.lan:4300");
    expect(csp).toContain(
      "frame-src 'self' http://track.lan:4300 https://accounts.google.com http://track.lan:3001;",
    );
    expect(rendered.defaultConf).toContain('productOrigin: "http://track.lan:8082"');
  });

  it('honors and normalizes the explicit product origin passed through Compose', () => {
    const rendered = runWebEntrypoint(
      composeWebEnvironment({
        BT_MODE: 'subdomains',
        BT_DOMAIN: 'internal.example.net',
        BT_PRODUCT_ORIGIN: 'HTTPS://PUBLIC.Example.NET/',
      }),
    );

    expect(rendered.status).toBe(0);
    expect(rendered.defaultConf).toContain('productOrigin: "https://PUBLIC.Example.NET"');
  });

  it.each([
    [
      'HTTPS://public-api.example.net/',
      'https://public-api.example.net',
      'wss://public-api.example.net',
    ],
    [
      'hTtP://public-api.example.net:4300/',
      'http://public-api.example.net:4300',
      'ws://public-api.example.net:4300',
    ],
  ])(
    'normalizes an explicit API origin scheme (%s) before deriving browser sources',
    (override, apiOrigin, wsOrigin) => {
      const rendered = runWebEntrypoint(
        composeWebEnvironment({
          BT_MODE: 'subdomains',
          BT_DOMAIN: 'internal.example.net',
          BT_API_ORIGIN: override,
        }),
      );

      expect(rendered.status).toBe(0);
      const csp = contentSecurityPolicy(rendered.policy);
      expect(csp).toContain(`connect-src 'self' ${apiOrigin} ${wsOrigin}`);
      expect(csp).toContain(`frame-src 'self' ${apiOrigin} `);
      expect(rendered.defaultConf).toContain(`apiOrigin: "${apiOrigin}"`);
    },
  );

  it.each(['', '   '])(
    'treats a blank Grafana public URL (%j) as unset, exactly like the api config does',
    (blank) => {
      const rendered = runWebEntrypoint(
        composeWebEnvironment({
          BT_MODE: 'subdomains',
          BT_DOMAIN: 'bettertrack.at',
          BT_GRAFANA_PUBLIC_URL: blank,
        }),
      );

      expect(rendered.status).toBe(0);
      expect(contentSecurityPolicy(rendered.policy)).toContain(
        "frame-src 'self' https://api.bettertrack.at https://accounts.google.com;",
      );
    },
  );

  it.each([
    'grafana.bettertrack.at',
    'javascript:alert(1)',
    'data:text/html,<iframe src="x">',
    'https://grafana.bettertrack.at; script-src *',
    'https://grafana.bettertrack.at" always; add_header X-Injected "1',
    'https://grafana bettertrack.at',
    'https://user:secret@grafana.bettertrack.at',
    'https://*.bettertrack.at',
    'https://grafana.bettertrack.at\n; script-src *',
  ])('refuses to boot on a Grafana public URL that could corrupt the policy (%j)', (value) => {
    const rendered = runWebEntrypoint(
      composeWebEnvironment({
        BT_MODE: 'subdomains',
        BT_DOMAIN: 'bettertrack.at',
        BT_GRAFANA_PUBLIC_URL: value,
      }),
    );

    expect(rendered.status).not.toBe(0);
    expect(rendered.stderr).toContain('BT_GRAFANA_PUBLIC_URL');
    // Nothing rendered at all: a bad value never reaches a header.
    expect(rendered.policy).toBeNull();
    expect(rendered.defaultConf).toBeNull();
  });
});

describe('shipped landing Compose topology', () => {
  it('keeps the committed development artifact equal to the generated default', () => {
    const rendered = renderLandingEntrypoint({
      BT_MODE: 'subdomains',
      BT_DOMAIN: 'bettertrack.at',
    });

    expect(rendered).toBe(readFileSync(resolve(repoDir, 'apps/landing/site/env.js'), 'utf8'));
  });

  it('derives custom subdomain origins that match the front proxy CSP', () => {
    const rendered = renderLandingEntrypoint(
      composeLandingEnvironment({
        BT_MODE: 'subdomains',
        BT_DOMAIN: 'money.example.net',
        BT_SUB_API: 'gateway',
        BT_SUB_WEB: 'app',
      }),
    );

    expect(landingRuntimeConfig(rendered)).toEqual({
      webOrigin: 'https://app.money.example.net',
      apiOrigin: 'https://gateway.money.example.net',
    });
    expect(rendered).not.toContain('${BT_WEB_ORIGIN}');
    expect(rendered).not.toContain('${BT_API_ORIGIN}');
  });

  it('derives plain-HTTP loopback ports origins from the shipped Compose environment', () => {
    const rendered = renderLandingEntrypoint(
      composeLandingEnvironment({
        BT_MODE: 'ports',
        BT_DOMAIN: 'localhost',
        BT_PORT_API: '4300',
        BT_PORT_WEB: '4800',
      }),
    );

    expect(landingRuntimeConfig(rendered)).toEqual({
      webOrigin: 'http://localhost:4800',
      apiOrigin: 'http://localhost:4300',
    });
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

    expect(landingRuntimeConfig(rendered)).toEqual({
      webOrigin: 'https://public-app.example.net',
      apiOrigin: 'https://public-api.example.net',
    });
  });

  it('normalizes URL syntax before writing executable landing configuration', () => {
    const rendered = renderLandingEntrypoint({
      BT_MODE: 'subdomains',
      BT_DOMAIN: 'internal.example.net',
      BT_API_ORIGIN: 'HTTPS://PUBLIC-API.Example.NET/',
      BT_WEB_ORIGIN: 'HTTPS://PUBLIC-APP.Example.NET/',
    });

    expect(landingRuntimeConfig(rendered)).toEqual({
      webOrigin: 'https://public-app.example.net',
      apiOrigin: 'https://public-api.example.net',
    });
  });

  it.each([
    ['BT_WEB_ORIGIN', 'javascript:alert(1)'],
    ['BT_WEB_ORIGIN', 'http://web.example.net'],
    ['BT_WEB_ORIGIN', 'https://web.example.net/path'],
    ['BT_WEB_ORIGIN', 'https://user:secret@web.example.net'],
    ['BT_API_ORIGIN', 'https://api.example.net\nwindow.pwned = true'],
  ])('refuses an unsafe configured origin (%s = %j)', (name, value) => {
    const rendered = runLandingEntrypoint({
      BT_MODE: 'subdomains',
      BT_DOMAIN: 'internal.example.net',
      BT_WEB_ORIGIN: name === 'BT_WEB_ORIGIN' ? value : 'https://web.example.net',
      BT_API_ORIGIN: name === 'BT_API_ORIGIN' ? value : 'https://api.example.net',
    });

    expect(rendered.status).not.toBe(0);
    expect(rendered.stderr).toContain(name);
    expect(rendered.config).toBeNull();
  });
});
