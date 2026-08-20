import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../../services/crypto/secretBox';
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
  BT_DATA_ENCRYPTION_KEY_ID: 'test-current',
  BT_DATA_ENCRYPTION_KEY: 'test-record-encryption-material-at-least-32-characters',
};

function config(env: NodeJS.ProcessEnv) {
  return loadConfig({ ...REQUIRED, ...env });
}

describe('production session-secret safety', () => {
  it.each([
    'CHANGE_ME_64_RANDOM_HEX_BYTES',
    '<strong password>',
    '<openssl rand -hex 64>',
    'CHANGE_ME_64_RANDOM_HEX_BYTES_PLEASE',
  ])('rejects a published production placeholder instead of accepting it by length', (secret) => {
    expect(() => config({ SESSION_SECRET: secret })).toThrow(
      'SESSION_SECRET: replace the example placeholder before production',
    );
  });

  it('rejects a known placeholder anywhere in a production rotation list', () => {
    expect(() =>
      config({
        SESSION_SECRET: 'a-new-random-session-secret-value,change-me-to-64-random-bytes',
      }),
    ).toThrow('SESSION_SECRET: replace the example placeholder before production');
  });

  it('keeps non-production example configuration permissive', () => {
    const parsed = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      SESSION_SECRET: 'change-me-to-64-random-bytes',
    });
    expect(parsed.sessionSecrets).toEqual(['change-me-to-64-random-bytes']);
  });
});

describe('vault rate-limit configuration', () => {
  it('keeps read and write budgets independent while sharing the configured window', () => {
    const c = config({
      BT_VAULT_RATE_WINDOW_SEC: '17',
      BT_VAULT_RATE_LIMIT: '3',
      BT_VAULT_READ_RATE_LIMIT: '31',
    });

    expect(c.rateLimits.vault).toMatchObject({ windowSec: 17, limit: 3 });
    expect(c.rateLimits.vaultRead).toMatchObject({ windowSec: 17, limit: 31 });
  });

  it('gives reads a larger default budget without changing the write default', () => {
    const c = config({});

    expect(c.rateLimits.vault.limit).toBe(60);
    expect(c.rateLimits.vaultRead.limit).toBe(600);
  });
});

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

describe('market-intelligence gate (§13.5 V5-P5)', () => {
  it('defaults to enabled (Yahoo is keyless)', () => {
    expect(config({}).marketIntel.enabled).toBe(true);
  });

  it('MARKET_INTEL_ENABLED=false hides the whole arc', () => {
    expect(config({ MARKET_INTEL_ENABLED: 'false' }).marketIntel.enabled).toBe(false);
    expect(config({ MARKET_INTEL_ENABLED: '0' }).marketIntel.enabled).toBe(false);
  });

  it('truthy spellings enable it explicitly', () => {
    expect(config({ MARKET_INTEL_ENABLED: 'true' }).marketIntel.enabled).toBe(true);
    expect(config({ MARKET_INTEL_ENABLED: '1' }).marketIntel.enabled).toBe(true);
  });
});

describe('operational data retention (§13.5 V5-P14, PL-01)', () => {
  it('uses conservative defaults when the owner leaves the variables unset or blank', () => {
    expect(config({}).retention).toEqual({ auditDays: 400, emailLogDays: 180 });
    expect(
      config({ BT_AUDIT_RETENTION_DAYS: '', BT_EMAIL_LOG_RETENTION_DAYS: '   ' }).retention,
    ).toEqual({ auditDays: 400, emailLogDays: 180 });
  });

  it('accepts owner-adjusted whole-day windows and explicit zero as retain forever', () => {
    expect(
      config({ BT_AUDIT_RETENTION_DAYS: '730', BT_EMAIL_LOG_RETENTION_DAYS: '0' }).retention,
    ).toEqual({ auditDays: 730, emailLogDays: 0 });
  });

  it('rejects negative and fractional retention windows', () => {
    expect(() => config({ BT_AUDIT_RETENTION_DAYS: '-1' })).toThrow();
    expect(() => config({ BT_EMAIL_LOG_RETENTION_DAYS: '30.5' })).toThrow();
  });
});

describe('observability grafana public URL (#632)', () => {
  it('an EMPTY BT_GRAFANA_PUBLIC_URL (the compose default for an unset var) reads as unset, not a crash', () => {
    // infra/docker-compose.yml injects BT_GRAFANA_PUBLIC_URL='' when the var is
    // unset; `.optional()` alone would push that empty string into `.url()` and
    // crash boot — the whole api container failed to start on the live box.
    const c = config({ BT_GRAFANA_PUBLIC_URL: '' });
    expect(c.observability.grafanaPublicUrl).toBeUndefined();
  });

  it('whitespace-only reads as unset too', () => {
    expect(config({ BT_GRAFANA_PUBLIC_URL: '   ' }).observability.grafanaPublicUrl).toBeUndefined();
  });

  it('a real URL is accepted and trailing-slash-stripped', () => {
    const c = config({ BT_GRAFANA_PUBLIC_URL: 'https://grafana.bettertrack.at/' });
    expect(c.observability.grafanaPublicUrl).toBe('https://grafana.bettertrack.at');
  });

  it('a non-empty but invalid URL still fails loudly', () => {
    expect(() => config({ BT_GRAFANA_PUBLIC_URL: 'not-a-url' })).toThrow();
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

describe('stored-record encryption configuration (#879)', () => {
  it('requires a dedicated active key and id in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        SESSION_SECRET: 'a-sufficiently-long-secret-value',
      }),
    ).toThrow('dedicated record-encryption configuration is required in production');

    expect(() =>
      config({
        BT_DATA_ENCRYPTION_KEY_ID: 'only-an-id',
        BT_DATA_ENCRYPTION_KEY: '',
      }),
    ).toThrow('set both fields together');
  });

  it('uses a session-independent fixed fallback in development and test', () => {
    const first = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      SESSION_SECRET: 'old-cookie-secret-value',
    });
    const rotated = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      SESSION_SECRET: 'new-cookie-secret-value,old-cookie-secret-value',
    });

    expect(rotated.recordEncryption.active.id).toBe(first.recordEncryption.active.id);
    expect(rotated.recordEncryption.active.key.equals(first.recordEncryption.active.key)).toBe(
      true,
    );
  });

  it('keeps a legacy session-derived envelope readable across cookie rotation', () => {
    const oldCookieSecret = 'old-cookie-secret-value';
    const historicalKey = createHash('sha256').update(`bt-2fa:${oldCookieSecret}`).digest();
    const legacy = encryptSecret('legacy TOTP seed', historicalKey);
    const rotated = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      SESSION_SECRET: `new-cookie-secret-value,${oldCookieSecret}`,
    });

    expect(decryptSecret(legacy, rotated.recordEncryption)).toBe('legacy TOTP seed');
  });

  it('keeps a legacy raw rotation-list envelope readable when another key is prepended', () => {
    const historicalSessionSecret = 'new-cookie-secret-value,old-cookie-secret-value';
    const historicalKey = createHash('sha256').update(`bt-2fa:${historicalSessionSecret}`).digest();
    const legacy = encryptSecret('legacy multi-key TOTP seed', historicalKey);
    const rotated = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      SESSION_SECRET: `newest-cookie-secret-value,${historicalSessionSecret}`,
    });

    expect(decryptSecret(legacy, rotated.recordEncryption)).toBe('legacy multi-key TOTP seed');
  });

  it('reads a previous data key while writing only the configured active id', () => {
    const oldMaterial = 'old-record-encryption-material-at-least-32-characters';
    const oldConfig = config({
      BT_DATA_ENCRYPTION_KEY_ID: 'old_2025',
      BT_DATA_ENCRYPTION_KEY: oldMaterial,
    });
    const oldEnvelope = encryptSecret('rotating secret', oldConfig.recordEncryption);

    const rotated = config({
      BT_DATA_ENCRYPTION_KEY_ID: 'new_2026',
      BT_DATA_ENCRYPTION_KEY: 'new-record-encryption-material-at-least-32-characters',
      BT_DATA_ENCRYPTION_DECRYPT_KEYS: `old_2025=${oldMaterial}`,
    });
    expect(decryptSecret(oldEnvelope, rotated.recordEncryption)).toBe('rotating secret');

    const newEnvelope = encryptSecret('new secret', rotated.recordEncryption);
    expect(newEnvelope.startsWith('v2.new_2026.')).toBe(true);
  });

  it('rejects malformed or duplicate decrypt-key entries without echoing key material', () => {
    const secret = 'sensitive-previous-key-material-at-least-32-characters';
    for (const decryptKeys of [
      'missing-separator',
      `test-current=${secret}`,
      `same=${secret},same=${secret}`,
    ]) {
      try {
        config({ BT_DATA_ENCRYPTION_DECRYPT_KEYS: decryptKeys });
        throw new Error('expected config to fail');
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});

describe('empty variables', () => {
  // Docker Compose renders `'${FOO:-}'` as FOO='' for every optional setting
  // nobody filled in, and zod's .optional() rejects '' — so a fresh box with no
  // product site, no mobile origin and no SMTP server refused to boot at all.
  it('treats an empty optional variable as unset, not as a bad value', () => {
    const parsed = config({
      BT_MODE: 'subdomains',
      BT_DOMAIN: 'example.test',
      BT_PRODUCT_ORIGIN: '',
      BT_MOBILE_ORIGIN: '',
      SMTP_HOST: '',
      SMTP_PORT: '',
    });

    // Derived from the mode rather than inherited from the empty string.
    expect(parsed.topology.productOrigin).toBe('https://example.test');
  });

  it('still rejects an empty REQUIRED variable', () => {
    expect(() => config({ SESSION_SECRET: '' })).toThrow(/SESSION_SECRET/);
  });
});
