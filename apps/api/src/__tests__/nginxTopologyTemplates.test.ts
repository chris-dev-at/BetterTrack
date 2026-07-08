import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
 * hand-edited nginx, and that the existing api/web/admin blocks are untouched.
 */

const infraDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../infra');

function template(mode: 'subdomains' | 'ports'): string {
  return readFileSync(resolve(infraDir, `nginx/templates/${mode}.conf.template`), 'utf8');
}

/** Mirror the entrypoint's restricted envsubst: replace only `${NAME}` for NAME in env. */
function render(raw: string, env: Record<string, string>): string {
  return raw.replace(/\$\{(\w+)\}/g, (match, name: string) => env[name] ?? match);
}

const SUBDOMAINS_ENV: Record<string, string> = {
  BT_DOMAIN: 'track.example.at',
  BT_SUB_API: 'api',
  BT_SUB_WEB: 'web',
  BT_SUB_ADMIN: 'admin',
  BT_SUB_MOBILE: 'mobile',
  API_UPSTREAM: 'api:3000',
  LANDING_UPSTREAM: 'landing:80',
  API_ORIGIN: 'https://api.track.example.at',
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

  it('substitutes every whitelisted var (no ${BT_/LANDING/API_ORIGIN} left)', () => {
    expect(out).not.toMatch(/\$\{(BT_|LANDING_UPSTREAM|API_UPSTREAM|API_ORIGIN)/);
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
    expect(out).not.toMatch(/\$\{(BT_|LANDING_UPSTREAM|API_UPSTREAM|API_ORIGIN)/);
  });
});
