import { describe, expect, it } from 'vitest';

import { loadConfig } from '../env';

/**
 * Topology & derived-origin coverage (PROJECTPLAN.md §4.6, §10, §11). Proves the
 * single env scheme derives all five origins (api/web/admin + the static product
 * apex / mobile. landing pages) for both deployment modes plus explicit
 * overrides, and that CORS/cookie attributes fall out of those origins with no
 * hardcoded values — and that the credential-free product/mobile origins never
 * enter the CORS allowlist.
 */

const REQUIRED: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://x',
  REDIS_URL: 'redis://x',
  SESSION_SECRET: 'a-sufficiently-long-secret-value',
};

function config(env: NodeJS.ProcessEnv) {
  return loadConfig({ ...REQUIRED, ...env });
}

describe('subdomains mode', () => {
  it('derives https api/web/admin subdomains of BT_DOMAIN by default', () => {
    const c = config({ BT_MODE: 'subdomains', BT_DOMAIN: 'track.example.at' });
    expect(c.topology).toMatchObject({
      mode: 'subdomains',
      tls: true,
      apiOrigin: 'https://api.track.example.at',
      webOrigin: 'https://web.track.example.at',
      adminOrigin: 'https://admin.track.example.at',
    });
  });

  it('honours configurable subdomain names', () => {
    const c = config({
      BT_MODE: 'subdomains',
      BT_DOMAIN: 'example.com',
      BT_SUB_API: 'gateway',
      BT_SUB_WEB: 'app',
      BT_SUB_ADMIN: 'ops',
    });
    expect(c.topology.apiOrigin).toBe('https://gateway.example.com');
    expect(c.topology.webOrigin).toBe('https://app.example.com');
    expect(c.topology.adminOrigin).toBe('https://ops.example.com');
  });

  it('can be forced to http via BT_TLS=false', () => {
    const c = config({ BT_MODE: 'subdomains', BT_DOMAIN: 'lan.local', BT_TLS: 'false' });
    expect(c.topology.tls).toBe(false);
    expect(c.topology.apiOrigin).toBe('http://api.lan.local');
    expect(c.cookie.secure).toBe(false);
  });

  it('serves the product landing from the apex and mobile from its subdomain', () => {
    const c = config({ BT_MODE: 'subdomains', BT_DOMAIN: 'track.example.at' });
    // Product lives at the APEX — no subdomain label.
    expect(c.topology.productOrigin).toBe('https://track.example.at');
    expect(c.topology.mobileOrigin).toBe('https://mobile.track.example.at');
  });

  it('honours a configurable mobile subdomain label', () => {
    const c = config({ BT_MODE: 'subdomains', BT_DOMAIN: 'example.com', BT_SUB_MOBILE: 'm' });
    expect(c.topology.mobileOrigin).toBe('https://m.example.com');
    // The apex product origin never carries a subdomain regardless.
    expect(c.topology.productOrigin).toBe('https://example.com');
  });
});

describe('ports mode', () => {
  it('derives http host:port origins by default', () => {
    const c = config({ BT_MODE: 'ports', BT_DOMAIN: 'localhost' });
    expect(c.topology).toMatchObject({
      mode: 'ports',
      tls: false,
      apiOrigin: 'http://localhost:3000',
      webOrigin: 'http://localhost:8080',
      adminOrigin: 'http://localhost:8081',
    });
  });

  it('honours configurable ports', () => {
    const c = config({
      BT_MODE: 'ports',
      BT_DOMAIN: 'box.internal',
      BT_PORT_API: '4000',
      BT_PORT_WEB: '4001',
      BT_PORT_ADMIN: '4002',
    });
    expect(c.topology.apiOrigin).toBe('http://box.internal:4000');
    expect(c.topology.webOrigin).toBe('http://box.internal:4001');
    expect(c.topology.adminOrigin).toBe('http://box.internal:4002');
  });

  it('can be forced to https via BT_TLS=true', () => {
    const c = config({ BT_MODE: 'ports', BT_DOMAIN: 'secure.host', BT_TLS: 'true' });
    expect(c.topology.apiOrigin).toBe('https://secure.host:3000');
    expect(c.cookie.secure).toBe(true);
  });

  it('gives product/mobile their own symmetric ports', () => {
    const c = config({ BT_MODE: 'ports', BT_DOMAIN: 'localhost' });
    expect(c.topology.productOrigin).toBe('http://localhost:8082');
    expect(c.topology.mobileOrigin).toBe('http://localhost:8083');
  });

  it('honours configurable product/mobile ports', () => {
    const c = config({
      BT_MODE: 'ports',
      BT_DOMAIN: 'box.internal',
      BT_PORT_PRODUCT: '9090',
      BT_PORT_MOBILE: '9091',
    });
    expect(c.topology.productOrigin).toBe('http://box.internal:9090');
    expect(c.topology.mobileOrigin).toBe('http://box.internal:9091');
  });
});

describe('explicit overrides win over derivation', () => {
  it('applies BT_*_ORIGIN and strips a trailing slash', () => {
    const c = config({
      BT_MODE: 'subdomains',
      BT_DOMAIN: 'ignored.example',
      BT_API_ORIGIN: 'https://api.custom.io/',
      BT_WEB_ORIGIN: 'https://custom.io',
      BT_ADMIN_ORIGIN: 'https://admin.custom.io',
    });
    expect(c.topology.apiOrigin).toBe('https://api.custom.io');
    expect(c.topology.webOrigin).toBe('https://custom.io');
    expect(c.topology.adminOrigin).toBe('https://admin.custom.io');
  });

  it('applies BT_PRODUCT_ORIGIN / BT_MOBILE_ORIGIN and strips a trailing slash', () => {
    const c = config({
      BT_MODE: 'subdomains',
      BT_DOMAIN: 'ignored.example',
      BT_PRODUCT_ORIGIN: 'https://bettertrack.at/',
      BT_MOBILE_ORIGIN: 'https://m.bettertrack.at',
    });
    expect(c.topology.productOrigin).toBe('https://bettertrack.at');
    expect(c.topology.mobileOrigin).toBe('https://m.bettertrack.at');
  });

  it('treats APP_ORIGIN as a legacy alias for the web origin', () => {
    const c = config({
      BT_MODE: 'ports',
      BT_DOMAIN: 'localhost',
      APP_ORIGIN: 'http://localhost:5173',
    });
    expect(c.topology.webOrigin).toBe('http://localhost:5173');
    expect(c.appOrigin).toBe('http://localhost:5173');
    // The API origin is still derived — only the web override was supplied.
    expect(c.topology.apiOrigin).toBe('http://localhost:3000');
  });
});

describe('CORS & cookie derivation', () => {
  it('builds the CORS allowlist from web + admin origins only', () => {
    const c = config({ BT_MODE: 'subdomains', BT_DOMAIN: 'example.at' });
    expect(c.corsOrigins).toEqual(['https://web.example.at', 'https://admin.example.at']);
    // The API origin is never in the allowlist (it is not a cross-origin caller).
    expect(c.corsOrigins).not.toContain(c.topology.apiOrigin);
  });

  it('never admits the static product/mobile origins to the credentialed allowlist', () => {
    // Static landing pages carry no cookies and never call the API — admitting
    // them would only widen the credentialed surface (§4.6). True in both modes.
    for (const mode of ['subdomains', 'ports'] as const) {
      const c = config({ BT_MODE: mode, BT_DOMAIN: 'example.at' });
      expect(c.corsOrigins).not.toContain(c.topology.productOrigin);
      expect(c.corsOrigins).not.toContain(c.topology.mobileOrigin);
    }
  });

  it('derives cookie.secure from the API origin scheme, not NODE_ENV', () => {
    const https = config({ BT_MODE: 'subdomains', BT_DOMAIN: 'example.at' });
    expect(https.cookie.secure).toBe(true);

    const http = config({ NODE_ENV: 'production', BT_MODE: 'ports', BT_DOMAIN: 'localhost' });
    expect(http.cookie.secure).toBe(false);

    expect(https.cookie.sameSite).toBe('lax');
    // Host-only cookie: no Domain attribute so it is not needlessly widened.
    expect(https.cookie.domain).toBeUndefined();
  });
});

describe('realtime flag (§4.5, V3-P7a)', () => {
  it('defaults to enabled', () => {
    expect(config({}).realtime.enabled).toBe(true);
  });

  it('REALTIME_ENABLED=false disables the gateway', () => {
    expect(config({ REALTIME_ENABLED: 'false' }).realtime.enabled).toBe(false);
    expect(config({ REALTIME_ENABLED: '0' }).realtime.enabled).toBe(false);
  });

  it('truthy spellings enable it explicitly', () => {
    expect(config({ REALTIME_ENABLED: 'true' }).realtime.enabled).toBe(true);
    expect(config({ REALTIME_ENABLED: '1' }).realtime.enabled).toBe(true);
  });
});

describe('web-push VAPID config (#368)', () => {
  it('keys-only config enables the channel with the mailto subject derived from BT_DOMAIN', () => {
    const c = config({
      BT_DOMAIN: 'track.example.at',
      BT_VAPID_PUBLIC_KEY: 'pub',
      BT_VAPID_PRIVATE_KEY: 'priv',
    });
    expect(c.webPush.enabled).toBe(true);
    expect(c.webPush.subject).toBe('mailto:admin@track.example.at');
  });

  it('an EMPTY BT_VAPID_SUBJECT (the compose default for an unset var) still derives the mailto subject', () => {
    // infra/docker-compose.yml injects BT_VAPID_SUBJECT='' when unset; an empty
    // subject makes web-push throw at setVapidDetails and kills the channel.
    const c = config({
      BT_DOMAIN: 'track.example.at',
      BT_VAPID_PUBLIC_KEY: 'pub',
      BT_VAPID_PRIVATE_KEY: 'priv',
      BT_VAPID_SUBJECT: '',
    });
    expect(c.webPush.enabled).toBe(true);
    expect(c.webPush.subject).toBe('mailto:admin@track.example.at');
  });

  it('an explicit subject wins; empty/missing keys keep the channel disabled', () => {
    const explicit = config({
      BT_VAPID_PUBLIC_KEY: 'pub',
      BT_VAPID_PRIVATE_KEY: 'priv',
      BT_VAPID_SUBJECT: 'mailto:ops@bettertrack.at',
    });
    expect(explicit.webPush.subject).toBe('mailto:ops@bettertrack.at');

    expect(config({}).webPush.enabled).toBe(false);
    // Compose's empty-string defaults must read as "not configured" too.
    expect(config({ BT_VAPID_PUBLIC_KEY: '', BT_VAPID_PRIVATE_KEY: '' }).webPush.enabled).toBe(
      false,
    );
  });
});
