import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestHarness } from '../../../testing/createTestApp';

/**
 * CORS + cookie behaviour end-to-end (PROJECTPLAN.md §10). The harness derives
 * web/admin/api origins from BT_*_ORIGIN, so these assertions exercise the same
 * derivation the app runs in production. Covers both a ports-style layout (the
 * harness default) and a subdomains-style layout.
 */

const XRW = ['X-Requested-With', 'BetterTrack'] as const;
const WEB = 'http://localhost:5173';
const ADMIN = 'http://localhost:5174';

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestApp();
});

describe('CORS allowlist', () => {
  it('reflects an allowed web origin with credentials on a simple request', async () => {
    const res = await request(harness.app).get('/api/v1/health').set('Origin', WEB);
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['vary']).toContain('Origin');
  });

  it('reflects the admin origin too', async () => {
    const res = await request(harness.app).get('/api/v1/health').set('Origin', ADMIN);
    expect(res.headers['access-control-allow-origin']).toBe(ADMIN);
  });

  it('sends no ACAO header for a disallowed origin', async () => {
    const res = await request(harness.app)
      .get('/api/v1/health')
      .set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // Still varies on Origin so caches never leak another origin's header.
    expect(res.headers['vary']).toContain('Origin');
  });

  it('answers a preflight from an allowed origin with 204 + allow-* headers', async () => {
    const res = await request(harness.app)
      .options('/api/v1/auth/login')
      .set('Origin', WEB)
      .set('Access-Control-Request-Method', 'POST');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-headers']).toContain('X-Requested-With');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('strict Origin check on state-changing requests', () => {
  it('rejects a mutation carrying a disallowed Origin even with the CSRF header', async () => {
    const admin = await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', 'https://evil.example')
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('allows a mutation from an allowed origin', async () => {
    const admin = await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', WEB)
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(200);
  });
});

describe('credentialed login sets a Lax session cookie', () => {
  it('flows cross-origin in ports mode', async () => {
    const admin = await harness.seedAdmin();
    const res = await request(harness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', WEB)
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/bt_sid=/);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // Plain-http ports layout → not Secure, so the browser accepts the cookie.
    expect(cookie).not.toMatch(/Secure/i);
  });

  it('marks the cookie Secure in an https subdomains layout', async () => {
    const httpsHarness = await createTestApp({
      env: {
        BT_API_ORIGIN: 'https://api.example.at',
        BT_WEB_ORIGIN: 'https://web.example.at',
        BT_ADMIN_ORIGIN: 'https://admin.example.at',
      },
    });
    const admin = await httpsHarness.seedAdmin();
    const res = await request(httpsHarness.app)
      .post('/api/v1/auth/login')
      .set(...XRW)
      .set('Origin', 'https://web.example.at')
      .send({ identifier: admin.email, password: admin.password });
    expect(res.status).toBe(200);
    const cookie = res.headers['set-cookie']?.[0] ?? '';
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Secure/i);
    expect(res.headers['access-control-allow-origin']).toBe('https://web.example.at');
  });
});
